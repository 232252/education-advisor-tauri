// =============================================================
// ipc-client.getErrorMessage 测试 — 纯函数错误信息提取
// 优先取 result.data（字符串且有内容），其次 stderr，最后 fallback
// =============================================================

import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../../../src/renderer/lib/ipc-client'

describe('getErrorMessage', () => {
  it('优先取 result.data（非空字符串）', () => {
    expect(getErrorMessage({ data: '详细错误', stderr: 'stderr' })).toBe('详细错误')
  })

  it('result.data 为空字符串时回退到 stderr', () => {
    expect(getErrorMessage({ data: '', stderr: 'stderr信息' })).toBe('stderr信息')
  })

  it('result.data 为 undefined 时回退到 stderr', () => {
    expect(getErrorMessage({ stderr: 'stderr信息' })).toBe('stderr信息')
  })

  it('result.data 为非字符串类型时回退到 stderr', () => {
    expect(getErrorMessage({ data: { x: 1 }, stderr: 'stderr' })).toBe('stderr')
  })

  it('data 和 stderr 都为空时用默认 fallback', () => {
    expect(getErrorMessage({ data: '', stderr: '' })).toBe('未知错误')
  })

  it('data 和 stderr 都 undefined 时用默认 fallback', () => {
    expect(getErrorMessage({})).toBe('未知错误')
  })

  it('可自定义 fallback', () => {
    expect(getErrorMessage({}, '自定义错误')).toBe('自定义错误')
  })

  it('stderr 为 undefined 时回退到 fallback', () => {
    expect(getErrorMessage({ data: '' })).toBe('未知错误')
  })
})
