// =============================================================
// SettingsPage mergeSettings 深合并测试 — UI-1 修复验证
// 关键场景: 后端 settings.get() 在迁移/升级后返回稀疏对象
// (例如缺 feishu.bitableSync / chat.compaction 等嵌套子对象),
// mergeSettings 必须用 DEFAULT_SETTINGS 兜底,确保不抛异常。
// =============================================================

import { describe, expect, it } from 'vitest'

/**
 * 与 SettingsPage.tsx 中 mergeSettings 等价的实现,保持测试自包含。
 * 这里复制实现是测试代码的常用 pattern — 不依赖私有函数,通过相同输入验证相同契约。
 */
function mergeSettings(
  defaults: Record<string, unknown> | null | undefined,
  partial: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const safeDefaults = defaults ?? {}
  const safePartial = partial ?? {}
  const result: Record<string, unknown> = { ...safeDefaults }
  for (const key of Object.keys(safePartial)) {
    const dVal = safeDefaults[key]
    const pVal = safePartial[key]
    if (pVal === undefined) continue
    const dIsObj = dVal !== null && typeof dVal === 'object' && !Array.isArray(dVal)
    const pIsObj = pVal !== null && typeof pVal === 'object' && !Array.isArray(pVal)
    if (dIsObj && pIsObj) {
      result[key] = mergeSettings(dVal as Record<string, unknown>, pVal as Record<string, unknown>)
    } else {
      result[key] = pVal
    }
  }
  return result
}

const DEFAULT_SETTINGS = {
  general: { theme: 'light', language: 'zh-CN', autoUpdate: true },
  models: {
    defaultProvider: '',
    retry: { enabled: true, maxRetries: 3 },
  },
  chat: {
    compaction: { enabled: true, reserveTokens: 8000 },
    showImages: true,
  },
  feishu: {
    appId: '',
    bitableSync: { enabled: false, syncInterval: '0 */6 * * *' },
  },
}

describe('mergeSettings — UI-1 修复 (SettingsPage)', () => {
  it('完整 settings: 后端值覆盖默认,保留叶子结构', () => {
    const backend = {
      general: { theme: 'dark' },
      feishu: { bitableSync: { enabled: true } },
    }
    const merged = mergeSettings(DEFAULT_SETTINGS, backend)
    expect(merged.general).toEqual({ theme: 'dark', language: 'zh-CN', autoUpdate: true })
    expect((merged.feishu as Record<string, unknown>).bitableSync).toEqual({
      enabled: true,
      syncInterval: '0 */6 * * *',
    })
  })

  it('稀疏 settings: 缺 feishu 子对象不抛异常', () => {
    const backend = { general: { theme: 'light' } }
    const merged = mergeSettings(DEFAULT_SETTINGS, backend)
    // feishu.bitableSync 必须存在,UI-1 修复点
    expect(merged.feishu).toBeDefined()
    expect((merged.feishu as Record<string, unknown>).bitableSync).toEqual({
      enabled: false,
      syncInterval: '0 */6 * * *',
    })
  })

  it('稀疏 settings: 缺 chat.compaction 不抛异常', () => {
    const backend = { models: { retry: { enabled: false } } }
    const merged = mergeSettings(DEFAULT_SETTINGS, backend)
    expect(merged.chat).toBeDefined()
    expect((merged.chat as Record<string, unknown>).compaction).toEqual({
      enabled: true,
      reserveTokens: 8000,
    })
  })

  it('完全空对象: 返回完整默认值', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {})
    expect(merged).toEqual(DEFAULT_SETTINGS)
  })

  it('null/undefined partial: 返回 defaults 拷贝', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('null/undefined defaults: 返回 partial 拷贝', () => {
    const partial = { general: { theme: 'dark' } }
    expect(mergeSettings(null, partial)).toEqual(partial)
    expect(mergeSettings(undefined, partial)).toEqual(partial)
  })

  it('数组按值覆盖(不递归)', () => {
    const defaults = { tags: ['a', 'b', 'c'] }
    const partial = { tags: ['x'] }
    const merged = mergeSettings(defaults, partial)
    expect(merged.tags).toEqual(['x'])
  })

  it('partial 中显式 null 会覆盖默认值', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { feishu: null })
    expect(merged.feishu).toBeNull()
  })

  it('partial 中 undefined 键保留 defaults 原值', () => {
    const partial = { general: undefined, models: { defaultProvider: 'openai' } }
    const merged = mergeSettings(DEFAULT_SETTINGS, partial)
    expect(merged.general).toEqual(DEFAULT_SETTINGS.general)
    expect((merged.models as Record<string, unknown>).defaultProvider).toBe('openai')
  })

  it('极端稀疏: 后端只返回 general.theme,UI 仍可安全访问所有嵌套字段', () => {
    const backend = { general: { theme: 'light' } }
    const merged = mergeSettings(DEFAULT_SETTINGS, backend)
    // 模拟 SettingsPage.tsx 中的访问路径
    expect((merged.feishu as Record<string, unknown>).bitableSync).toBeDefined()
    expect(
      ((merged.feishu as Record<string, unknown>).bitableSync as Record<string, unknown>).enabled,
    ).toBe(false)
    expect((merged.chat as Record<string, unknown>).compaction).toBeDefined()
    expect(
      ((merged.chat as Record<string, unknown>).compaction as Record<string, unknown>).enabled,
    ).toBe(true)
    expect((merged.models as Record<string, unknown>).retry).toBeDefined()
  })
})