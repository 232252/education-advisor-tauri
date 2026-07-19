// =============================================================
// Sidecar 进程管理 + JSON-RPC over stdio 多路复用
//
// 协议 (newline-delimited JSON):
//   Rust → sidecar (stdin):   {"id":N,"type":"invoke","channel":"...","args":[...]}
//   sidecar → Rust (stdout):  {"id":N,"type":"result","ok":true,"data":...}
//                             {"id":N,"type":"result","ok":false,"error":"..."}
//                             {"type":"event","channel":"...","data":...}   (异步推送)
//                             {"type":"sys","request":"openExternal"|"showInFolder"|"dialog"|"getPath","args":...}
//                             (sys 请求由 Rust 处理后回写 {"id":N,"type":"sys-result","data":...})
// =============================================================

use crate::sys_bridge;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

/// BufReader 缓冲区大小: 64KB (默认 8KB 太小, 高并发下频繁分配)
const READER_CAPACITY: usize = 64 * 1024;
use tauri::{AppHandle, Emitter};

type Pending = Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<RpcResult>>>>;

/// L-11 修复: 从 poisoned mutex 中恢复,避免单线程 panic 导致整个通信系统瘫痪。
/// poison 后数据仍可用(只是逻辑上不一致),继续操作比直接失败更安全。
fn lock_pending(pending: &Pending) -> std::sync::MutexGuard<'_, HashMap<u64, std::sync::mpsc::Sender<RpcResult>>> {
    pending.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug)]
enum RpcResult {
    Ok(Value),
    Err(String),
}

/// 从 sidecar stdout 读到的一行消息
#[derive(Debug, Deserialize, Serialize)]
struct WireMessage {
    #[serde(default)]
    id: Option<u64>,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    level: Option<String>,
    // sys round-trip 请求
    #[serde(default)]
    request: Option<String>,
    #[serde(default)]
    args: Option<Value>,
}

/// Parameters needed to re-spawn the sidecar (used by watchdog)
struct SpawnConfig {
    script: String,
    app_data_dir: String,
    resource_dir: String,
}

pub struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    /// M-7-6 修复: shutdown 幂等标志,防止重复调用导致额外延迟和重复 kill
    shutdown_done: AtomicBool,
    /// Spawn parameters kept for watchdog respawn
    spawn_config: SpawnConfig,
    /// AppHandle for re-starting the stdout reader thread on respawn
    app_handle: AppHandle,
    /// Timestamps (Instant) of recent respawns, used for rate-limiting
    respawn_timestamps: Mutex<Vec<std::time::Instant>>,
}

impl SidecarHandle {
    /// 启动 Node sidecar 子进程，并开始读取它的 stdout
    pub fn spawn(
        script: &str,
        app_data_dir: &str,
        resource_dir: &str,
        app: AppHandle,
    ) -> Result<Self, String> {
        // 找 node 可执行文件
        let node = which_node()?;

        let mut cmd = Command::new(node);
        cmd.arg(script);
        cmd.env("EDU_APP_DATA_DIR", app_data_dir);
        cmd.env("EDU_RESOURCE_DIR", resource_dir);
        cmd.env("EDU_IS_PACKAGED", if is_packaged() { "1" } else { "0" });
        // 透传部分对 sidecar 有用的环境变量
        if let Ok(v) = std::env::var("DEBUG") {
            cmd.env("DEBUG", v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = cmd.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "no sidecar stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "no sidecar stdout".to_string())?;

        // 预分配 64 槽位以减少高并发下的 rehash
let pending: Pending = Arc::new(Mutex::new(HashMap::with_capacity(64)));
        let pending_reader = pending.clone();
        let app_reader = app.clone();

        // 读 stdout 的线程
        std::thread::spawn(move || {
            let reader = BufReader::with_capacity(READER_CAPACITY, stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<WireMessage>(&text) {
                            Ok(msg) => handle_wire_message(msg, &pending_reader, &app_reader),
                            Err(e) => {
                                // sidecar 启动早期或未捕获的库可能打印纯文本到 stdout。
                                // 不是致命错误 — 当作普通日志行转发到 stderr。
                                eprintln!("[sidecar:txt] {text}   (note: non-JSON, {e})");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[sidecar-stdout] read error: {e}");
                        break;
                    }
                }
            }
            eprintln!("[sidecar-stdout] reader thread exiting");
        });

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending,
            next_id: AtomicU64::new(1),
            shutdown_done: AtomicBool::new(false),
            spawn_config: SpawnConfig {
                script: script.to_string(),
                app_data_dir: app_data_dir.to_string(),
                resource_dir: resource_dir.to_string(),
            },
            app_handle: app,
            respawn_timestamps: Mutex::new(Vec::new()),
        })
    }

