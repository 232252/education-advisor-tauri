// =============================================================
// React 渲染进程入口
// =============================================================

import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/globals.css'
import { App } from './App'
import { installTauriBridge } from './lib/tauri-bridge'

// Tauri 迁移: 在 Tauri 运行时安装 window.api 桥 (与 Electron preload 等价)
// 必须在 App 挂载之前完成,因为页面代码会在挂载时立即调用 window.api。
// Electron 运行时 window.api 已由 preload 注入,跳过。
//
// 历史问题(R44 白屏 BUG):
//   之前用 `await import('./lib/tauri-bridge')` 动态导入,
//   在某些 WebView2 版本下 `import.meta.url` 解析失败,
//   动态 import 抛 rejection 但无 try/catch → main.tsx 静默挂起 → 白屏。
//   修复:改为静态 import + 同步安装,消除顶层 await 链。
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}
if (window.__TAURI_INTERNALS__) {
  // 静态导入: 打包时直接打到主 chunk,加载 index.html 时一次性就绪
  // installTauriBridge() 是纯同步构造,方法在被调用时才发 invoke(Promise)
  installTauriBridge()
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
