// 直接 spawn EAA 二进制, 验证 --force 是否真的能绕过重复事件检测
import { spawn } from 'cross-spawn'
import { existsSync } from 'node:fs'
import path from 'node:path'

const bin = path.resolve('resources/eaa-binaries/win32-x64/eaa.exe')
// Tauri identifier = com.educationadvisor.tauri, userData = %APPDATA%/com.educationadvisor.tauri
const dataDir = path.join(process.env.APPDATA, 'com.educationadvisor.tauri', 'eaa-data')
const env = { ...process.env, EAA_DATA_DIR: dataDir }
const stu = `CmdTest_${Date.now()}`

function run(args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: dataDir, env, windowsHide: true, timeout: 10000 })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => { stdout += c })
    proc.stderr.on('data', (c) => { stderr += c })
    proc.on('close', (code) => resolve({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

console.log(`EAA binary: ${existsSync(bin) ? 'EXISTS' : 'MISSING'}`)
console.log(`dataDir: ${dataDir}`)
console.log(`stu: ${stu}\n`)

console.log('--- 1. add-student ---')
console.log(JSON.stringify(await run(['add-student', stu]), null, 2))

console.log('\n--- 2. add (1st, no force) ---')
console.log(JSON.stringify(await run(['add', stu, 'SPEAK_IN_CLASS', '--delta', '-2', '--note', 'first']), null, 2))

console.log('\n--- 3. add (2nd, no force, 应失败) ---')
console.log(JSON.stringify(await run(['add', stu, 'SPEAK_IN_CLASS', '--delta', '-2', '--note', 'second']), null, 2))

console.log('\n--- 4. add (3rd, --force, 应成功) ---')
console.log(JSON.stringify(await run(['add', stu, 'SPEAK_IN_CLASS', '--delta', '-2', '--note', 'third', '--force']), null, 2))

console.log('\n--- 5. add (4th, --force, 应成功) ---')
console.log(JSON.stringify(await run(['add', stu, 'SPEAK_IN_CLASS', '--delta', '-2', '--note', 'fourth', '--force']), null, 2))

console.log('\n--- 6. history ---')
const h = await run(['history', stu, '--output', 'json'])
console.log(h.stdout.slice(0, 2000))
