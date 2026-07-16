// =============================================================
// Electron 垫片 (Shim) — TypeScript 版
// 让原本依赖 Electron 的 services / handlers 在纯 Node.js sidecar
// 进程里零改动运行。
//
// 通过 vite.config.sidecar.ts 的 resolve.alias 把 'electron' 指向此文件。
// =============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---- 由 sidecar 主入口注入的"事件出口"和"系统请求"通道 ----
let _emitEvent = async (_channel: string, _data: unknown): Promise<void> => {}
let _sysRequest = async (
  _request: string,
  _args: unknown,
): Promise<{ success: boolean; data?: unknown; error?: string }> => ({
  success: false,
  error: 'sys bus not connected',
})

export function setOutbound(opts: {
  emitEvent: (channel: string, data: unknown) => void | Promise<void>
  sysRequest: (
    request: string,
    args: unknown,
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
}) {
  if (typeof opts.emitEvent === 'function') {
    const fn = opts.emitEvent
    _emitEvent = (c, d) => Promise.resolve(fn(c, d))
  }
  if (typeof opts.sysRequest === 'function') _sysRequest = opts.sysRequest
}

// ---- userData 目录解析 (Tauri 通过环境变量传入) ----
function resolveUserDataDir(): string {
  if (process.env.EDU_APP_DATA_DIR) return process.env.EDU_APP_DATA_DIR
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

function resolveResourceDir(): string {
  if (process.env.EDU_RESOURCE_DIR) return process.env.EDU_RESOURCE_DIR
  return process.cwd()
}

const _userDataDir = resolveUserDataDir()
const _resourceDir = resolveResourceDir()

// ============================================================
// ipcMain — 把所有 handle 调用注册到路由表
// 同时维护一个进程内事件总线，支持 emit/on 跨 handler 通信
// (eaa-handlers 用 ipcMain.emit('__invalidate_students_cache') 触发缓存失效)
// ============================================================
type HandlerFn = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
const _handlers = new Map<string, HandlerFn>()
// 进程内事件监听器 (channel → listeners[])
const _listeners = new Map<string, Array<(...args: unknown[]) => void>>()

const ipcMain = {
  handle(channel: string, fn: HandlerFn) {
    _handlers.set(channel, fn)
  },
  handleOnce(channel: string, fn: HandlerFn) {
    const wrapped: HandlerFn = async (...args) => {
      const result = await fn(...args)
      _handlers.delete(channel)
      return result
    }
    _handlers.set(channel, wrapped)
  },
  // 进程内事件: 注册监听器 (与 Electron ipcMain.on 语义一致)
  on(channel: string, listener: (...args: unknown[]) => void) {
    if (!_listeners.has(channel)) _listeners.set(channel, [])
    _listeners.get(channel)?.push(listener)
    return ipcMain
  },
  once(channel: string, listener: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      ipcMain.removeListener(channel, wrapped)
      listener(...args)
    }
    ipcMain.on(channel, wrapped)
    return ipcMain
  },
  // 进程内事件: 触发所有监听器 (Electron 同步触发)
  emit(channel: string, ...args: unknown[]) {
    const list = _listeners.get(channel)
    if (list) {
      for (const fn of list.slice()) {
        try {
          fn({ sender: ipcMain }, ...args)
        } catch (e) {
          process.stderr.write(`[shim] ipcMain.emit listener error on "${channel}": ${e}\n`)
        }
      }
    }
  },
  removeListener(channel: string, listener: (...args: unknown[]) => void) {
    const list = _listeners.get(channel)
    if (list) {
      const idx = list.indexOf(listener)
      if (idx >= 0) list.splice(idx, 1)
    }
    return ipcMain
  },
  removeAllListeners(channel?: string) {
    if (channel) _listeners.delete(channel)
    else _listeners.clear()
    return ipcMain
  },
  removeHandler(channel: string) {
    _handlers.delete(channel)
  },
  // Electron 兼容: listenerCount
  listenerCount(channel: string) {
    return _listeners.get(channel)?.length || 0
  },
}

export function getHandler(channel: string): HandlerFn | undefined {
  return _handlers.get(channel)
}
export function listChannels(): string[] {
  return Array.from(_handlers.keys())
}

// ============================================================
// BrowserWindow mock — webContents.send → 事件推送到渲染进程
// ============================================================
function makeWebContents() {
  return {
    send(channel: string, ...args: unknown[]) {
      const data = args.length === 0 ? null : args.length === 1 ? args[0] : args
      _emitEvent(channel, data)
    },
    once() {
      /* no-op */
    },
    on() {
      /* no-op */
    },
    close() {
      /* no-op */
    },
    openDevTools() {
      /* no-op */
    },
    setWindowOpenHandler() {
      /* no-op */
    },
  }
}

class BrowserWindowMock {
  webContents = makeWebContents()
  isDestroyed() {
    return false
  }
  isVisible() {
    return true
  }
  show() {
    /* no-op */
  }
  hide() {
    /* no-op */
  }
  focus() {
    /* no-op */
  }
  minimize() {
    /* no-op */
  }
  maximize() {
    /* no-op */
  }
  unminimize() {
    /* no-op */
  }
  setFocusable() {
    /* no-op */
  }
  on() {
    return this
  }
  once() {
    return this
  }
  off() {
    return this
  }
  close() {
    /* no-op */
  }
}

// Electron 的 BrowserWindow 既是类也带静态方法
const BrowserWindow = Object.assign(
  function MockBrowserWindowCtor() {
    return new BrowserWindowMock()
  },
  {
    getAllWindows: () => [] as BrowserWindowMock[],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
)

// ============================================================
// app — 路径 + 版本 + 包装
// ============================================================
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

function nodePathFor(name: string): string {
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
  getPath(name: string): string {
    if (typeof name !== 'string' || !VALID_PATHS.has(name)) {
      throw new Error(`Invalid path name: ${name}`)
    }
    return nodePathFor(name)
  },
  setPath() {
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
    return app
  },
  off() {
    return app
  },
  quit() {
    /* no-op — sidecar 生命周期由 Rust 控制 */
  },
  exit(code?: number) {
    process.exit(code || 0)
  },
  relaunch() {
    /* no-op */
  },
  setLoginItemSettings() {
    /* 由 Tauri 配置接管 */
  },
  getLoginItemSettings() {
    return { openAtLogin: false }
  },
  getAppPath() {
    return process.cwd()
  },
  commandLine: { appendSwitch() {} },
}
// process.resourcesPath 兼容 (部分 service 用 process.resourcesPath)
Object.defineProperty(app, 'resourcesPath', {
  value: _resourceDir,
  writable: false,
  configurable: true,
})
Object.defineProperty(process, 'resourcesPath', {
  value: _resourceDir,
  writable: false,
  configurable: true,
})

// ============================================================
// safeStorage — AES-256-GCM + 机器派生密钥 (等价 Windows DPAPI)
// ============================================================
function machineKey(): Buffer {
  const identity = [os.hostname(), os.userInfo().username, os.platform(), os.arch()].join('|')
  return crypto.createHash('sha256').update(`edu-advisor::${identity}`).digest()
}

const safeStorage = {
  isEncryptionAvailable() {
    return true
  },
  encryptString(plain: string): Buffer {
    const key = machineKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc])
  },
  decryptString(buf: Uint8Array | Buffer): string {
    const key = machineKey()
    const b = Buffer.from(buf as Uint8Array)
    if (b.length < 28) throw new Error('safeStorage: ciphertext too short')
    const iv = b.subarray(0, 12)
    const tag = b.subarray(12, 28)
    const enc = b.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return dec.toString('utf8')
  },
  getSelectedStorageBackend() {
    return 'platform_default'
  },
  setSelectedStorageBackend() {
    /* no-op */
  },
}

