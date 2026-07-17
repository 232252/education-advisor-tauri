// =============================================================
// Ollama Service 测试 — 本地 LLM 运行时管理
// 覆盖：isServeRunning/listModels/pullModel(NDJSON流)/deleteModel（HTTP 部分）
//       detect/resetDetection 缓存行为、RECOMMENDED_MODELS 数据校验
// 模式：vi.spyOn(globalThis, 'fetch') mock Response + mock electron + mock spawn
// =============================================================

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// mock electron（resolveBinaryPath 用 app.isPackaged + process.resourcesPath）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp') },
}))

// mock logger（避免 electron 耦合）
vi.mock('../../src/main/utils/logger', () => ({ log: vi.fn() }))

// mock spawn（detect/startServe 用）
const mockSpawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: mockSpawn }))

const { ollamaService, RECOMMENDED_MODELS, OLLAMA_BASE_URL, KEYLESS_PROVIDERS } = await import(
  '../../src/main/services/ollama-service'
)

class MockChildProcess extends EventEmitter {
  pid = 12345
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill() {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function ndjsonStream(lines: unknown[]): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ollamaService.resetDetection()
  fetchSpy = vi.spyOn(globalThis, 'fetch')
  mockSpawn.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// =============================================================
// 常量与数据校验
// =============================================================
describe('常量与 RECOMMENDED_MODELS', () => {
  it('OLLAMA_BASE_URL 固定本地 11434', () => {
    expect(OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434')
  })

  it('KEYLESS_PROVIDERS 含 ollama', () => {
    expect(KEYLESS_PROVIDERS.has('ollama')).toBe(true)
  })

  it('RECOMMENDED_MODELS 每项字段完整', () => {
    expect(RECOMMENDED_MODELS.length).toBeGreaterThanOrEqual(3)
    for (const m of RECOMMENDED_MODELS) {
      expect(m.tag).toBeTruthy()
      expect(m.name).toBeTruthy()
      expect(m.sizeLabel).toBeTruthy()
      expect(['优秀', '良好', '一般']).toContain(m.chineseLevel)
      expect(['CPU入门', 'CPU进阶', 'GPU/大内存']).toContain(m.tier)
      expect(m.description).toBeTruthy()
      expect(m.manualUrls.length).toBeGreaterThan(0)
      expect(m.manualUrls.every((u) => u.label && u.url)).toBe(true)
    }
  })

  it('RECOMMENDED_MODELS 含 Qwen3 系列（中文友好）', () => {
    expect(RECOMMENDED_MODELS.some((m) => m.tag.startsWith('qwen3'))).toBe(true)
  })

  it('RECOMMENDED_MODELS 含 CPU入门档', () => {
    expect(RECOMMENDED_MODELS.some((m) => m.tier === 'CPU入门')).toBe(true)
  })
})

// =============================================================
// isServeRunning
// =============================================================
describe('isServeRunning', () => {
  it('serve 在运行（fetch ok）时返回 true', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [] }, 200))
    expect(await ollamaService.isServeRunning()).toBe(true)
  })

  it('fetch 返回非 ok 时返回 false', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, 500))
    expect(await ollamaService.isServeRunning()).toBe(false)
  })

  it('fetch 异常时返回 false（不抛出）', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await ollamaService.isServeRunning()).toBe(false)
  })
})

// =============================================================
// listModels
// =============================================================
describe('listModels', () => {
  it('返回模型列表', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        models: [
          { name: 'qwen3:1.7b', size: 1000, digest: 'abc', details: { family: 'qwen3' } },
        ],
      }),
    )
    const models = await ollamaService.listModels()
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('qwen3:1.7b')
  })

  it('空模型列表返回空数组', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [] }))
    expect(await ollamaService.listModels()).toEqual([])
  })

  it('无 models 字段时返回空数组', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}))
    expect(await ollamaService.listModels()).toEqual([])
  })

  it('fetch 异常时返回空数组', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'))
    expect(await ollamaService.listModels()).toEqual([])
  })

  it('fetch 非 ok 时返回空数组', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, 404))
    expect(await ollamaService.listModels()).toEqual([])
  })
})

