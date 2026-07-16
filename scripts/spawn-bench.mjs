#!/usr/bin/env node
// 直接 spawn EAA 二进制,测量纯 spawn 开销(排除 IPC/渲染进程通信)
import spawn from 'cross-spawn'
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const LOG = 'test-results/spawn-bench.log'
function out(m) { console.log(m); appendFileSync(LOG, m + '\n') }

// EAA 二进制路径
const BIN = path.join(process.cwd(), 'resources', 'eaa-binaries', 'win32-x64', 'eaa.exe')
const DATA_DIR = path.join(process.env.APPDATA, 'Education Advisor', 'eaa-data')

if (!existsSync(BIN)) {
  console.error('EAA binary not found:', BIN)
  process.exit(1)
}

out(`╔══════════════════════════════════════════════════╗`)
out(`║  Spawn 直接基准测试                              ║`)
out(`║  ${new Date().toISOString()}`)
out(`║  BIN: ${BIN}`)
out(`║  DATA: ${DATA_DIR}`)
out(`╚══════════════════════════════════════════════════╝\n`)

function spawnEaa(args) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const chunks = []
    const proc = spawn(BIN, args, {
      cwd: DATA_DIR,
      env: { ...process.env, EAA_DATA_DIR: DATA_DIR },
      windowsHide: true,
    })
    proc.stdout?.on('data', (c) => chunks.push(c))
    proc.stderr?.on('data', () => {})
    proc.on('exit', (code) => {
      const t1 = process.hrtime.bigint()
      const ms = Number(t1 - t0) / 1e6
      const stdout = Buffer.concat(chunks).toString('utf-8')
      resolve({ ms, exitCode: code, stdoutLen: stdout.length })
    })
    proc.on('close', (code) => {
      const t1 = process.hrtime.bigint()
      const ms = Number(t1 - t0) / 1e6
      const stdout = Buffer.concat(chunks).toString('utf-8')
      resolve({ ms, exitCode: code, stdoutLen: stdout.length, event: 'close' })
    })
  })
}

async function bench(label, args, runs = 3) {
  out(`━━━ ${label} (${runs}次) ━━━`)
  for (let i = 1; i <= runs; i++) {
    const r = await spawnEaa(args)
    out(`  #${i}: ${r.ms.toFixed(0)}ms exit=${r.exitCode} stdout=${r.stdoutLen}B event=${r.event || 'exit'}`)
  }
  out('')
}

async function main() {
  // 1. info (轻量查询)
  await bench('info', ['info', '--output', 'json'])

  // 2. ranking 100 (LightContext, 不加载 events)
  await bench('ranking 100', ['ranking', '100', '--output', 'json'])

  // 3. ranking all (全部学生)
  await bench('ranking all', ['ranking', '--output', 'json'])

  // 4. list-students
  await bench('list-students', ['list-students', '--output', 'json'])

  // 5. score (需要 DataContext, 加载 events)
  await bench('score R37_王五_670460', ['score', 'R37_王五_670460', '--output', 'json'])

  // 6. summary (需要 DataContext)
  await bench('summary', ['summary', '--output', 'json'])

  // 7. 连续 spawn 10 次(测冷启动 vs 热启动)
  out('━━━ 连续 spawn ranking 10次(冷/热启动)━━━')
  for (let i = 1; i <= 10; i++) {
    const r = await spawnEaa(['ranking', '10', '--output', 'json'])
    out(`  #${i}: ${r.ms.toFixed(0)}ms`)
  }

  out('\n╔══════════════════════════════════════════════════╗')
  out('║  对比: 直接 CLI vs IPC                          ║')
  out('╚══════════════════════════════════════════════════╝')
  out('  IPC ranking(优化后): ~2449ms')
  out('  直接 spawn ranking: 见上方数据')
  out('  如果直接 spawn ~2400ms → 瓶颈在 EAA 二进制/cross-spawn')
  out('  如果直接 spawn ~100ms  → 瓶颈在 Node.js IPC 层')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
