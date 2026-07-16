// =============================================================
// CDP Tauri 持续循环测试 — 交替运行 deep + edge 测试
// 持续多轮运行直到手动停止 (Ctrl+C) 或达到 MAX_ROUNDS
// =============================================================
import { execSync } from 'child_process'
import fs from 'fs'

const TESTS = [
  { name: 'deep', script: 'scripts/cdp-tauri-deep.mjs' },
  { name: 'edge', script: 'scripts/cdp-tauri-edge.mjs' },
]

const MAX_ROUNDS = 200
const LOG_FILE = 'test-results/cdp-tauri-loop.log'

function ts() { return new Date().toISOString() }

function appendLog(text) {
  fs.appendFileSync(LOG_FILE, text + '\n')
}

function main() {
  const startTime = Date.now()
  let totalPass = 0
  let totalFail = 0

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  CDP Tauri 持续循环测试 — deep + edge 交替        ║')
  console.log('╚══════════════════════════════════════════════════╝\n')

  appendLog(`\n${ts()} === 持续循环测试启动 ===`)

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const test of TESTS) {
      const testStart = Date.now()
      console.log(`\n▶ [轮 ${round}] 运行 ${test.name}...`)
      appendLog(`${ts()} ▶ [轮 ${round}] ${test.name} 开始`)

      try {
        const output = execSync(`node ${test.script}`, {
          encoding: 'utf8',
          timeout: 300000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const elapsed = ((Date.now() - testStart) / 1000).toFixed(1)

        // 解析结果
        const match = output.match(/总计:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
        const pass = match ? parseInt(match[1]) : 0
        const fail = match ? parseInt(match[2]) : 0
        totalPass += pass
        totalFail += fail

        const status = fail === 0 ? '✅' : '❌'
        console.log(`${status} [轮 ${round}] ${test.name}: ${pass}通过/${fail}失败 (${elapsed}s)`)
        appendLog(`${ts()} ${status} [轮 ${round}] ${test.name}: ${pass}通过/${fail}失败 (${elapsed}s)`)

        if (fail > 0) {
          const failLines = output.split('\n').filter(l => l.includes('✗'))
          for (const fl of failLines) {
            appendLog(`${ts()}   ${fl.trim()}`)
          }
        }
      } catch (e) {
        const elapsed = ((Date.now() - testStart) / 1000).toFixed(1)
        const errOut = e.stdout ? e.stdout.slice(-500) : ''
        console.log(`❌ [轮 ${round}] ${test.name}: 执行失败 (${elapsed}s)`)
        appendLog(`${ts()} ❌ [轮 ${round}] ${test.name}: 执行失败 (${elapsed}s)`)
        appendLog(`${ts()}   error: ${(e.message || '').slice(0, 200)}`)
        if (errOut) appendLog(`${ts()}   stdout_tail: ${errOut.replace(/\n/g, ' | ').slice(0, 300)}`)
        totalFail++
      }

      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  累计: ${totalPass}通过 / ${totalFail}失败 (${round}轮, ${totalElapsed}s)`)
      appendLog(`${ts()}   累计: ${totalPass}通过 / ${totalFail}失败 (${round}轮, ${totalElapsed}s)`)
      appendLog(`${ts()} ---`)
    }
  }

  appendLog(`${ts()} === 持续循环测试结束 === ${totalPass}通过/${totalFail}失败 (${MAX_ROUNDS}轮)`)
  console.log(`\n╔══════════════════════════════════════════════════╗`)
  console.log(`║  完成: ${totalPass}通过 / ${totalFail}失败 / ${MAX_ROUNDS}轮`.padEnd(50) + '║')
  console.log('╚══════════════════════════════════════════════════╝')
}

main()
