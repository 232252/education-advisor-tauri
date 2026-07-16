#!/usr/bin/env node
// 探测当前 window 上可用的 API
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
console.log('URL:', page.url())

const probe = await page.evaluate(() => {
  return {
    hasTauriInternals: typeof window.__TAURI_INTERNALS__,
    hasTauriAPI: typeof window.__TAURI__,
    hasApi: typeof window.api,
    apiKeys: window.api ? Object.keys(window.api) : null,
    eaaMethods: window.api?.eaa ? Object.keys(window.api.eaa) : null,
  }
})
console.log(JSON.stringify(probe, null, 2))

// 试两种调用
const try1 = await page.evaluate(async () => {
  try {
    const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'eaa:info', args: [] })
    return { method: 'tauri', ok: true, data: r }
  } catch (e) { return { method: 'tauri', ok: false, err: e?.message || String(e) } }
})
console.log('Tauri invoke:', JSON.stringify(try1).slice(0, 200))

const try2 = await page.evaluate(async () => {
  try {
    const r = await window.api.eaa.info()
    return { method: 'electron-api', ok: true, data: r }
  } catch (e) { return { method: 'electron-api', ok: false, err: e?.message || String(e) } }
})
console.log('Electron api:', JSON.stringify(try2).slice(0, 200))

await browser.close()