// =============================================================
// pullModel（NDJSON 流式）
// =============================================================
describe('pullModel', () => {
  it('成功拉取并解析流式进度', async () => {
    fetchSpy.mockResolvedValue(
      ndjsonStream([
        { status: 'pulling manifest' },
        { status: 'downloading', completed: 50, total: 100 },
        { status: 'success' },
      ]),
    )
    const progress: { status: string }[] = []
    const res = await ollamaService.pullModel('qwen3:1.7b', (p) => progress.push(p))
    expect(res.success).toBe(true)
    expect(progress.map((p) => p.status)).toEqual(['pulling manifest', 'downloading', 'success'])
  })

  it('进度回调含 completed/total', async () => {
    fetchSpy.mockResolvedValue(
      ndjsonStream([{ status: 'downloading', completed: 30, total: 200, digest: 'sha256:xyz' }]),
    )
    let captured: { completed?: number; total?: number; digest?: string } | null = null
    await ollamaService.pullModel('x', (p) => {
      captured = p
    })
    expect(captured?.completed).toBe(30)
    expect(captured?.total).toBe(200)
    expect(captured?.digest).toBe('sha256:xyz')
  })

  it('无 success 事件时返回 success:false', async () => {
    fetchSpy.mockResolvedValue(ndjsonStream([{ status: 'downloading', completed: 10, total: 100 }]))
    const res = await ollamaService.pullModel('x', () => {})
    expect(res.success).toBe(false)
  })

  it('HTTP 非 ok 时返回错误', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, 404))
    const res = await ollamaService.pullModel('x', () => {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('404')
  })

  it('fetch 异常时返回错误', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'))
    const res = await ollamaService.pullModel('x', () => {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('connection refused')
  })

  it('容忍无法解析的行（不崩溃）', async () => {
    // 混入非法 JSON 行
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('not json\n{"status":"success"}\n'))
        controller.close()
      },
    })
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }))
    const res = await ollamaService.pullModel('x', () => {})
    expect(res.success).toBe(true)
  })
})

// =============================================================
// deleteModel
// =============================================================
describe('deleteModel', () => {
  it('成功删除', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    const res = await ollamaService.deleteModel('qwen3:1.7b')
    expect(res.success).toBe(true)
  })

  it('HTTP 非 ok 时失败', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }))
    const res = await ollamaService.deleteModel('unknown')
    expect(res.success).toBe(false)
  })

  it('fetch 异常时返回错误', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'))
    const res = await ollamaService.deleteModel('x')
    expect(res.success).toBe(false)
    expect(res.error).toContain('network error')
  })

  it('请求方法为 DELETE 且 body 含模型名', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await ollamaService.deleteModel('qwen3:1.7b')
    const opts = fetchSpy.mock.calls[0][1] as RequestInit
    expect(opts.method).toBe('DELETE')
    expect(JSON.parse(opts.body as string).name).toBe('qwen3:1.7b')
  })
})

// =============================================================
// detect 缓存行为
// =============================================================
describe('detect 缓存行为', () => {
  it('serve 在运行时 detect 返回 true', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [] }, 200))
    const result = await ollamaService.detect()
    expect(result).toBe(true)
  })

  it('二次调用 detect 不重新检测（缓存命中）', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [] }, 200))
    await ollamaService.detect()
    const callsBefore = fetchSpy.mock.calls.length
    await ollamaService.detect()
    // 缓存命中，不应显著增加 fetch 调用
    expect(fetchSpy.mock.calls.length).toBe(callsBefore)
  })

  it('resetDetection 后重新检测', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [] }, 200))
    await ollamaService.detect()
    ollamaService.resetDetection()
    await ollamaService.detect()
    // reset 后应有新的 isServeRunning 调用
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

// =============================================================
// stopServe（不依赖网络）
// =============================================================
describe('stopServe', () => {
  it('无 serveProcess 时静默不操作', () => {
    expect(() => ollamaService.stopServe()).not.toThrow()
  })
})