    /// 同步发起一次 invoke，等待 sidecar 返回结果
    /// M-TAURI-7 修复: 超时可通过 EDU_SIDECAR_TIMEOUT_SECS 环境变量配置,默认 300s
    pub fn request(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel::<RpcResult>();

        // 注册 pending
        {
            let mut p = lock_pending(&self.pending);
            p.insert(id, tx);
        }

        let payload = serde_json::json!({
            "id": id,
            "type": "invoke",
            "channel": channel,
            "args": args,
        });
        // M-7-1 修复: write_line 失败时清理 pending 条目,防止内存泄漏
        if let Err(e) = self.write_line(&payload) {
            lock_pending(&self.pending).remove(&id);
            return Err(e);
        }

        // M-TAURI-7: 超时可通过环境变量配置,默认 300s(覆盖 LLM 长对话 / ollama 拉模型)
        let timeout_secs = std::env::var("EDU_SIDECAR_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(300);
        let timeout_msg = format!("sidecar invoke timeout ({}s)", timeout_secs);
        match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
            Ok(RpcResult::Ok(v)) => Ok(v),
            Ok(RpcResult::Err(e)) => Err(e),
            Err(_) => {
                lock_pending(&self.pending).remove(&id);
                Err(timeout_msg.into())
            }
        }
    }

    fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut s = serde_json::to_string(value).map_err(|e| e.to_string())?;
        s.push('\n');
        // L-7-8 修复: stdin.lock() 从 poisoned mutex 恢复,与 lock_pending 保持一致
        let mut stdin_opt = match self.stdin.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let stdin = match stdin_opt.as_mut() {
            Some(s) => s,
            None => return Err("sidecar stdin not available (process not running)".into()),
        };
        stdin.write_all(s.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 启动 watchdog 线程: 周期检查 sidecar 是否存活,崩溃则自动重启
    /// 调用方持有 Arc<SidecarHandle>, watchdog 持有 Weak 避免阻止 Drop
    pub fn start_watchdog(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            eprintln!("[sidecar-watchdog] started");
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));

                let handle = match weak.upgrade() {
                    Some(h) => h,
                    None => {
                        // Arc 已释放,SidecarHandle 被 Drop,退出 watchdog
                        eprintln!("[sidecar-watchdog] handle dropped, exiting");
                        break;
                    }
                };

                // 若是主动 shutdown 则退出 watchdog
                if handle.shutdown_done.load(Ordering::SeqCst) {
                    eprintln!("[sidecar-watchdog] shutdown flag set, exiting");
                    break;
                }

                // 检查 child 是否还活着
                let exit_status = {
                    let mut guard = match handle.child.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    match guard.as_mut() {
                        Some(child) => child.try_wait().ok().flatten(),
                        None => {
                            // child 已被 take (shutdown/Drop),退出
                            break;
                        }
                    }
                };

