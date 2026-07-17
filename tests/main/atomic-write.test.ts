// =============================================================
// AtomicWrite 并发安全 / 容错测试 — 仅测不改
// 用项目自带的 vitest 基础设施（main environment = node）
// 直接 import 源码 src/main/utils/atomic-write.ts
//
// 场景：
//   1. 同文件并发 100 次写 — 最终内容应是某一个完整 version,不拼接/不损坏,且无 .tmp 残留
//   2. 写 + 读并发 — 读到的始终是某个完整版本,不能读到半写内容
//   3. 大文件 5MB — 不超时/不损坏
//   4. EPERM 模拟 — renameWithRetry 的重试逻辑触发,最终成功
// =============================================================

import fsp from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { atomicWrite } from '../../src/main/utils/atomic-write'
import fspLib from 'node:fs/promises'

const tmpRoot = path.join(
  os.tmpdir(),
  `atomic-write-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
)

beforeAll(async () => {
  await fspLib.mkdir(tmpRoot, { recursive: true })
})

afterAll(async () => {
  try {
    await fspLib.rm(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('atomicWrite 并发安全', () => {
  it('s1: 同一文件并发写 100 次', async () => {
    const target = path.join(tmpRoot, 's1-file.txt')
    const N = 100
    const tasks: Array<Promise<unknown>> = []
    for (let i = 0; i < N; i++) {
      tasks.push(atomicWrite(target, `content-${i}`))
    }
    const results = await Promise.allSettled(tasks)
    const failures = results.filter((r) => r.status === 'rejected')
    // 允许部分失败(并发场景下 fsp.rename 在 Windows 上确实可能 EPERM 撞窗口),
    // 但不允许"全部失败"或"非空损坏残留"
    expect(failures.length).toBeLessThan(N)

    // 文件必须存在
    expect(fss.existsSync(target)).toBe(true)
    const buf = (await fsp.readFile(target, 'utf-8')).trim()
    // 必须是某一个 content-i
    const m = buf.match(/^content-(\d+)$/)
    expect(m).not.toBeNull()
    if (m) {
      const idx = parseInt(m[1], 10)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(N)
    }
    // 等 fire-and-forget unlink 完成
    await new Promise((r) => setTimeout(r, 200))
    const leftover = (await fsp.readdir(tmpRoot)).filter((f) => f.includes('.tmp.'))
    expect(leftover).toEqual([])
  })

  it('s2: 并发写 + 读，读到的应是完整版本', async () => {
    const target = path.join(tmpRoot, 's2-file.txt')
    await fsp.writeFile(target, 'init')

    const N_WRITES = 50
    const N_READS = 50
    const WRITER_PAYLOAD_LEN = 103 // 'v' + 1-2 位 idx + '-' + 100 个 'x'

    const writers: Array<Promise<unknown>> = []
    for (let i = 0; i < N_WRITES; i++) {
      writers.push(atomicWrite(target, `v${i}-${'x'.repeat(100)}`))
    }
    const readers: Array<Promise<{ len: number; head: string }>> = []
    for (let i = 0; i < N_READS; i++) {
      readers.push(
        (async () => {
          const buf = await fsp.readFile(target, 'utf-8')
          return { len: buf.length, head: buf.slice(0, 4) }
        })(),
      )
    }
    const results = await Promise.allSettled([...writers, ...readers])
    const readResults = results.slice(N_WRITES)
    let partial = 0
    let initReads = 0
    let lenSamples: number[] = []
    let headSamples: string[] = []
    for (const r of readResults) {
      if (r.status === 'rejected') {
        partial++
        continue
      }
      const v = r.value
      if (lenSamples.length < 5) lenSamples.push(v.len)
      if (headSamples.length < 5) headSamples.push(v.head)
      // 读到初始 'init' (4 字节) 是允许的 — 因为初始文件存在
      if (v.len === 4 && v.head === 'init') {
        initReads++
        continue
      }
      // 完整 payload 长度 = 'v' + 数字位 + '-' + 100 'x' = 103 (v0..v9) / 104 (v10..v49)
      // 不允许 <100 (短于完整 v0),也不允许 >110
      if (v.len < 100 || v.len > 110) partial++
      if (!v.head.startsWith('v')) partial++
    }
    if (partial > 0) {
      // 输出调试信息:打印实际读到的长度/头
      console.log(`[s2 debug] partial=${partial}, initReads=${initReads}, lenSamples=[${lenSamples.join(',')}], headSamples=[${headSamples.join('|')}]`)
    }
    expect(partial).toBe(0)
  })

  it('s3: 写 5MB 大文件不超时/不损坏', async () => {
    const target = path.join(tmpRoot, 's3-big.bin')
    const buf = Buffer.alloc(5 * 1024 * 1024, 0x41)
    const t0 = Date.now()
    await atomicWrite(target, buf)
    const elapsed = Date.now() - t0
    const stat = await fsp.stat(target)
    expect(stat.size).toBe(buf.length)
    // 头/尾 1KB 抽样比较,确保字节完全一致(不是拼接的损坏内容)
    const head = (await fsp.readFile(target)).subarray(0, 1024)
    const tail = (await fsp.readFile(target)).subarray(-1024)
    expect(head.equals(Buffer.alloc(1024, 0x41))).toBe(true)
    expect(tail.equals(Buffer.alloc(1024, 0x41))).toBe(true)
    expect(elapsed).toBeLessThan(10000)
  })

  it('s4: renameWithRetry 在 EPERM 时触发重试', async () => {
    const target = path.join(tmpRoot, 's4-eperm.txt')
    // 用 monkey patch 拦截 fsp.rename, 第 1 次抛 EPERM
    const realRename = fspLib.rename.bind(fspLib)
    let attempts = 0
    // @ts-expect-error - 强制覆盖
    fspLib.rename = async (src: string, dest: string) => {
      attempts++
      if (attempts === 1) {
        const err = new Error('mock EPERM') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return realRename(src, dest)
    }
    let okAfterRetry = false
    try {
      await atomicWrite(target, 'ok-after-retry')
      okAfterRetry = fss.existsSync(target)
    } finally {
      // @ts-expect-error - 还原
      fspLib.rename = realRename
    }
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(okAfterRetry).toBe(true)
  })
})
