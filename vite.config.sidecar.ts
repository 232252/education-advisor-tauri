import { defineConfig } from 'vite'
import { resolve } from 'path'

// Sidecar 构建配置
// 把 src/sidecar/sidecar-entry.ts 编译为 dist/sidecar/sidecar.cjs
// 关键: resolve.alias 把 'electron' 重定向到 src/sidecar/electron-shim.ts
//       这样所有 services/handlers 里的 `from 'electron'` 都用上 shim
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist/sidecar',
    lib: {
      entry: {
        sidecar: resolve(__dirname, 'src/sidecar/sidecar-entry.ts'),
      },
      formats: ['es'],
      fileName: () => 'sidecar.mjs',
    },
    rollupOptions: {
      external: [
        // Node 内置模块 (sidecar 在 Node 进程里跑，不打包进 bundle)
        /^node:/,
        'better-sqlite3',
        'node-cron',
        'chokidar',
        'cross-spawn',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-ai/compat',
        '@larksuiteoapi/node-sdk',
        'xlsx',
        'yaml',
        'typebox',
      ],
    },
    target: 'node22',
    minify: false,
    sourcemap: false,
  },
  // ESM 没有 __dirname/__filename/require；业务代码 (来自 CJS 习惯) 大量使用。
  // banner 在 bundle 最顶部注入真实路径 + createRequire (给原生模块 better-sqlite3 用)
  esbuild: {
    banner: `import { fileURLToPath as __eduFileURLToPath } from 'node:url'; import { dirname as __eduDirname } from 'node:path'; import { createRequire as __eduCreateRequire } from 'node:module'; const __filename = __eduFileURLToPath(import.meta.url); const __dirname = __eduDirname(__filename); const require = __eduCreateRequire(import.meta.url);`,
    legalComments: 'none',
  },
  ssr: {
    // typebox ESM-only，需要内联转译
    noExternal: ['typebox'],
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      // ★ 核心: 'electron' → shim
      electron: resolve(__dirname, 'src/sidecar/electron-shim.ts'),
    },
  },
})
