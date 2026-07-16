# 启动 Tauri dev with CDP debugging
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npx tauri dev
