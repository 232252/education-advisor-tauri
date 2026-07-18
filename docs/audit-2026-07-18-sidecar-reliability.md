# Sidecar 可靠性 + 打包完整性审计报告

> **日期**：2026-07-18（第 14 轮自主测试）
> **分支**：test-optimize-cycle11
> **状态**：审计完成，Rust 代码改动待人工 review（风险较高，未擅自修改）
> **审计范围**：src-tauri/（Rust 层）+ tauri.conf.json + 构建 pipeline + 打包资源

## 摘要

第 14 轮从 Tauri/Rust 层审查 sidecar 可靠性与打包完整性，发现 **6 个 HIGH + 8 个 MEDIUM** 问题。其中最严重的是 **sidecar 崩溃可靠性三连击**：崩溃后 pending 请求永卡 + IPC 线程池耗尽 + 无自动重启 → "app 静默死亡"。

**本次修复（低风险配置改动）**：
- R14-12: `tauri:build` 加 `prebuild:check`（package.json，确保 CI 不漏检 EAA 二进制）
- R14-03: vite.config.sidecar.ts 注释修正（L5 的 `sidecar.cjs` 过时）

**待 review 的 Rust 改动（本次未修，风险较高）**：见下方详述。

---

## 一、Sidecar 可靠性三连击（HIGH，最严重）

### R14-04：崩溃时 pending 请求永远卡住
- **位置**：`src-tauri/src/sidecar.rs:114-138`（stdout reader）+ `190-201`（write_line）
- **现象**：sidecar 子进程崩溃 → reader 线程退出（EOF）→ 但 `pending` HashMap 里所有未应答的 invoke **永远卡住**，300s 超时后才返回错误
- **影响**：崩溃后用户的所有操作（点击、查询）都"转圈"5 分钟才报错
- **修复方向**：reader 线程退出时遍历 `pending`，对每个 tx 发送 `RpcResult::Err("sidecar exited")`

### R14-05：ipc_invoke 同步阻塞 + 线程池耗尽
- **位置**：`src-tauri/src/sidecar.rs:312-319`
- **现象**：`ipc_invoke` 是同步阻塞 command（非 async），每个 invoke 占用 Tauri 线程池线程最多 300s。Tauri 默认 runtime 线程池仅 4 线程
- **影响**：4 个长 invoke（如 agent 运行、大数据查询）并发 → **整个 IPC 冻死**，UI 完全无响应
- **修复方向**：改 `async fn` + `tokio::sync::oneshot`，或 `spawn_blocking`

### R14-06：sidecar 崩溃无自动重启
- **位置**：`src-tauri/src/main.rs:40-114`（setup）+ `sidecar.rs`（无 watchdog）
- **现象**：完全没有崩溃检测/重启机制。sidecar 崩溃后窗口不关闭，但所有业务功能死亡
- **用户体验**：「窗口没崩但功能全死」，必须手动关闭重启
- **修复方向**：加 watchdog 线程（child.try_wait 循环）+ 指数退避重启 + 5 次上限 + `__sidecar__:fatal` 事件推 webview

**三个问题叠加的最坏路径**：sidecar 崩溃 → pending 卡 300s → 期间新 invoke 占满线程池 → IPC 冻死 → 无重启 → app 静默死亡。

---

## 二、打包完整性（HIGH，生产构建可能失败）

### R14-01：resources 整目录打包，安装包膨胀
- **位置**：`src-tauri/tauri.conf.json:43-56`
- **现象**：resources 同时打包 `../sidecar`（含 80+ 测试 .mjs）+ `../dist/node_modules`（整目录）+ `../dist/main`（对 Tauri 无用）
- **影响**：NSIS 安装包体积预估 200MB+，且 sidecar/ 下的测试脚本暴露源码
- **修复方向**：resources 改白名单（仅 `edu-sidecar.mjs` + `electron-shim/` 子集），`dist/main` 删除

### R14-02：vendor/pi-agent-core 未打包
- **位置**：`tauri.conf.json:52-53`（只打包 pi-ai）+ `vite.config.sidecar.ts:27`（external pi-agent-core）
- **现象**：vite 把 pi-agent-core 标记 external（运行时 require），但 tauri.conf.json 没把它打进 resources
- **影响**：生产环境 sidecar 启动时 `require('@earendil-works/pi-agent-core')` 找不到模块 → agent 运行崩溃
- **修复方向**：tauri.conf.json resources 加 `vendor/pi-agent-core/dist` + `package.json`

### R14-11：node.exe 声明打包但文件不存在
- **位置**：`tauri.conf.json:46`
- **现象**：`resources.node.exe` 声明打包，但 `resources/node.exe` 文件不在仓库
- **影响**：用户机器若无 Node 22+，sidecar 启动失败
- **修复方向**：release 前下载 Node 22 二进制到 `resources/node.exe`（约 30-40MB）

---

## 三、其他 MEDIUM 问题（待 review）

| ID | 位置 | 问题 |
|---|---|---|
| R14-07 | sidecar.rs:84-95 | Windows 下 `Command::new(node)` 未设 CREATE_NO_WINDOW，会闪黑窗 |
| R14-08 | sidecar.rs:321-324 | `is_packaged()` 用 `cfg!(not(debug_assertions))`，`cargo run --release` 误判为 packaged |
| R14-09 | main.rs:121-132 | CloseRequested 用 detached thread 调 shutdown，主进程可能先退出 |
| R14-10 | tauri.conf.json:26 | CSP connect-src 含 dev-only localhost，生产多余暴露 |
| R14-13 | vite.config.main.ts + tauri.conf.json:50 | dist/main 对 Tauri 无用却打包，浪费 1.3MB |
| R14-14 | sidecar.rs:84-95 | 环境变量只透传 DEBUG，未透传 HTTP_PROXY/HTTPS_PROXY |

---

## 四、误报澄清

### R7-05 / R14-03：sidecar 文件名"不一致"
- **之前评估**：vite 配 `sidecar.mjs`，实际产物 `sidecar.js`，认为 bug
- **实际**：这是**设计意图**。架构是两层：
  1. Rust 启动固定入口 `sidecar/edu-sidecar.mjs`
  2. `edu-sidecar.mjs` 的 `findBundle()` 查找 `sidecar.{mjs,js,cjs}` 三个候选
- **结论**：**不是 bug**，findBundle 兼容了 vite 不同版本的产物命名。仅需修正过时注释（已做）

---

## 五、修复优先级建议

1. **P0（可靠性）**：R14-04 + R14-05 + R14-06（sidecar 崩溃三连击）—— 影响所有用户
2. **P1（打包）**：R14-01 + R14-02 + R14-11（生产构建完整性）—— 影响首次发布
3. **P2（体验）**：R14-07（黑窗）+ R14-10（CSP）+ R14-14（代理透传）
4. **P3（清理）**：R14-13（dist/main）+ 注释修正（已做）

---

## 六、本次已修复

- ✅ R14-12：`tauri:build` 加 `prebuild:check`（package.json）
- ✅ R14-03：vite.config.sidecar.ts 注释修正（说明 findBundle 解耦机制）

## 七、待人工 review 的 Rust 改动

R14-04/05/06/07/08/09/14 涉及 Rust 代码（sidecar.rs/main.rs），需要：
1. cargo 编译验证
2. Tauri dev 模式实测崩溃恢复
3. 多平台测试（至少 Windows）

建议由熟悉 Rust + Tauri 的人实施，或单独开一个 cycle 专门处理 Rust 层。
