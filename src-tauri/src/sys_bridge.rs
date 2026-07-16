// =============================================================
// 原生能力桥接 — 把 sidecar/渲染进程的请求路由到 Tauri 原生插件
//
// 这些能力在 Tauri 里用原生 Rust 实现更稳:
//   - openExternal(url): shell 插件
//   - showInFolder(path): shell 插件 revealItemInDir
//   - dialog (open/save): dialog 插件
//   - getPath(userData/downloads/...): tauri path API
// =============================================================

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

/// M-2 修复: 协议白名单校验，防止 file:///javascript: 等危险协议
/// M-TAURI-4 修复: 与 TS 端 ALLOWED_PROTOCOLS 统一,仅允许 https/mailto
fn is_safe_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.starts_with("https://") || lower.starts_with("mailto:")
}

/// M-11 修复: 路径安全校验，拒绝 UNC 路径、相对路径、无父目录的路径
fn is_safe_path(path: &str) -> bool {
    // 拒绝 UNC 路径 (\\server\share 或 //server/share)
    if path.starts_with("\\\\") || path.starts_with("//") {
        return false;
    }
    let p = PathBuf::from(path);
    // 必须是绝对路径
    if !p.is_absolute() {
        return false;
    }
    // 必须有非空父目录
    match p.parent() {
        Some(d) if !d.as_os_str().is_empty() => true,
        _ => false,
    }
}

/// Windows canonicalize 返回 \\?\C:\... 扩展长度前缀，统一去除以便比较
#[cfg(windows)]
fn strip_verbatim_prefix(p: &PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        p.clone()
    }
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(p: &PathBuf) -> PathBuf {
    p.clone()
}

/// MEDIUM 3.2 修复: 检查路径是否在允许的目录白名单内
/// 防止 sys_show_in_folder 打开任意系统目录(如 C:\Windows\System32, ~/.ssh 等)
fn is_within_allowed_roots(path: &str, app: &AppHandle) -> bool {
    let p = match std::fs::canonicalize(path) {
        Ok(c) => strip_verbatim_prefix(&c),
        Err(_) => return false, // 路径不存在或无法解析
    };

    // 允许的根目录列表(与 sys_get_paths 返回的路径对齐)
    // 注意: 不包含 home_dir — 它涵盖所有子目录会使白名单形同虚设
    let allowed_roots: Vec<PathBuf> = vec![
        app.path().app_data_dir().ok(),
        app.path().download_dir().ok(),
        app.path().desktop_dir().ok(),
        app.path().document_dir().ok(),
        app.path().temp_dir().ok(),
    ]
    .into_iter()
    .flatten()
    .collect();

    // 检查路径是否在任一允许的根目录下
    for root in &allowed_roots {
        // 规范化根目录(可能不存在,用 canonicalize 失败时用原始路径)
        let canonical_root = match std::fs::canonicalize(root) {
            Ok(c) => strip_verbatim_prefix(&c),
            Err(_) => strip_verbatim_prefix(root),
        };
        if p.starts_with(&canonical_root) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn sys_open_external(url: String, app: AppHandle) -> Result<(), String> {
    if !is_safe_url(&url) {
        return Err(format!("blocked unsafe url scheme: {url}"));
    }
    #[allow(deprecated)]
    app.shell()
        .open(url, None)
        .map_err(|e| format!("open external failed: {e}"))
}

#[tauri::command]
pub async fn sys_show_in_folder(path: String, app: AppHandle) -> Result<(), String> {
    // M-11 修复: 路径安全校验
    if !is_safe_path(&path) {
        return Err(format!("blocked unsafe path: {path}"));
    }
    // MEDIUM 3.2 修复: 限制只能打开用户数据目录内的文件夹
    // 防止通过 sys_show_in_folder 浏览任意系统目录
    if !is_within_allowed_roots(&path, &app) {
        return Err(format!("path is outside allowed directories: {path}"));
    }
    // 用 shell 插件的 open 打开所在文件夹
    let p = PathBuf::from(&path);
    // 如果路径本身是目录，直接打开；否则打开所在目录
    let dir = if p.is_dir() {
        path.clone()
    } else {
        p.parent()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or(path)
    };
    #[allow(deprecated)]
    app.shell()
        .open(dir, None)
        .map_err(|e| format!("show in folder failed: {e}"))
}

/// 获取系统路径 (userData/downloads/desktop/temp/documents/...)
#[tauri::command]
pub async fn sys_get_paths(name: String, app: AppHandle) -> Result<String, String> {
    let path = match name.as_str() {
        "userData" | "appData" => app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?,
        "downloads" => app.path().download_dir().map_err(|e| e.to_string())?,
        "desktop" => app.path().desktop_dir().map_err(|e| e.to_string())?,
        "documents" => app.path().document_dir().map_err(|e| e.to_string())?,
        "temp" => std::env::temp_dir(),
        "home" => app.path().home_dir().map_err(|e| e.to_string())?,
        _ => return Err(format!("unknown path name: {name}")),
    };
    Ok(path.to_string_lossy().to_string())
}

/// sidecar 通过 stdout 发来的 sys 请求 — 异步处理
pub fn handle_sidecar_sys_request(app: &AppHandle, request: &str, args: &Value) -> Value {
    match request {
        "openExternal" => {
            if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
                if !is_safe_url(url) {
                    return json!({"success": false, "error": "blocked unsafe url scheme"});
                }
                // M-7-3 修复: 检查 shell().open() 返回值,失败时返回错误而非虚假成功
                #[allow(deprecated)]
                match app.shell().open(url.to_string(), None) {
                    Ok(_) => return json!({"success": true}),
                    Err(e) => return json!({"success": false, "error": format!("open failed: {e}")}),
                }
            }
            json!({"success": false, "error": "missing url"})
        }
        "showInFolder" => {
            if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                // M-11 修复: 路径安全校验
                if !is_safe_path(path) {
                    return json!({"success": false, "error": "blocked unsafe path"});
                }
                // R6-1 修复: 与 sys_show_in_folder 命令保持一致,添加白名单校验
                // 防止 sidecar 通过 sys 请求打开任意系统目录
                if !is_within_allowed_roots(path, app) {
                    return json!({"success": false, "error": "path is outside allowed directories"});
                }
                let p = PathBuf::from(path);
                let dir = p
                    .parent()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string());
                // M-7-3 修复: 检查 shell().open() 返回值
                #[allow(deprecated)]
                match app.shell().open(dir, None) {
                    Ok(_) => return json!({"success": true}),
                    Err(e) => return json!({"success": false, "error": format!("open failed: {e}")}),
                }
            }
            json!({"success": false, "error": "missing path"})
        }
        "notification" => {
            // 通知通过 tauri-plugin-notification 在前端处理更简单
            // 这里只回执
            json!({"success": true})
        }
        "getPath" => {
            if let Some(name) = args.get("name").and_then(|v| v.as_str()) {
                let path = match name {
                    "userData" | "appData" => app.path().app_data_dir().ok(),
                    "downloads" => app.path().download_dir().ok(),
                    "desktop" => app.path().desktop_dir().ok(),
                    "documents" => app.path().document_dir().ok(),
                    "temp" => Some(std::env::temp_dir()),
                    "home" => app.path().home_dir().ok(),
                    _ => None,
                };
                if let Some(p) = path {
                    return json!({"path": p.to_string_lossy()});
                }
            }
            json!({"error": "unknown path"})
        }
        _ => json!({"error": format!("unknown sys request: {request}")}),
    }
}
