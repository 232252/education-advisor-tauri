// =============================================================
// pi-ai-helpers 单元测试
//
// 这些函数是从 src/main/services/pi-ai-service.ts 中提取出来的
// 纯函数(无 I/O、无单例状态、不依赖 pi-ai 运行时),目的是让
// LLM 编排核心里的纯逻辑拥有独立测试覆盖,而不是埋在 1093 行
// 的大文件里。
//
// 测试策略:不使用任何 mock,直接构造最小化的输入对象(必要时
// 通过 `as any` / `as any as AssistantMessageEvent` 转义类型),
// 因为这些是单元测试,关注纯函数的行为契约。
// =============================================================

import type { AssistantMessageEvent } from '@earendil-works/pi-ai/compat'
import { describe, expect, it } from 'vitest'

import {
  costScore,
  dedupeModels,
  extractPartialToolCall,
  isRetryableError,
  mapEvent,
  selectCheapestModel,
} from '../../src/main/services/pi-ai-helpers'

// =============================================================
// dedupeModels
// =============================================================
describe('dedupeModels', () => {
  it('空数组 → 空数组', () => {
    expect(dedupeModels([])).toEqual([])
  })

  it('无重复时全部保留,顺序不变', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ] as any
    const out = dedupeModels(input)
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('id 重复时保留首次出现,后续丢弃', () => {
    const input = [
      { id: 'a', name: 'first' },
      { id: 'b', name: 'second' },
      { id: 'a', name: 'dup' },
    ] as any
    const out = dedupeModels(input)
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('a')
    expect(out[0].name).toBe('first')
    expect(out[1].id).toBe('b')
  })

  it('全部 id 相同 → 只保留第一个', () => {
    const input = [
      { id: 'x', n: 1 },
      { id: 'x', n: 2 },
      { id: 'x', n: 3 },
    ] as any
    const out = dedupeModels(input)
    expect(out).toHaveLength(1)
    expect(out[0].n).toBe(1)
  })
})

// =============================================================
// costScore
//
// 缺失字段(input/output undefined)或非有限值(NaN/Infinity)
// 一律视为 Number.POSITIVE_INFINITY,目的是把"无成本数据"的
// 模型排在最末,避免误选免费但未实报价的模型。
// =============================================================
describe('costScore', () => {
  it.each<[string, any, number]>([
    ['两端都为有限值 → 相加', { cost: { input: 1, output: 2 } }, 3],
    ['input 缺失(undefined)→ Infinity', { cost: { output: 2 } }, Infinity],
    ['output 缺失(undefined)→ Infinity', { cost: { input: 1 } }, Infinity],
    ['整个 cost 缺失 → Infinity', {}, Infinity],
    ['input 是 NaN → Infinity', { cost: { input: Number.NaN, output: 1 } }, Infinity],
    ['两端都为 0 → 0', { cost: { input: 0, output: 0 } }, 0],
  ])('%s', (_label, m, expected) => {
    expect(costScore(m)).toBe(expected)
  })
})

// =============================================================
// selectCheapestModel
// =============================================================
describe('selectCheapestModel', () => {
  it('空数组抛错,信息含 "empty model list"', () => {
    expect(() => selectCheapestModel([])).toThrow('empty model list')
  })

  it('单元素直接返回', () => {
    const only = { id: 'only', cost: { input: 1, output: 1 } } as any
    expect(selectCheapestModel([only])).toBe(only)
  })

  it('选择 input+output 之和最小的那个', () => {
    const a = { id: 'a', cost: { input: 5, output: 5 } } as any // sum=10
    const b = { id: 'b', cost: { input: 1, output: 1 } } as any // sum=2
    const c = { id: 'c', cost: { input: 3, output: 3 } } as any // sum=6
    expect(selectCheapestModel([a, b, c])).toBe(b)
  })

  it('undefined 成本被视为 Infinity → 排到末尾', () => {
    const cheap = { id: 'cheap', cost: { input: 1, output: 1 } } as any
    const expensive = { id: 'expensive' } as any // cost undefined → Infinity
    expect(selectCheapestModel([cheap, expensive])).toBe(cheap)
    expect(selectCheapestModel([expensive, cheap])).toBe(cheap)
  })

  it('全部 Infinity 时 reduce 保留首个(tie)', () => {
    const a = { id: 'a' } as any
    const b = { id: 'b' } as any
    expect(selectCheapestModel([a, b])).toBe(a)
  })
})

// =============================================================
// mapEvent — 简单臂(text / thinking / 未知)
//
// start → null 是有意为之:chatStream 中会手动 yield 一个 start 事件,
// 这里再 yield 一次就会重复,所以 mapEvent 对 start 返回 null。
// =============================================================
describe('mapEvent - simple arms', () => {
  it.each<[string, AssistantMessageEvent, any]>([
    ['start → null', { type: 'start' } as any, null],
    ['text_start', { type: 'text_start' } as any, { type: 'text_start' }],
    ['text_delta', { type: 'text_delta', delta: 'hi' } as any, { type: 'text_delta', delta: 'hi' }],
    ['text_end', { type: 'text_end' } as any, { type: 'text_end' }],
    [
      'thinking_start',
      { type: 'thinking_start' } as any,
      { type: 'thinking_start' },
    ],
    [
      'thinking_delta',
      { type: 'thinking_delta', delta: '...' } as any,
      { type: 'thinking_delta', delta: '...' },
    ],
    [
      'thinking_end',
      { type: 'thinking_end' } as any,
      { type: 'thinking_end' },
    ],
    ['未知事件类型 → null', { type: 'mystery_event' } as any, null],
  ])('%s', (_label, event, expected) => {
    expect(mapEvent(event)).toEqual(expected)
  })
})

