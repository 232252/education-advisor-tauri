// =============================================================
// Education Advisor — Tauri 主进程 (从 Electron 迁移)
//
// 架构: Tauri(Rust shell) + Node.js sidecar (业务逻辑)
//   - 渲染进程 (React) 调用 invoke('ipc_invoke', {channel, args})
//   - Rust 把请求通过 stdin (newline-delimited JSON-RPC) 转发给 sidecar
//   - sidecar 复用原 Electron 的全部 services (sqlite/cron/feishu/...)
//   - sidecar 主动推送的事件，Rust 通过 window.emit() 转发到渲染进程
//
// 这样保证 100% 功能等价: 业务代码零改动，只换 shell。
// =============================================================

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod sidecar;
mod sys_bridge;

use std::sync::Arc;
use tauri::Manager;

use sidecar::SidecarHandle;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 已有实例运行时，把窗口提到前台
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // ---- 解析 userData 路径，传给 sidecar ----
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app_data_dir");
            std::fs::create_dir_all(&app_data_dir).ok();

            // 资源目录 (config/ 与 eaa-binaries 解包后的位置)
            // NSIS 打包: "../" 前缀的资源被放到 _up_/ 子目录,需要优先使用
            let resource_dir_raw = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| app_data_dir.clone());
            let resource_dir = {
                let up_dir = resource_dir_raw.join("_up_");
                if up_dir.join("config").exists() || up_dir.join("sidecar").exists() {
                    up_dir
                } else {
                    resource_dir_raw
                }
            };

            // ---- 启动 Node sidecar ----
            // 开发模式: 直接 `node sidecar/edu-sidecar.mjs`
            // 生产模式: 同样用 node 启动 (打包时 sidecar/ 和 dist/ 都在 resource_dir 下)
            // 路径搜索顺序: cwd / cwd.parent / resource_dir / exe 所在目录 / _up_(NSIS 打包)
            //
            // NSIS 打包说明: tauri.conf.json 中 resources 使用 "../" 前缀时,NSIS 会把
            // 这些文件放到 exe 同级的 "_up_" 子目录中。所以生产模式下需要额外检查 _up_。
            let cwd = std::env::current_dir().unwrap_or_default();
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|x| x.to_path_buf()))
                .unwrap_or_default();
            let candidates = [
                cwd.join("sidecar").join("edu-sidecar.mjs"),
                cwd.join("..").join("sidecar").join("edu-sidecar.mjs"),
                resource_dir.join("sidecar").join("edu-sidecar.mjs"),
                exe_dir.join("sidecar").join("edu-sidecar.mjs"),
                // NSIS 打包: resources 在 _up_/ 下
                exe_dir.join("_up_").join("sidecar").join("edu-sidecar.mjs"),
                resource_dir.join("_up_").join("sidecar").join("edu-sidecar.mjs"),
            ];
            let sidecar_script = candidates
                .iter()
                .find(|p| p.exists())
                .cloned()
                .unwrap_or_else(|| candidates[0].clone());

            let app_data_str = app_data_dir.to_string_lossy().to_string();
            let resource_str = resource_dir.to_string_lossy().to_string();
            let script_str = sidecar_script.to_string_lossy().to_string();

            log_sidecar_diagnostic(&format!(
                "sidecar script: {} (exists={})",
                script_str,
                sidecar_script.exists()
            ));

            // 用 sidecar 模块启动子进程
            let sidecar = SidecarHandle::spawn(
                &script_str,
                &app_data_str,
                &resource_str,
                app.handle().clone(),
            )
            .expect("failed to spawn Node sidecar");
            let sidecar = Arc::new(sidecar);

            // 启动 watchdog: 崩溃自动重启 (需在 Arc::new 之后调用)
            sidecar.start_watchdog();

            // 把 sidecar 句柄存到应用状态里，供 ipc_invoke 命令使用
            app.manage(sidecar);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::ipc_invoke,
            sys_bridge::sys_open_external,
            sys_bridge::sys_show_in_folder,
            sys_bridge::sys_get_paths,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 窗口关闭时通知 sidecar 优雅退出
                // M-7-5 修复: 在独立线程执行 shutdown,避免阻塞主线程 1500ms
                // Drop 会在 Arc 引用计数归零时再次调用 shutdown,但 M-7-6 幂等保护会跳过
                if let Some(handle) = window.app_handle().try_state::<Arc<SidecarHandle>>() {
                    let handle_clone = handle.inner().clone();
                    std::thread::spawn(move || {
                        handle_clone.shutdown();
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Education Advisor Tauri app");
}

fn log_sidecar_diagnostic(msg: &str) {
    // 启动期诊断信息打到 stderr (tauri 会转发到终端)
    eprintln!("[tauri-setup] {}", msg);
}