// ============================================================
// dialog — 转发给 Tauri 原生 (通过 sysBus)
// ============================================================
const dialog = {
  async showOpenDialog(winOrOpts?: unknown, optsMaybe?: unknown) {
    const opts = (optsMaybe || winOrOpts || {}) as Record<string, unknown>
    const r = await _sysRequest('dialog:open', opts)
    return r.data || { canceled: true, filePaths: [] }
  },
  async showSaveDialog(winOrOpts?: unknown, optsMaybe?: unknown) {
    const opts = (optsMaybe || winOrOpts || {}) as Record<string, unknown>
    const r = await _sysRequest('dialog:save', opts)
    return r.data || { canceled: true, filePath: '' }
  },
  async showMessageBox(winOrOpts?: unknown, optsMaybe?: unknown) {
    const opts = (optsMaybe || winOrOpts || {}) as Record<string, unknown>
    const r = await _sysRequest('dialog:message', opts)
    return r.data || { response: 0, checkboxChecked: false }
  },
  async showErrorBox(title: string, content: string) {
    await _sysRequest('dialog:error', { title, content })
  },
}

// ============================================================
// shell — openExternal 转发给 Tauri
// ============================================================
const shell = {
  async openExternal(url: string) {
    await _sysRequest('openExternal', { url })
  },
  openPath() {
    return Promise.resolve('')
  },
  showItemInFolder(p: string) {
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
// Notification / Tray / Menu / nativeImage / protocol / net — 降级 no-op
// ============================================================
class Notification {
  static isSupported() {
    return false
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

class Tray {
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
  getApplicationMenu() {
    return null
  },
  popup() {},
  append() {},
}

const nativeImage = {
  createEmpty() {
    return makeImgStub(true, 0, 0)
  },
  createFromPath() {
    return makeImgStub(false, 16, 16)
  },
  createFromBuffer() {
    return makeImgStub(false, 16, 16)
  },
}

// nativeImage 对象需支持 resize() / getSize() / isEmpty() / toDataURL() / toBitmap()
// (tray-service 和 settings:reset 会调用 resize)
function makeImgStub(empty: boolean, w: number, h: number) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width: w, height: h }),
    resize: (_opts?: { width?: number; height?: number; quality?: string }) =>
      makeImgStub(empty, _opts?.width || w, _opts?.height || h),
    setAspectRatio: () => {},
    toDataURL: () => 'data:image/png;base64,',
    toBitmap: () => Buffer.alloc(0),
    getAspectRatio: () => 1,
    addRepresentation: () => {},
    getNativeHandle: () => Buffer.alloc(0),
    isMacTemplateImage: () => false,
    setTemplateImage: () => {},
  }
}

const protocol = {
  registerSchemesAsPrivileged() {},
  registerFileProtocol() {},
  handle() {},
  unhandle() {},
}

const net = {
  request() {
    return { on() {}, write() {}, end() {} }
  },
  fetch(url: string, opts?: RequestInit) {
    return globalThis.fetch(url, opts)
  },
}

const contextBridge = {
  exposeInMainWorld() {
    /* no-op */
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
// 导出 (Electron 模块的子集)
// ============================================================
export {
  app,
  BrowserWindow,
  contextBridge,
  dialog,
  ipcMain,
  ipcRenderer,
  Menu,
  Notification,
  nativeImage,
  net,
  protocol,
  safeStorage,
  shell,
  Tray,
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
