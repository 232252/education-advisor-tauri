// =============================================================
// React 渲染进程入口
// =============================================================

import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/globals.css'

// Tauri 迁移: 在 Tauri 运行时安装 window.api 桥 (与 Electron preload 等价)
// 必须在 import App 之前完成，因为页面代码会在挂载时立即调用 window.api。
// Electron 运行时 window.api 已由 preload 注入，跳过。
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}
if (window.__TAURI_INTERNALS__) {
  // 同步安装: buildAPI() 是纯同步构造，方法在被调用时才发 invoke (Promise)
  const { installTauriBridge } = await import('./lib/tauri-bridge')
  installTauriBridge()
}

// 在 bridge 安装后再 import App (保证页面组件用到 window.api 时已就绪)
const { App } = await import('./App')

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