                if let Some(status) = exit_status {
                    eprintln!(
                        "[sidecar-watchdog] sidecar exited unexpectedly (code={:?}), attempting respawn",
                        status.code()
                    );
                    // 等待 1 秒,避免崩溃循环的快速重启
                    std::thread::sleep(std::time::Duration::from_secs(1));

                    // 再次检查 shutdown 标志 (在 sleep 期间可能被设置)
                    if handle.shutdown_done.load(Ordering::SeqCst) {
                        eprintln!("[sidecar-watchdog] shutdown during respawn wait, giving up");
                        break;
                    }

                    // 速率限制: 每分钟最多 3 次
                    if !handle.check_respawn_rate_limit() {
                        eprintln!("[sidecar-watchdog] giving up, exceeded 3 respawns/min");
                        break;
                    }

                    if let Err(e) = handle.do_respawn() {
                        eprintln!("[sidecar-watchdog] respawn failed: {e}");
                        // respawn 失败不 panic,下一轮 2 秒后会再检查
                        // 但如果 child 是 None (被 take),说明已 shutdown,退出
                    }
                }
            }
            eprintln!("[sidecar-watchdog] thread exiting");
        });
    }

    /// 检查 respawn 速率限制,返回 true 表示允许 respawn
    /// 滑动窗口: 保留最近 1 分钟内的 respawn 时间戳,超过 3 个则拒绝
    fn check_respawn_rate_limit(&self) -> bool {
        let mut timestamps = match self.respawn_timestamps.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let now = std::time::Instant::now();
        let cutoff = now - std::time::Duration::from_secs(60);
        timestamps.retain(|t| *t > cutoff);
        timestamps.len() < 3
    }

    /// 重新 spawn sidecar 子进程,替换 child/stdin,重启 stdout reader
    fn do_respawn(&self) -> Result<(), String> {
        let node = which_node()?;

        let mut cmd = Command::new(node);
        cmd.arg(&self.spawn_config.script);
        cmd.env("EDU_APP_DATA_DIR", &self.spawn_config.app_data_dir);
        cmd.env("EDU_RESOURCE_DIR", &self.spawn_config.resource_dir);
        cmd.env("EDU_IS_PACKAGED", if is_packaged() { "1" } else { "0" });
        if let Ok(v) = std::env::var("DEBUG") {
            cmd.env("DEBUG", v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = cmd.spawn().map_err(|e| format!("respawn sidecar: {e}"))?;

        let new_stdin = child
            .stdin
            .take()
            .ok_or_else(|| "no sidecar stdin on respawn".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "no sidecar stdout on respawn".to_string())?;

        // 替换 child 和 stdin
        {
            let mut child_guard = match self.child.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            // 旧 child 已退出,无需 kill/wait
            *child_guard = Some(child);
        }
        {
            let mut stdin_guard = match self.stdin.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            *stdin_guard = Some(new_stdin);
        }

        // 清空 pending map (旧请求全部作废)
        {
            let mut p = lock_pending(&self.pending);
            // 对每个 pending 发送错误,让等待的 request 返回
            for (_, tx) in p.drain() {
                let _ = tx.send(RpcResult::Err("sidecar crashed, request lost".into()));
            }
        }

        // 启动新的 stdout reader 线程
        let pending_reader = self.pending.clone();
        let app_reader = self.app_handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::with_capacity(READER_CAPACITY, stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<WireMessage>(&text) {
                            Ok(msg) => handle_wire_message(msg, &pending_reader, &app_reader),
                            Err(e) => {
                                eprintln!("[sidecar:txt] {text}   (note: non-JSON, {e})");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[sidecar-stdout] read error: {e}");
                        break;
                    }
                }
            }
            eprintln!("[sidecar-stdout] reader thread exiting (respawn)");
        });

        // 记录 respawn 时间戳
        {
            let mut timestamps = match self.respawn_timestamps.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            timestamps.push(std::time::Instant::now());
        }

        eprintln!("[sidecar-watchdog] respawned sidecar successfully");
        Ok(())
    }

    /// 优雅关闭 sidecar
    /// M-7-6 修复: 幂等保护,防止重复调用导致额外 1500ms 延迟和重复 kill
    /// L-7-3/L-7-4 修复: 使用 take() 消费 Child 并 wait() 回收,防止僵尸进程
    pub fn shutdown(&self) {
        // 幂等检查: 已 shutdown 则直接返回
        if self.shutdown_done.swap(true, Ordering::SeqCst) {
            return;
        }

        let _ = self.write_line(&serde_json::json!({"type":"shutdown"}));
        // 给 sidecar 足够时间 flush 防抖保存 (settings/keystore) + 关闭服务
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Ok(mut guard) = self.child.lock() {
            // L-7-4: take() 消费 Child,后续调用看到 None
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                // L-7-3: wait() 回收子进程,防止僵尸进程/句柄泄漏
                let _ = child.wait();
            }
        }
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        // P1 修复: 不调用 shutdown() — 它可能已被 CloseRequested 的 detached 线程调用
        // 但还在 1500ms sleep 中,此时进程退出会杀死该线程,child.kill() 永远不会执行。
        // 直接 take + kill + wait 确保子进程被清理,与 shutdown() 通过 take() 互斥安全:
        //   - 若 shutdown() 已 take(),这里 take() 返回 None — no-op
        //   - 若 shutdown() 还在 sleep,这里 take() 拿走 Child 并 kill — shutdown() 醒后 take() 返回 None
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn handle_wire_message(msg: WireMessage, pending: &Pending, app: &AppHandle) {
    match msg.kind.as_str() {
        "result" => {
            if let Some(id) = msg.id {
                // L-11 修复: 用 lock_pending 从 poisoned mutex 恢复
                let mut p = lock_pending(pending);
                if let Some(tx) = p.remove(&id) {
                    let result = if matches!(msg.ok, Some(true)) {
                        RpcResult::Ok(msg.data.unwrap_or(Value::Null))
                    } else {
                        RpcResult::Err(msg.error.unwrap_or_else(|| "unknown error".into()))
                    };
                    let _ = tx.send(result);
                }
            }
        }
        "event" => {
            // sidecar 主动推送的事件，转发到所有 webview
            if let Some(channel) = msg.channel {
                let data = msg.data.unwrap_or(Value::Null);
                // 忽略 emit 失败 (没有窗口监听时正常)
                let _ = app.emit(&channel, data);
            }
        }
        "sys" => {
            // sidecar 请求 Rust 处理原生能力 (打开浏览器/对话框/路径)
            // 这里在独立线程异步处理，结果回写 sidecar
            if let (Some(req), Some(id)) = (msg.request, msg.id) {
                let args = msg.args.unwrap_or(Value::Null);
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    let res = sys_bridge::handle_sidecar_sys_request(&app_clone, &req, &args);
                    // P2 修复: 至少记录失败结果,便于排查安全拦截问题
                    // (之前 let _ = res 完全静默,安全拦截失败时无从排查)
                    if let Some(obj) = res.as_object() {
                        if obj.get("success").and_then(|v| v.as_bool()) == Some(false) {
                            let err = obj.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
                            eprintln!("[sidecar] sys request '{}' failed (id={}): {}", req, id, err);
                        }
                    }
                });
            }
        }
        "log" => {
            // sidecar 显式转发的日志
            if let Some(data) = msg.data {
                eprintln!("[sidecar] {}", data);
            }
        }
        "console" => {
            // sidecar console.log/warn/error (业务 services 的日志)
            let level = msg.level.as_deref().unwrap_or("log");
            let data = msg.data.unwrap_or(Value::Null);
            let text = match data.as_str() {
                Some(s) => s.to_string(),
                None => data.to_string(),
            };
            match level {
                "error" => eprintln!("[sidecar:err] {}", text),
                "warn" => eprintln!("[sidecar:warn] {}", text),
                _ => eprintln!("[sidecar:log] {}", text),
            }
        }
        other => {
            eprintln!("[sidecar-stdout] unknown message type: {other}");
        }
    }
}

