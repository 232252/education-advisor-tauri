# 📦 构建指南 (BUILD.md)

> **从源码构建 Education Advisor 桌面安装包的完整流程。**
> 本文是 **Tauri 2** 构建路径的权威指南（当前主线）。
> 旧版 Electron 打包路径见 [`docs/DESKTOP_BUILD.md`](./docs/DESKTOP_BUILD.md)（仅作历史保留）。

## 目录

- [环境要求](#环境要求)
- [一键构建](#一键构建)
- [分步构建（理解每一步）](#分步构建理解每一步)
- [产物说明](#产物说明)
- [开发模式](#开发模式)
- [常用脚本速查](#常用脚本速查)
- [常见问题排查](#常见问题排查)
- [清理与重建](#清理与重建)

---

## 环境要求

| 工具 | 最低版本 | 用途 | 检查命令 |
| --- | --- | --- | --- |
| **Node.js** | ≥ 22 | 构建 sidecar / main / renderer 三个 JS bundle | `node -v` |
| **npm** | ≥ 10 | 依赖安装与脚本编排 | `npm -v` |
| **Rust 工具链** | stable（本仓库用 1.95） | 编译 Tauri Rust 外壳 + 原生依赖（`better-sqlite3` 等） | `rustc -V` / `cargo -V` |
| **Tauri CLI** | 2.x（随 `devDependencies` 安装） | 打包 NSIS / MSI 安装器 | `npx tauri -V` |
| **Windows C++ 构建工具** | VS 2022 Build Tools（含 C++ 工作负载） | 编译原生模块（`better-sqlite3` 的 node-gyp） | — |
| **WebView2** | 随 Win10/11 附带 | Tauri 运行时依赖 | — |

> macOS / Linux：本项目以 Windows 优先维护。要在其他平台构建，编辑
> [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json) 的 `bundle.targets`
> 并补充 `app` / `dmg` / `deb` / `appimage` 目标。详见
> [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md)。

首次准备环境只需三步：

```bash
# 1. 克隆
git clone https://github.com/232252/education-advisor-tauri.git
cd education-advisor-tauri

# 2. 安装 JS 依赖
npm ci

# 3. 拉取 Rust 后端二进制（eaa-cli）到 resources/eaa-binaries/
npm run build:eaa
```

---

## 一键构建

```bash
npm run tauri:build
```

这一条命令会按顺序完成全部工作，最终在
`src-tauri/target/release/bundle/` 下产出 Windows 安装包。

它实际等价于：

```bash
npm run build:tauri   # = build:sidecar + copy-sidecar-deps + build(main+renderer)
tauri build           # 编译 Rust release + 打包 NSIS/MSI
```

---

## 分步构建（理解每一步）

如果一键构建出错、或你想只跑某一阶段，可按下面的顺序分步执行。

```bash
# ① 预检：确认 eaa 二进制 / agents / config 等资源齐备
npm run prebuild:check

# ② 构建 Node sidecar bundle  →  dist/sidecar/sidecar.mjs
npm run build:sidecar

# ③ 把 sidecar 运行时依赖打进 dist/node_modules（供安装器打包）
node scripts/copy-sidecar-deps.mjs

# ④ 构建 main + renderer 前端 bundle  →  dist/main/* , dist/renderer/*
npm run build

# ⑤ 编译 Rust release 并打包安装器（NSIS + MSI）
npx tauri build
```

> 说明：`tauri:build` = ② + ③ + ④，再由 Tauri 的 `beforeBuildCommand`
> 自动触发 ④ 并最终执行 ⑤。手动分步时按上面顺序即可。

---

## 产物说明

构建成功后，安装包位于：

```
src-tauri/target/release/bundle/
├── nsis/
│   └── Education Advisor_0.1.0_x64-setup.exe   # Windows NSIS 安装器（中文界面）
└── msi/
    ├── Education Advisor_0.1.0_x64_en-US.msi    # Windows MSI（英文）
    └── Education Advisor_0.1.0_x64_zh-CN.msi    # Windows MSI（中文）
```

- **NSIS 安装器**：自定义 UI（`installer.ico` / `header.bmp` / `sidebar.bmp`），
  `installMode: currentUser`，LZMA 压缩，中文语言。
- **MSI**：企业部署友好，支持组策略分发。
- 版本号取自 [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json) 的 `version`
  （当前 `0.1.0`）。改版本号时，`package.json` 与 `src-tauri/Cargo.toml` 也需同步。

未签名构建首次运行时，Windows SmartScreen 会提示「已保护你的电脑」——
点「更多信息 → 仍要运行」即可。要消除提示需做代码签名（见
[`docs/DESKTOP_BUILD.md#code-signing`](./docs/DESKTOP_BUILD.md#code-signing)）。

---

## 开发模式

日常开发用热重载模式，无需先打包：

```bash
npm run tauri:dev
```

它会构建 sidecar，然后启动 `tauri dev`：编译 Rust 外壳、拉起 sidecar、
打开带 HMR 的原生 Tauri 窗口。渲染层由 Tauri 内置 dev server 提供。

---

## 常用脚本速查

| 命令 | 作用 |
| --- | --- |
| `npm run tauri:build` | **生产构建**（出安装包） |
| `npm run tauri:dev` | 开发模式（HMR） |
| `npm run prebuild:check` | 预检资源是否齐备 |
| `npm run build:sidecar` | 只构建 sidecar bundle |
| `npm run build:tauri` | 构建 sidecar + 复制依赖 + 构建 main/renderer |
| `npm run build` | 只构建 main + renderer 前端 bundle |
| `npm run build:eaa` | 下载/编译 Rust `eaa-cli` 后端到 `resources/eaa-binaries/` |
| `npm run build:icon` | 重新生成应用图标集 |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | `biome check src/` 代码检查 |
| `npm run lint:fix` | 自动修复 lint 问题 |
| `npm run test` | 运行 Vitest 测试套件 |
| `npm run test:coverage` | 测试 + 覆盖率报告 |
| `npm run self-check` | 自检脚本 |
| `npm run clean` | 清理 `dist/` `release/` |

---

## 常见问题排查

### `better-sqlite3` 编译失败（Windows）

报错 `gyp ERR! find Python` 之类 → 安装 **Visual Studio 2022 Build Tools**
并勾选「使用 C++ 的桌面开发」工作负载，再重试。

### Tauri CLI 找不到

报 `tauri: command not found` → 用 `npx tauri ...`，或确认
`@tauri-apps/cli` 已在 `devDependencies`（本项目随 `npm ci` 安装）。

### 打包报缺少资源（`config` / `agents` / `vendor/...`）

`tauri.conf.json` 的 `bundle.resources` 引用了若干目录。若缺失会打包失败。
先跑 `npm run prebuild:check`，按提示补齐；`vendor/` 目录由仓库自带，
`resources/eaa-binaries/` 由 `npm run build:eaa` 生成。

### 首次 Rust 编译很慢

首次 `tauri build` 需编译全部 Rust 依赖，可能 5～10 分钟。后续增量编译会快很多。
`src-tauri/target/` 是缓存目录（已 gitignore），不要手动删它里面的内容，
除非你确认要全量重建（见下）。

### NSIS / WiX（MSI）工具链缺失

Tauri 会自动下载所需打包工具到缓存目录。若下载被墙，可设置代理或手动放置。
MSI 用 WiX，NSIS 用 NSIS-3，均由 Tauri 自动管理。

### 改了版本号但安装包名没变

确认三处版本号一致：`src-tauri/tauri.conf.json` → `version`、
`src-tauri/Cargo.toml` → `version`、`package.json` → `version`。

---

## 清理与重建

当构建出现「诡异」问题（链接错误、旧产物残留等），做一次彻底重建：

```bash
# 删除所有构建产物（JS bundle + Rust target + 旧安装包）
npm run clean          # 清理 dist/ 和 release/
rm -rf src-tauri/target   # 清理 Rust 编译缓存（约 5～6 GB）

# 从零开始
npm run prebuild:check
npm run tauri:build
```

> ⚠️ 删除 `src-tauri/target/` 后，下次构建会从零编译 Rust，耗时较长（首次 5～10 分钟）。
> 仅在遇到不可解释的构建问题时才这么做。

---

## 相关文档

- [`README.md`](./README.md) — 项目总览与快速上手
- [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — 开发环境配置
- [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md) — 分发与发布
- [`docs/EAA_BRIDGE.md`](./docs/EAA_BRIDGE.md) — Rust EAA 后端说明
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) — 故障排查大全
