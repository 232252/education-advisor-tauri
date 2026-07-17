import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// 渲染进程 Vite 配置
// React SPA + HMR 开发服务器
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    // RISK 修复: outDir 不在 project root 内,vite 默认不会 empty
    // 显式开启 emptyOutDir 避免多次构建后旧 index-*.js 残留污染 dist
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
      output: {
        manualChunks(id: string) {
          // ECharts 单独打包 — 仅 Dashboard/StudentProfile 使用
          if (id.includes('echarts') || id.includes('zrender')) return 'vendor-echarts'
          // React 核心
          if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler')) return 'vendor-react'
        },
      },
    },
    target: 'chrome130',
    // See vite.config.main.ts for why sourcemap is disabled here.
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
