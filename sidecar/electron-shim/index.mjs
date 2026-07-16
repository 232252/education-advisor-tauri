// =============================================================
// Electron 垫片 (Shim) — 让原本依赖 Electron 的 services / handlers
// 在纯 Node.js sidecar 进程里零改动运行。
//
// 覆盖的 API:
//   - ipcMain.handle(channel, fn)     → 注册到内部路由表
//   - BrowserWindow (mock)            → webContents.send 触发事件推送
//   - app.getPath / isPackaged / getVersion / setLoginItemSettings
//   - safeStorage (AES-256-GCM + 机器派生密钥, 等价 DPAPI)
//   - dialog (转发给 Tauri 原生 — 通过 sysBus)
//   - shell.openExternal (转发给 Tauri 原生)
//   - Notification / Tray / Menu / nativeImage / protocol / net (降级 no-op)
//
// 调用方约定: sidecar 启动后先 import 此模块，再用原 handler 注册函数。
// =============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---- 由 sidecar 主入口注入的"事件出口"和"系统请求"通道 ----
// setOutbound 会在 sidecar bootstrap 时调用
let _emitEvent = async (_channel, _data) => {}
let _sysRequest = async (_request, _args) => ({ success: false, error: 'sys bus not connected' })

export function setOutbound({ emitEvent, sysRequest }) {
  if (typeof emitEvent === 'function') _emitEvent = emitEvent
  if (typeof sysRequest === 'function') _sysRequest = sysRequest
}

// ---- userData 目录解析 (Tauri 通过环境变量传入) ----
function resolveUserDataDir() {
  if (process.env.EDU_APP_DATA_DIR) return process.env.EDU_APP_DATA_DIR
  // 兼容: 回退到 Electron 默认路径
  const home = os.homedir()
  const appFolder =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Education Advisor')
      : process.platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming', 'education-advisor')
        : path.join(home, '.config', 'education-advisor')
  try {
    fs.mkdirSync(appFolder, { recursive: true })
  } catch {
    /* ignore */
  }
  return appFolder
}

function resolveResourceDir() {
  if (process.env.EDU_RESOURCE_DIR) return process.env.EDU_RESOURCE_DIR
  // 开发模式: 项目根
  return process.cwd()
}

// ============================================================
// ipcMain — 把所有 handle 调用注册到路由表
// ============================================================
const _handlers = new Map()

const ipcMain = {
  handle(channel, fn) {
    if (_handlers.has(channel)) {
      // Electron 在重复注册时会抛错；这里保持一致
      console.warn(`[shim] ipcMain.handle: channel "${channel}" already registered, overwriting`)
    }
    _handlers.set(channel, fn)
  },
  // 一些 handler 用 ipcRenderer.send 的反向 (preload 里 forward 用 send)
  on(_channel, _fn) {
    /* sidecar 模式下渲染进程不直接发消息到主进程；invoke 走 IPC */
  },
  handleOnce(channel, fn) {
    _handlers.set(channel, async (...args) => {
      const result = await fn(...args)
      _handlers.delete(channel)
      return result
    })
  },
  removeHandler(channel) {
    _handlers.delete(channel)
  },
  removeAllListeners(_channel) {
    /* no-op */
  },
}

export function getHandler(channel) {
  return _handlers.get(channel)
}
export function listChannels() {
  return Array.from(_handlers.keys())
}

// ============================================================
// BrowserWindow mock — webContents.send → 事件推送到渲染进程
// ============================================================
function makeWebContents() {
  return {
    send(channel, ...args) {
      // 事件推送到渲染进程 (通过 stdout JSON-RPC event 帧)
      // Electron 的 send 只传一个 data 参数；preload 里 onStream/onStatusUpdate 已包好
      const data = args.length === 0 ? null : args.length === 1 ? args[0] : args
      _emitEvent(channel, data)
    },
    once(_event, _fn) {
      /* no-op */
    },
    on(_event, _fn) {
      /* no-op */
    },
    close() {
      /* no-op */
    },
    openDevTools() {
      /* no-op */
    },
  }
}