// =============================================================
// mapEvent — toolcall 臂(依赖 extractPartialToolCall)
// =============================================================
describe('mapEvent - toolcall arms', () => {
  it('toolcall_start 且 partial 在 contentIndex 处有 toolCall 块', () => {
    const event = {
      type: 'toolcall_start',
      contentIndex: 0,
      partial: {
        content: [{ type: 'toolCall', id: 'tc1', name: 'toolA' }],
      },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'toolcall_start',
      id: 'tc1',
      name: 'toolA',
    })
  })

  it('toolcall_start 但 contentIndex 越界 → null(由 extractPartialToolCall 返回 null)', () => {
    const event = {
      type: 'toolcall_start',
      contentIndex: 999,
      partial: { content: [] },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toBeNull()
  })

  it('toolcall_delta → id 留空,argsDelta 透传 delta', () => {
    const event = {
      type: 'toolcall_delta',
      delta: '{"x":1}',
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'toolcall_delta',
      id: '',
      argsDelta: '{"x":1}',
    })
  })

  it('toolcall_end → 透传 toolCall.id', () => {
    const event = {
      type: 'toolcall_end',
      toolCall: { id: 'tc1', name: 'toolA' },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({ type: 'toolcall_end', id: 'tc1' })
  })
})

// =============================================================
// mapEvent — done 臂
//
// usage.input/output/cacheRead/cacheWrite → 同名 token 字段
// usage.cost.total → cost
// 缺失字段默认值 0
// =============================================================
describe('mapEvent - done arm', () => {
  it('usage 全字段存在 → 完整映射 + cost', () => {
    const event = {
      type: 'done',
      message: {
        usage: {
          input: 100,
          output: 50,
          cacheRead: 25,
          cacheWrite: 5,
          cost: { total: 0.0023 },
        },
      },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'done',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheWriteTokens: 5,
      },
      cost: 0.0023,
    })
  })

  it('usage 完全缺失 → token 字段全 0,cost 0', () => {
    const event = {
      type: 'done',
      message: { usage: undefined },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'done',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      cost: 0,
    })
  })
})

// =============================================================
// mapEvent — error 臂
//
// retryable 仅在 reason === 'aborted' 时为 true(用户主动停止的
// 请求没有重试意义);errorMessage 缺失时回落到 "Unknown error"。
// =============================================================
describe('mapEvent - error arm', () => {
  it('reason=aborted → retryable=true', () => {
    const event = {
      type: 'error',
      reason: 'aborted',
      error: { errorMessage: 'stream aborted by user' },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'error',
      message: 'stream aborted by user',
      retryable: true,
    })
  })

  it('reason=other → retryable=false', () => {
    const event = {
      type: 'error',
      reason: 'other',
      error: { errorMessage: 'something failed' },
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'error',
      message: 'something failed',
      retryable: false,
    })
  })

  it('errorMessage 缺失 → 回落为 "Unknown error"', () => {
    const event = {
      type: 'error',
      reason: 'other',
      error: {},
    } as any as AssistantMessageEvent
    expect(mapEvent(event)).toEqual({
      type: 'error',
      message: 'Unknown error',
      retryable: false,
    })
  })
})

// =============================================================
// extractPartialToolCall
// =============================================================
describe('extractPartialToolCall', () => {
  it('index 0 处为 toolCall 块 → 返回 id/name', () => {
    const partial = {
      content: [
        { type: 'toolCall', id: 'tc1', name: 'search' },
      ],
    } as any
    expect(extractPartialToolCall(partial, 0)).toEqual({
      id: 'tc1',
      name: 'search',
    })
  })

  it('contentIndex 越界 → null', () => {
    const partial = {
      content: [{ type: 'toolCall', id: 'tc1', name: 'search' }],
    } as any
    expect(extractPartialToolCall(partial, 999)).toBeNull()
  })

  it('contentIndex 为负数 → null(array[-1] === undefined)', () => {
    const partial = {
      content: [{ type: 'toolCall', id: 'tc1', name: 'search' }],
    } as any
    expect(extractPartialToolCall(partial, -1)).toBeNull()
  })

  it('该位置不是 toolCall 块(例如 text)→ null', () => {
    const partial = {
      content: [{ type: 'text', text: 'hello' }],
    } as any
    expect(extractPartialToolCall(partial, 0)).toBeNull()
  })
})

// =============================================================
// isRetryableError
//
// 历史行为:大小写敏感的 includes 检查(未做 toLowerCase),
// 所以 'ECONNRESET' 匹配但 'econnreset' 不匹配。这里保留
// 这一行为,因为生产代码也是这么做的。
// =============================================================
describe('isRetryableError', () => {
  it.each<[string, boolean]>([
    // 应当被判定为可重试
    ['Connection timeout occurred', true],
    ['network reset', true],
    ['HTTP 429 Too Many Requests', true],
    ['HTTP 500 Internal Server Error', true],
    ['502 bad gateway', true],
    ['503 service unavailable', true],
    ['504 gateway timeout', true],
    ['Error: ECONNRESET', true],
    ['Error: ECONNREFUSED', true],
    // 不应被判定为可重试
    ['HTTP 400 bad request', false],
    ['invalid api key', false],
    ['random parse error', false],
    ['', false],
  ])('"%s" → %s', (msg, expected) => {
    expect(isRetryableError(msg)).toBe(expected)
  })
})