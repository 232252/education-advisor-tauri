// 性能验证: 连续 add 20 次, 看 ms 趋势(优化后应该接近常数, 不再线性增长)
import { spawn } from 'cross-spawn'
import { existsSync } from 'node:fs'
import path from 'node:path'

const bin = path.resolve('resources/eaa-binaries/win32-x64/eaa.exe')
const dataDir = path.join(process.env.APPDATA, 'com.educationadvisor.tauri', 'eaa-data')
const env = { ...process.env, EAA_DATA_DIR: dataDir }
const stu = `PerfTest_${Date.now()}`

function run(args) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const proc = spawn(bin, args, { cwd: dataDir, env, windowsHide: true, timeout: 30000 })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => { stdout += c })
    proc.stderr.on('data', (c) => { stderr += c })
    proc.on('close', (code) => resolve({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - t0 }))
  })
}

console.log(`stu: ${stu}`)
console.log(`events.jsonl exists: ${existsSync(path.join(dataDir, 'events/events.jsonl'))}`)
console.log(`events.json exists: ${existsSync(path.join(dataDir, 'events/events.json'))}`)

console.log('\n--- 1. add-student ---')
const r0 = await run(['add-student', stu])
console.log(`exit=${r0.exitCode} ms=${r0.ms} out=${r0.stdout}`)

console.log('\n--- 2. 连续 add 20 次(--force) ---')
const timings = []
for (let i = 0; i < 20; i++) {
  const r = await run(['add', stu, 'SPEAK_IN_CLASS', '--delta', '-2', '--note', `perf#${i}`, '--force'])
  timings.push(r.ms)
  const ok = r.exitCode === 0
  console.log(`#${String(i + 1).padStart(2)}: ms=${String(r.ms).padStart(4)} exit=${r.exitCode} ${ok ? '✓' : '✗ ' + r.stderr.slice(0, 80)}`)
}

const avg = timings.reduce((s, t) => s + t, 0) / timings.length
const min = Math.min(...timings)
const max = Math.max(...timings)
const first5 = timings.slice(0, 5).reduce((s, t) => s + t, 0) / 5
const last5 = timings.slice(-5).reduce((s, t) => s + t, 0) / 5
console.log(`\n汇总: avg=${avg.toFixed(0)}ms min=${min}ms max=${max}ms`)
console.log(`趋势: 首5=${first5.toFixed(0)}ms → 末5=${last5.toFixed(0)}ms (增长${(last5 / first5).toFixed(2)}x)`)

console.log(`\nevents.jsonl exists: ${existsSync(path.join(dataDir, 'events/events.jsonl'))}`)
console.log(`events.json exists: ${existsSync(path.join(dataDir, 'events/events.json'))}`)

// 查看 events.jsonl 行数
import { readFileSync, statSync } from 'node:fs'
const jsonlPath = path.join(dataDir, 'events/events.jsonl')
if (existsSync(jsonlPath)) {
  const content = readFileSync(jsonlPath, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim().length > 0).length
  const sizeKB = statSync(jsonlPath).size / 1024
  console.log(`events.jsonl: ${lines} 行, ${sizeKB.toFixed(1)} KB`)
}
