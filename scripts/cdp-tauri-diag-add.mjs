// 诊断脚本: 探测 add-event 失败原因
// 连续调用 5 次 add-event 同一学生同一 reasonCode(--force), 打印完整返回
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const page = browser.contexts()[0].pages()[0]
  const stu = `Diag_${Date.now()}`
  console.log(`诊断学生: ${stu}`)

  // 1. 创建学生
  const r0 = await page.evaluate(async ({ ch, ag }) => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) { return { ok: false, error: e?.message || String(e) } }
  }, { ch: 'eaa:add-student', ag: [stu] })
  console.log('add-student:', JSON.stringify(r0).slice(0, 500))

  // 2. 连续 5 次 add-event(--force)
  for (let i = 0; i < 5; i++) {
    const r = await page.evaluate(async ({ ch, ag }) => {
      const t0 = performance.now()
      try {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
        const t1 = performance.now()
        return { ok: true, data: r, ms: t1 - t0 }
      } catch (e) {
        const t1 = performance.now()
        return { ok: false, error: e?.message || String(e), ms: t1 - t0 }
      }
    }, { ch: 'eaa:add-event', ag: [{ studentName: stu, reasonCode: 'SPEAK_IN_CLASS', force: true, note: `diag#${i}` }] })
    console.log(`add-event #${i + 1}: ms=${r.ms?.toFixed(0)} ok=${r.ok} data/error=${JSON.stringify(r.ok ? r.data : r.error).slice(0, 600)}`)
  }

  // 3. 查 history 看实际记录了多少
  const hist = await page.evaluate(async ({ ch, ag }) => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) { return { ok: false, error: e?.message || String(e) } }
  }, { ch: 'eaa:history', ag: [stu] })
  console.log('history 返回:', JSON.stringify(hist).slice(0, 1500))

  await browser.close()
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
