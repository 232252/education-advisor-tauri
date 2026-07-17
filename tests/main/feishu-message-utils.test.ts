// =============================================================
// feishu-message-utils 安全测试（R6-7 防御 + 行为契约）
//
// 这三个函数是从 feishu-bot-service.ts 抽出的纯函数，逻辑直接关系
// 到"原型链污染"防御（security-critical）。它们运行在每条入站飞书
// 消息的热路径上，因此必须有覆盖完整的单元测试锁住行为。
//
// 覆盖矩阵（对应 task add-feishu-message-utils-tests 的 23 个 must-have 场景）：
//   [1] sanitizeObject — 原值类型           (5 例：string/number/null/undefined/boolean)
//   [2] sanitizeObject — 防御 __proto__    (1 例：必须验证 ({}).polluted === undefined)
//   [3] sanitizeObject — 防御 constructor   (1 例：切断 constructor.prototype 污染链)
//   [4] sanitizeObject — 防御 prototype     (1 例)
//   [5] sanitizeObject — 递归嵌套对象      (1 例：深层 __proto__ 也被剥)
//   [6] sanitizeObject — 递归数组          (1 例：数组元素也被剥)
//   [7] sanitizeObject — 保留合法键        (1 例 + 1 例组合)
//   [8] sanitizeObject — in-place 同引用    (1 例)
//   [9] safeJsonParse — 基础 round-trip    (1 例)
//   [10] safeJsonParse — 解析后 sanitize   (1 例 + ({}).x === undefined 验证)
//   [11] safeJsonParse — null 字面量       (1 例：sanitizeObject 不可对 null 崩溃)
//   [12] safeJsonParse — 数组              (1 例)
//   [13] safeJsonParse — 非法 JSON 必抛    (1 例：锁死契约)
//   [14] safeJsonParse — 嵌套数组污染      (1 例)
//   [15] extractText — 基础提取            (1 例)
//   [16] extractText — 单 mention 剥离     (1 例)
//   [17] extractText — 多 mention 剥离     (1 例)
//   [18] extractText — 非 JSON 原样返回    (1 例)
//   [19] extractText — 空 text → ''       (1 例)
//   [20] extractText — 缺 text 字段 → ''  (1 例)
//   [21] extractText — trim 前后空白       (1 例)
//   [22] extractText — 空 key 跳过         (1 例：防止误删所有空串匹配)
//   [23] extractText — 完全非法 JSON       (1 例)
//
// 总计 23 个 it() 用例（it.each 内的每一行计 1）。
// =============================================================

import { describe, expect, it } from 'vitest'

import {
  extractText,
  safeJsonParse,
  sanitizeObject,
} from '../../src/main/services/feishu-message-utils'

// =============================================================
// sanitizeObject — R6-7 原型链污染防御核心
// =============================================================

describe('sanitizeObject: 原值类型直通', () => {
  // 这些值不是 object/array，不应被任何递归改动，原样返回
  it.each([
    ['string', 'hello'],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
  ])('原值 %s (%j) 应原样返回', (_label, input) => {
    expect(sanitizeObject(input)).toBe(input)
  })
})