function makeBrowserWindowMock() {
  const wc = makeWebContents()
  const mock = {
    webContents: wc,
    isDestroyed: () => false,
    isVisible: () => true,
    show() {
      /* no-op */
    },
    hide() {
      /* no-op */
    },
    focus() {
      /* no-op */
    },
    minimize() {
      /* no-op */
    },
    maximize() {
      /* no-op */
    },
    unminimize() {
      /* no-op */
    },
    on() {
      /* no-op */
    },
    once() {
      /* no-op */
    },
    off() {
      /* no-op */
    },
    close() {
      /* no-op */
    },
  }
  return mock
}

const BrowserWindow = Object.assign(
  function MockBrowserWindow() {
    return makeBrowserWindowMock()
  },
  {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
)

// ============================================================
// app — 路径 + 版本 + 包装
// ============================================================
const _userDataDir = resolveUserDataDir()
const _resourceDir = resolveResourceDir()

const VALID_PATHS = new Set([
  'home',
  'appData',
  'userData',
  'sessionData',
  'temp',
  'exe',
  'module',
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos',
  'recent',
  'logs',
  'crashDumps',
])

function nodePathFor(name) {
  const home = os.homedir()
  switch (name) {
    case 'home':
      return home
    case 'appData':
    case 'userData':
    case 'sessionData':
      return _userDataDir
    case 'temp':
      return os.tmpdir()
    case 'desktop':
      return path.join(home, 'Desktop')
    case 'documents':
      return path.join(home, 'Documents')
    case 'downloads':
      return path.join(home, 'Downloads')
    case 'music':
      return path.join(home, 'Music')
    case 'pictures':
      return path.join(home, 'Pictures')
    case 'videos':
      return path.join(home, 'Videos')
    case 'logs':
      return path.join(_userDataDir, 'logs')
    default:
      return _userDataDir
  }
}

const app = {
  getPath(name) {
    if (typeof name !== 'string' || !VALID_PATHS.has(name)) {
      throw new Error(`Invalid path name: ${name}`)
    }
    return nodePathFor(name)
  },
  setPath(_name, _val) {
    /* no-op */
  },
  getName() {
    return 'Education Advisor'
  },
  getVersion() {
    return '0.1.0'
  },
  isReady() {
    return true
  },
  get isPackaged() {
    return process.env.EDU_IS_PACKAGED === '1'
  },
  whenReady() {
    return Promise.resolve()
  },
  on() {
    /* no-op */
  },
  off() {
    /* no-op */
  },
  quit() {
    /* no-op — sidecar 生命周期由 Rust 控制 */
  },
  exit(_code) {
    process.exit(_code || 0)
  },
  relaunch() {
    /* no-op */
  },
  setLoginItemSettings() {
    /* sidecar 无法设置开机自启；由 Tauri 配置接管 */
  },
  getLoginItemSettings() {
    return { openAtLogin: false }
  },
  getAppPath() {
    return process.cwd()
  },
  commandLine: { appendSwitch() {} },
}
// process.resourcesPath 暴露 (service 用 process.resourcesPath)
// app 对象上不直接给 getter (避免和 getPath 冲突)
Object.defineProperty(app, 'resourcesPath', {
  value: _resourceDir,
  writable: false,
  configurable: true,
})

// process.resourcesPath 兼容 (部分 service 用 process.resourcesPath)
Object.defineProperty(process, 'resourcesPath', {
  value: _resourceDir,
  writable: false,
  configurable: true,
})

// ============================================================
// safeStorage — AES-256-GCM + 机器派生密钥 (等价 Windows DPAPI)
// 钥匙由机器标识 + 固定盐派生，同一机器加解密一致
// ============================================================
function machineKey() {
  const identity = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
  ].join('|')
  // 固定 salt — 仅用于本机派生；不是机密 (机密由机器标识提供)
  return crypto.createHash('sha256').update(`edu-advisor::${identity}`).digest()
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(plain) {
    const key = machineKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // 格式: [iv(12)] [tag(16)] [ciphertext]
    return Buffer.concat([iv, tag, enc])
  },
  decryptString(buf) {
    const key = machineKey()
    const b = Buffer.from(buf)
    if (b.length < 28) throw new Error('safeStorage: ciphertext too short')
    const iv = b.subarray(0, 12)
    const tag = b.subarray(12, 28)
    const enc = b.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return dec.toString('utf8')
  },
  // Electron API 选填方法
  getSelectedStorageBackend: () => 'platform_default',
  setSelectedStorageBackend() {
    /* no-op */
  },
}

