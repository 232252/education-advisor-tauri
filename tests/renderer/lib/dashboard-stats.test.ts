// =============================================================
// 仪表盘统计计算工具测试
// 覆盖：computeScoreIntervals（分桶边界）、computeReasonDistribution、
//       computePeriodSummary（top-N 排序）、computeClassComparison
// =============================================================

import { describe, expect, it } from 'vitest'
import type { EAAEventRecord, EAAStudent } from '../../../src/shared/types'
import {
  computeClassComparison,
  computePeriodSummary,
  computeReasonDistribution,
  computeScoreIntervals,
} from '../../../src/renderer/pages/Dashboard/dashboard-stats'

function makeStudent(overrides: Partial<EAAStudent> = {}): EAAStudent {
  return {
    name: '张三',
    entity_id: 'e1',
    score: 80,
    delta: 0,
    risk: '中',
    status: 'normal',
    events_count: 0,
    groups: [],
    roles: [],
    class_id: null,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<EAAEventRecord> = {}): EAAEventRecord {
  return {
    event_id: 'ev1',
    name: '张三',
    entity_id: 'e1',
    timestamp: '2024-01-01T00:00:00Z',
    event_type: 'ConductBonus',
    reason_code: 'HELP',
    original_reason: '帮助同学',
    score_delta: 5,
    note: '',
    tags: [],
    operator: 'teacher',
    is_valid: true,
    reverted_by: null,
    ...overrides,
  }
}

// =============================================================
// computeScoreIntervals
// =============================================================
describe('computeScoreIntervals', () => {
  it('空学生列表返回全 0 桶', () => {
    const result = computeScoreIntervals([])
    expect(Object.values(result).every((v) => v === 0)).toBe(true)
  })

  it('分数 59 落入 极高(<60) 桶', () => {
    const result = computeScoreIntervals([makeStudent({ score: 59 })])
    expect(result['极高(<60)']).toBe(1)
    expect(result['高(60-80)']).toBe(0)
  })

  it('分数 60 落入 高(60-80) 桶（含 60）', () => {
    const result = computeScoreIntervals([makeStudent({ score: 60 })])
    expect(result['高(60-80)']).toBe(1)
  })

  it('分数 79.9 落入 高(60-80) 桶', () => {
    const result = computeScoreIntervals([makeStudent({ score: 79.9 })])
    expect(result['高(60-80)']).toBe(1)
  })

  it('分数 80 落入 中(80-100) 桶（含 80）', () => {
    const result = computeScoreIntervals([makeStudent({ score: 80 })])
    expect(result['中(80-100)']).toBe(1)
  })

  it('分数 99.9 落入 中(80-100) 桶', () => {
    const result = computeScoreIntervals([makeStudent({ score: 99.9 })])
    expect(result['中(80-100)']).toBe(1)
  })

  it('分数 100 落入 低(>=100) 桶（含 100）', () => {
    const result = computeScoreIntervals([makeStudent({ score: 100 })])
    expect(result['低(>=100)']).toBe(1)
  })

  it('分数 0 落入 极高(<60) 桶', () => {
    const result = computeScoreIntervals([makeStudent({ score: 0 })])
    expect(result['极高(<60)']).toBe(1)
  })

  it('多个学生正确分桶计数', () => {
    const students = [
      makeStudent({ score: 50 }),
      makeStudent({ score: 65, entity_id: 'e2' }),
      makeStudent({ score: 90, entity_id: 'e3' }),
      makeStudent({ score: 110, entity_id: 'e4' }),
    ]
    const result = computeScoreIntervals(students)
    expect(result['极高(<60)']).toBe(1)
    expect(result['高(60-80)']).toBe(1)
    expect(result['中(80-100)']).toBe(1)
    expect(result['低(>=100)']).toBe(1)
  })
})

// =============================================================
// computeReasonDistribution
// =============================================================
describe('computeReasonDistribution', () => {
  it('按出现次数降序排列', () => {
    const events = [
      makeEvent({ reason_code: 'A' }),
      makeEvent({ reason_code: 'B' }),
      makeEvent({ reason_code: 'A' }),
      makeEvent({ reason_code: 'A' }),
    ]
    const result = computeReasonDistribution(events)
    expect(result[0]).toEqual({ code: 'A', count: 3 })
    expect(result[1]).toEqual({ code: 'B', count: 1 })
  })

  it('空 reason_code 归为 UNKNOWN', () => {
    const events = [makeEvent({ reason_code: '' }), makeEvent({ reason_code: '' })]
    const result = computeReasonDistribution(events)
    expect(result[0]).toEqual({ code: 'UNKNOWN', count: 2 })
  })

  it('空事件返回空数组', () => {
    expect(computeReasonDistribution([])).toEqual([])
  })
})

// =============================================================
// computePeriodSummary
// =============================================================
describe('computePeriodSummary', () => {
  it('正确统计加分/扣分', () => {
    const events = [
      makeEvent({ score_delta: 5, entity_id: 'e1' }),
      makeEvent({ score_delta: -3, entity_id: 'e2' }),
      makeEvent({ score_delta: 2, entity_id: 'e1' }),
    ]
    const result = computePeriodSummary(events, { e1: '张三', e2: '李四' })
    expect(result.events.bonus_count).toBe(2)
    expect(result.events.deduct_count).toBe(1)
    expect(result.events.bonus_total).toBe(7)
    expect(result.events.deduct_total).toBe(-3)
    expect(result.events.total).toBe(3)
  })

  it('top_gainers 按净 delta 降序取前 3', () => {
    const events = [
      makeEvent({ score_delta: 5, entity_id: 'e1' }),
      makeEvent({ score_delta: 3, entity_id: 'e2' }),
      makeEvent({ score_delta: 1, entity_id: 'e3' }),
      makeEvent({ score_delta: 10, entity_id: 'e4' }),
    ]
    const result = computePeriodSummary(events, { e1: 'A', e2: 'B', e3: 'C', e4: 'D' })
    expect(result.top_gainers).toHaveLength(3)
    expect(result.top_gainers[0].name).toBe('D') // delta 10 最大
    expect(result.top_gainers[0].delta).toBe(10)
  })

  it('top_losers 按净 delta 升序取前 3（最负在前）', () => {
    const events = [
      makeEvent({ score_delta: -5, entity_id: 'e1' }),
      makeEvent({ score_delta: -20, entity_id: 'e2' }),
      makeEvent({ score_delta: -3, entity_id: 'e3' }),
    ]
    const result = computePeriodSummary(events, { e1: 'A', e2: 'B', e3: 'C' })
    expect(result.top_losers).toHaveLength(3)
    expect(result.top_losers[0].name).toBe('B') // delta -20 最小
    expect(result.top_losers[0].delta).toBe(-20)
  })

  it('同一学生多次事件净 delta 累加', () => {
    const events = [
      makeEvent({ score_delta: 5, entity_id: 'e1' }),
      makeEvent({ score_delta: 3, entity_id: 'e1' }),
      makeEvent({ score_delta: -2, entity_id: 'e1' }),
    ]
    const result = computePeriodSummary(events, { e1: '张三' })
    expect(result.top_gainers[0].delta).toBe(6) // 5+3-2
  })

  it('delta 为 0 的事件不计入 gainers/losers', () => {
    const events = [makeEvent({ score_delta: 0, entity_id: 'e1' })]
    const result = computePeriodSummary(events, { e1: '张三' })
    expect(result.top_gainers).toHaveLength(0)
    expect(result.top_losers).toHaveLength(0)
  })

  it('entityIdToName 无映射时用 entity_id 作 name', () => {
    const events = [makeEvent({ score_delta: 5, entity_id: 'unknown-id' })]
    const result = computePeriodSummary(events, {})
    expect(result.top_gainers[0].name).toBe('unknown-id')
  })

  it('空事件返回零值统计', () => {
    const result = computePeriodSummary([], {})
    expect(result.events.total).toBe(0)
    expect(result.top_gainers).toEqual([])
    expect(result.top_losers).toEqual([])
  })

  it('可自定义 topN', () => {
    const events = [
      makeEvent({ score_delta: 1, entity_id: 'e1' }),
      makeEvent({ score_delta: 2, entity_id: 'e2' }),
      makeEvent({ score_delta: 3, entity_id: 'e3' }),
      makeEvent({ score_delta: 4, entity_id: 'e4' }),
      makeEvent({ score_delta: 5, entity_id: 'e5' }),
    ]
    const result = computePeriodSummary(events, {}, 2)
    expect(result.top_gainers).toHaveLength(2)
  })
})

// =============================================================
// computeClassComparison
// =============================================================
describe('computeClassComparison', () => {
  const students: EAAStudent[] = [
    makeStudent({ class_id: 'G7-1', score: 80, risk: '中', entity_id: 'e1', name: 'A' }),
    makeStudent({ class_id: 'G7-1', score: 100, risk: '低', entity_id: 'e2', name: 'B' }),
    makeStudent({ class_id: 'G7-2', score: 50, risk: '极高', entity_id: 'e3', name: 'C' }),
  ]

  it('每个班级的学生数正确', () => {
    const result = computeClassComparison(
      [
        { class_id: 'G7-1', name: '七年级1班' },
        { class_id: 'G7-2', name: '七年级2班' },
      ],
      students,
    )
    expect(result[0].studentCount).toBe(2)
    expect(result[1].studentCount).toBe(1)
  })

  it('平均分计算正确', () => {
    const result = computeClassComparison(
      [{ class_id: 'G7-1', name: '七年级1班' }],
      students,
    )
    expect(result[0].avgScore).toBe(90) // (80+100)/2
  })

  it('空班级平均分为 0（不 NaN）', () => {
    const result = computeClassComparison(
      [{ class_id: 'G7-3', name: '空班' }],
      students,
    )
    expect(result[0].avgScore).toBe(0)
    expect(result[0].studentCount).toBe(0)
  })

  it('highRisk = 极高 + 高 人数', () => {
    const result = computeClassComparison(
      [{ class_id: 'G7-2', name: '七年级2班' }],
      students,
    )
    expect(result[0].highRisk).toBe(1) // C 是极高
  })

  it('riskDistribution 完整记录各风险等级', () => {
    const result = computeClassComparison(
      [{ class_id: 'G7-1', name: '七年级1班' }],
      students,
    )
    expect(result[0].riskDistribution).toEqual({ 极高: 0, 高: 0, 中: 1, 低: 1 })
  })

  it('空班级列表返回空数组', () => {
    expect(computeClassComparison([], students)).toEqual([])
  })
})
