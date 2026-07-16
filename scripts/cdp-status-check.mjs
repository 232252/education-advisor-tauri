#!/usr/bin/env node
// =============================================================
// 快速查询当前数据规模 (学生数/事件数/ranking 耗时)
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://127.0.0.1:9222'

async function callApi(page, channel, ...args) {
  return await page.evaluate(async ({ ch, ag }) => {
    const t0 = performance.now()
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      const t1 = performance.now()
      return { ok: true, data: r, ms: t1 - t0 }
    } catch (e) {
      const t1 = performance.now()
      return { ok: false, error: e?.message || String(e), ms: t1 - t0 }
    }
  }, { ch: channel, ag: args })
}

async function main() {
  console.log('━━━ 数据规模检查 ━━━')
  const browser = await chromium.connectOverCDP(CDP_URL)
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]
  console.log(`页面: ${page.url()}\n`)

  // info 命令
  const info = await callApi(page, 'eaa:info')
  console.log(`eaa:info (${info.ms.toFixed(0)}ms)`)
  console.log(JSON.stringify(info.data?.data || info.data, null, 2))

  // list-students 计数
  const list = await callApi(page, 'eaa:list-students')
  const students = list.data?.data?.students || list.data?.data || []
  console.log(`\neaa:list-students (${list.ms.toFixed(0)}ms) = ${students.length} 学生`)

  // ranking 耗时
  const rank = await callApi(page, 'eaa:ranking', 10)
  console.log(`eaa:ranking(10) (${rank.ms.toFixed(0)}ms)`)

  // 找事件最多的学生(取前 5)
  const rankData = rank.data?.data?.ranking || rank.data?.data || []
  if (rankData.length > 0) {
    console.log('\nTop 5 排行:')
    for (const r of rankData.slice(0, 5)) {
      console.log(`  ${r.rank}. ${r.name} score=${r.score} delta=${r.delta}`)
    }
  }

  await browser.close()
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