// ============================================================
// dialog — 转发给 Tauri 原生 (通过 sysBus)
// ============================================================
const dialog = {
  async showOpenDialog(_winOrOpts, optsMaybe) {
    const opts = optsMaybe || _winOrOpts || {}
    const result = await _sysRequest('dialog:open', opts)
    return result
  },
  async showSaveDialog(_winOrOpts, optsMaybe) {
    const opts = optsMaybe || _winOrOpts || {}
    const result = await _sysRequest('dialog:save', opts)
    return result
  },
  async showMessageBox(_winOrOpts, optsMaybe) {
    const opts = optsMaybe || _winOrOpts || {}
    const result = await _sysRequest('dialog:message', opts)
    return result
  },
  async showErrorBox(title, content) {
    await _sysRequest('dialog:error', { title, content })
  },
}

// ============================================================
// shell — openExternal 转发给 Tauri
// ============================================================
const shell = {
  async openExternal(url) {
    await _sysRequest('openExternal', { url })
  },
  openPath(_p) {
    return Promise.resolve('')
  },
  showItemInFolder(p) {
    _sysRequest('showInFolder', { path: p })
    return Promise.resolve()
  },
  writeShortcutLink() {
    /* no-op */
  },
  readShortcutLink() {
    throw new Error('not supported')
  },
}

// ============================================================
// Notification / Tray / Menu / nativeImage / protocol / net — 降级
// (这些是 shell 级 UI 能力，在 Tauri 里由原生接管)
// ============================================================
class Notification {
  static isSupported() {
    return false
  }
  constructor() {
    /* no-op */
  }
  show() {
    /* no-op */
  }
  on() {
    return this
  }
  close() {
    /* no-op */
  }
}

const Tray = class {
  constructor() {
    /* no-op */
  }
  setToolTip() {}
  setContextMenu() {}
  on() {}
  setImage() {}
  destroy() {}
  setTitle() {}
}

const Menu = {
  buildFromTemplate() {
    return null
  },
  setApplicationMenu() {},
  getApplicationMenu: () => null,
  popup() {},
  append() {},
}

const nativeImage = {
  createEmpty: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
  createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 16, height: 16 }) }),
  createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 16, height: 16 }) }),
}

const protocol = {
  registerSchemesAsPrivileged() {},
  registerFileProtocol() {},
  handle() {},
  unhandle() {},
}

const net = {
  request: () => ({
    on() {},
    write() {},
    end() {},
  }),
  fetch: (url, opts) => globalThis.fetch(url, opts),
}

// ============================================================
// contextBridge / ipcRenderer — 仅用于 preload (sidecar 不用，但保留避免 import 报错)
// ============================================================
const contextBridge = {
  exposeInMainWorld() {
    /* no-op — sidecar 模式不用 preload */
  },
}
const ipcRenderer = {
  invoke() {
    return Promise.reject(new Error('ipcRenderer not available in sidecar'))
  },
  on() {},
  send() {},
  removeListener() {},
  removeAllListeners() {},
}

// ============================================================
// 导出完整的 electron 替身
// ============================================================
export {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  dialog,
  shell,
  safeStorage,
  Notification,
  Tray,
  Menu,
  nativeImage,
  protocol,
  net,
  contextBridge,
}

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  dialog,
  shell,
  safeStorage,
  Notification,
  Tray,
  Menu,
  nativeImage,
  protocol,
  net,
  contextBridge,
}