describe('sanitizeObject: 防御 __proto__', () => {
  // R6-7 安全契约：解析外部 JSON 后，__proto__ 键必须被剥掉，
  // 且不能让污染泄漏到 Object.prototype。
  // 验证手段：拿一个新 {} 检查它身上有没有 .polluted。
  it('JSON.parse 出的 __proto__ 键必须被删除，且 Object.prototype 不被污染', () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}')
    sanitizeObject(polluted)

    // 1. 自身没有 __proto__ 这个 own property（它是继承自 Object.prototype 的）
    expect(Object.prototype.hasOwnProperty.call(polluted, '__proto__')).toBe(false)

    // 2. 安全契约的核心：(新 {})polluted 必须 === undefined，
    //    即 __proto__ 赋值没有污染 Object.prototype。
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('sanitizeObject: 防御 constructor / prototype', () => {
  // constructor.prototype 是另一条污染链：
  // {"constructor":{"prototype":{"polluted":true}}} 可以让 ({}).polluted === true
  it('应删除 constructor 键,切断 constructor.prototype 污染链', () => {
    const obj = JSON.parse(
      '{"constructor":{"prototype":{"polluted":true}}}',
    ) as Record<string, unknown>
    sanitizeObject(obj)

    // constructor own property 被剥
    expect(Object.prototype.hasOwnProperty.call(obj, 'constructor')).toBe(false)

    // Object.prototype 不被污染
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('应删除 prototype 键', () => {
    const obj = JSON.parse('{"prototype":{"polluted":true}}') as Record<
      string,
      unknown
    >
    sanitizeObject(obj)

    expect(Object.prototype.hasOwnProperty.call(obj, 'prototype')).toBe(false)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('sanitizeObject: 递归到嵌套对象', () => {
  // 深层 __proto__ 也必须被剥，否则攻击者会把污染键埋得更深。
  // 注意：必须用 JSON.parse 制造 __proto__ 这个 own property —— 对象字面量
  // {__proto__:...} 是设置原型（prototype），不是 own key，会绕过 Object.keys。
  it('嵌套 JSON 中 inner.__proto__ 必须被剥，且 Object.prototype 不被污染', () => {
    const input = JSON.parse(
      '{"outer":{"inner":{"__proto__":{"x":1}}}}',
    ) as Record<string, Record<string, Record<string, unknown>>>
    sanitizeObject(input)

    expect(
      Object.prototype.hasOwnProperty.call(input.outer.inner, '__proto__'),
    ).toBe(false)
    expect((input.outer.inner as { x?: number }).x).toBeUndefined()
    expect(({} as { x?: number }).x).toBeUndefined()
  })
})

describe('sanitizeObject: 递归到数组', () => {
  // 数组里每个元素都会被递归处理
  it('数组元素 [{__proto__:{}}, 1] 中 element[0].__proto__ 必须被剥', () => {
    const input: Array<Record<string, unknown> | number> = [
      { __proto__: {} },
      1,
    ]
    sanitizeObject(input)

    expect(
      Object.prototype.hasOwnProperty.call(input[0], '__proto__'),
    ).toBe(false)
    expect(input[1]).toBe(1)
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype)
  })
})

describe('sanitizeObject: 保留合法键', () => {
  // 合法键必须不被误伤
  it('{a:1,b:2} 应保持不变', () => {
    const input = { a: 1, b: 2 }
    const out = sanitizeObject(input)
    expect(out).toEqual({ a: 1, b: 2 })
  })

  it('{__proto__:{},a:1,b:2} 应只剥 __proto__，保留 a/b', () => {
    const input = JSON.parse('{"__proto__":{},"a":1,"b":2}') as Record<
      string,
      unknown
    >
    const out = sanitizeObject(input)
    expect(out).toEqual({ a: 1, b: 2 })
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype)
  })
})

describe('sanitizeObject: in-place 同引用', () => {
  // 行为契约：返回值与入参是同一引用（in-place 修改）。
  // 调用方可能依赖这个特性，例如 sanitizeObject(obj).prop === obj.prop。
  it('应返回与入参完全相同的引用', () => {
    const o: { a: number } = { a: 1 }
    expect(sanitizeObject(o)).toBe(o)
  })
})

// =============================================================
// safeJsonParse — JSON.parse + sanitizeObject 组合
// =============================================================

describe('safeJsonParse: 基础 round-trip', () => {
  it('"{\\"a\\":1}" 应解析为 {a:1}', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('safeJsonParse: 解析后自动 sanitize', () => {
  // 关键安全契约：JSON.parse 的副作用（__proto__ 被 V8 解释成赋值）
  // 必须被 sanitizeObject 抹掉，并且不能让污染泄漏到 Object.prototype。
  it('"{\\"text\\":\\"hi\\",\\"__proto__\\":{\\"x\\":1}}" 应只剩 {text:"hi"}，且 Object.prototype 不被污染', () => {
    const result = safeJsonParse<{ text: string }>(
      '{"text":"hi","__proto__":{"x":1}}',
    )

    expect(result).toEqual({ text: 'hi' })
    expect(({} as { x?: number }).x).toBeUndefined()
  })
})

describe('safeJsonParse: null 字面量', () => {
  // null 既不是 array 也不是 object（typeof null === 'object' 但要走 typeof 分支兜底），
  // sanitizeObject 必须不能对它崩溃
  it('"null" 应返回 null', () => {
    expect(safeJsonParse<null>('null')).toBeNull()
  })
})

describe('safeJsonParse: 数组', () => {
  it('"[1,2,3]" 应解析为 [1,2,3]', () => {
    expect(safeJsonParse<number[]>('[1,2,3]')).toEqual([1, 2, 3])
  })
})

describe('safeJsonParse: 非法 JSON 必抛', () => {
  // 契约锁定：safeJsonParse 不能"吞错"或返回 undefined，否则调用方
  // 会拿到一个 falsy 值并继续走下去，掩盖真实错误。
  it('"not json" 必须抛错', () => {
    expect(() => safeJsonParse('not json')).toThrow()
  })
})

describe('safeJsonParse: 嵌套数组污染', () => {
  // 数组里每个元素都会递归 sanitize
  it('"[{\\"__proto__\\":{\\"p\\":1}}]" 应解析为 [{}]，且 Object.prototype 不被污染', () => {
    const result = safeJsonParse<Array<Record<string, unknown>>>(
      '[{"__proto__":{"p":1}}]',
    )

    expect(result).toEqual([{}])
    expect(({} as { p?: number }).p).toBeUndefined()
  })
})

// =============================================================
// extractText — 飞书消息 content → 纯文本
// =============================================================

describe('extractText: 基础提取', () => {
  it('"{\\"text\\":\\"hello\\"}" + 空 mentions → "hello"', () => {
    expect(extractText('{"text":"hello"}', [])).toBe('hello')
  })
})

describe('extractText: 单 mention 剥离', () => {
  // @_user_1 是飞书 at 占位符，需要替换成空串（用户看不到它）
  it('剥离 @_user_1 后剩下"你好"', () => {
    expect(
      extractText('{"text":"@_user_1 你好"}', [
        { key: '@_user_1', name: 'bot' },
      ]),
    ).toBe('你好')
  })
})

describe('extractText: 多 mention 剥离', () => {
  it('依次剥离 @_user_1 和 @_user_2 后剩下"hi"', () => {
    expect(
      extractText('{"text":"@_user_1 @_user_2 hi"}', [
        { key: '@_user_1', name: 'A' },
        { key: '@_user_2', name: 'B' },
      ]),
    ).toBe('hi')
  })
})

describe('extractText: 非 JSON 原样返回', () => {
  // 行为契约：content 不是合法 JSON 时不要抛错，而是返回 trim 后的原文。
  // 飞书有时候发纯文本消息而不是 JSON。
  it('"  plain text  " + 空 mentions → "plain text"', () => {
    expect(extractText('  plain text  ', [])).toBe('plain text')
  })
})

describe('extractText: 空 text → ""', () => {
  it('"{\\"text\\":\\"\\"}" 应返回 ""', () => {
    expect(extractText('{"text":""}', [])).toBe('')
  })
})

describe('extractText: 缺 text 字段 → ""', () => {
  it('"{\\"foo\\":\\"bar\\"}" 应返回 ""', () => {
    expect(extractText('{"foo":"bar"}', [])).toBe('')
  })
})

describe('extractText: trim 前后空白', () => {
  it('"{\\"text\\":\\"  spaced  \\"}" 应返回 "spaced"', () => {
    expect(extractText('{"text":"  spaced  "}', [])).toBe('spaced')
  })
})

describe('extractText: mention 空 key 跳过', () => {
  // 行为契约：mentions.key === '' 时跳过该条，
  // 防止 "".split("").join("") = "" 把整条文本删光。
  it('mention.key 为 "" 时不应删除任何字符', () => {
    expect(
      extractText('{"text":"keep"}', [{ key: '', name: 'x' }]),
    ).toBe('keep')
  })
})

describe('extractText: 完全非法 JSON', () => {
  it('"  garbage  " 应原样 trim 返回 "garbage"', () => {
    expect(extractText('  garbage  ', [])).toBe('garbage')
  })
})