/// 渲染进程调用的统一入口命令
#[tauri::command]
pub fn ipc_invoke(
    channel: String,
    args: Vec<Value>,
    state: tauri::State<'_, Arc<SidecarHandle>>,
) -> Result<Value, String> {
    state.request(&channel, &args)
}

fn is_packaged() -> bool {
    // tauri dev 模式没有 TAURI_DEV 等可靠标志，用可执行文件旁有无 sidecar 源文件判断
    std::env::var("TAURI_ENV_PLATFORM").is_err() && cfg!(not(debug_assertions))
}

fn which_node() -> Result<String, String> {
    // 1. EDU_NODE_BIN 环境变量
    if let Ok(p) = std::env::var("EDU_NODE_BIN") {
        if std::path::Path::new(&p).exists() {
            return Ok(p);
        }
    }
    // 2. resource_dir 下的 node.exe (打包模式: node.exe 随 Tauri resources 分发)
    //    NSIS 打包时路径可能是 resource_dir/node.exe 或 resource_dir/resources/node.exe
    if let Ok(rd) = std::env::var("EDU_RESOURCE_DIR") {
        let rd_path = std::path::Path::new(&rd);
        // 直接在 resource_dir 下
        let p = rd_path.join("node.exe");
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
        // NSIS 打包: node.exe 在 resources/ 子目录下
        let p = rd_path.join("resources").join("node.exe");
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    // 3. exe 同级目录的 node.exe (兜底)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("node.exe");
            if p.exists() {
                return Ok(p.to_string_lossy().to_string());
            }
            // NSIS _up_ 目录
            let p = parent.join("_up_").join("resources").join("node.exe");
            if p.exists() {
                return Ok(p.to_string_lossy().to_string());
            }
        }
    }
    // 4. PATH 里的 node
    let candidates = ["node", "node.exe"];
    for c in candidates {
        // L-6 修复: 检查退出码 success() 而非仅 spawn 成功 is_ok()
        // M-7-7 修复: 加 5 秒超时,防止损坏的 node 可执行文件挂起启动
        match Command::new(c)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                // 使用 spawn + wait_timeout 模式实现超时
                let timeout = std::time::Duration::from_secs(5);
                match wait_with_timeout(&mut child, timeout) {
                    Ok(Some(status)) if status.success() => return Ok(c.to_string()),
                    Ok(Some(_)) => continue, // 退出码非0,尝试下一个
                    Ok(None) => {
                        // 超时,kill 子进程
                        let _ = child.kill();
                        let _ = child.wait();
                        eprintln!("[sidecar] node --version timed out for {c}");
                        continue;
                    }
                    Err(_) => {
                        // P1 修复: try_wait 出错时也要 kill+wait,避免子进程泄漏
                        let _ = child.kill();
                        let _ = child.wait();
                        continue;
                    }
                }
            }
            Err(_) => continue,
        }
    }
    Err("node executable not found in PATH".into())
}

/// M-7-7 修复: 带超时的 wait,超时返回 Ok(None)
/// 使用 try_wait 轮询,跨平台兼容
fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Result<Option<std::process::ExitStatus>, String> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => return Ok(Some(status)),
            None => {
                if start.elapsed() >= timeout {
                    return Ok(None);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}
