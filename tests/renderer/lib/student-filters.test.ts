// =============================================================
// 学生列表过滤/排序/选择工具测试
// 覆盖：filterStudents（班级/搜索/存档）、sortStudentsByRisk、isAllSelected、
//       countArchivedHidden、buildClassIdToNameMap
// =============================================================

import { describe, expect, it } from 'vitest'
import type { EAAStudent } from '../../../src/shared/types'
import {
  buildClassIdToNameMap,
  CLASS_FILTER_ALL,
  CLASS_FILTER_NONE,
  countArchivedHidden,
  filterStudents,
  isAllSelected,
  RISK_ORDER,
  sortStudentsByRisk,
} from '../../../src/renderer/pages/Students/student-filters'

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

const students: EAAStudent[] = [
  makeStudent({ name: '张三', risk: '高', class_id: 'G7-1', groups: ['数学组'] }),
  makeStudent({ name: '李四', risk: '低', class_id: 'G7-1', entity_id: 'e2' }),
  makeStudent({ name: '王五', risk: '极高', class_id: 'G7-2', entity_id: 'e3', roles: ['班长'] }),
  makeStudent({ name: '赵六', risk: '中', class_id: null, entity_id: 'e4' }),
]

// =============================================================
// filterStudents
// =============================================================
describe('filterStudents', () => {
  it('CLASS_FILTER_ALL 返回全部（匹配搜索）', () => {
    const result = filterStudents(students, CLASS_FILTER_ALL, '', new Set(), false)
    expect(result).toHaveLength(4)
  })

  it('CLASS_FILTER_NONE 只返回未分班学生', () => {
    const result = filterStudents(students, CLASS_FILTER_NONE, '', new Set(), false)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('赵六')
  })

  it('按具体 class_id 过滤', () => {
    const result = filterStudents(students, 'G7-1', '', new Set(), false)
    expect(result).toHaveLength(2)
    expect(result.every((s) => s.class_id === 'G7-1')).toBe(true)
  })

  it('搜索匹配 name', () => {
    const result = filterStudents(students, CLASS_FILTER_ALL, '张三', new Set(), false)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('张三')
  })

  it('搜索匹配 groups', () => {
    const result = filterStudents(students, CLASS_FILTER_ALL, '数学', new Set(), false)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('张三')
  })

  it('搜索匹配 roles', () => {
    const result = filterStudents(students, CLASS_FILTER_ALL, '班长', new Set(), false)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('王五')
  })

  it('空搜索词匹配全部（includes("") 为 true）', () => {
    const result = filterStudents(students, CLASS_FILTER_ALL, '', new Set(), false)
    expect(result).toHaveLength(4)
  })

  it('无匹配搜索返回空', () => {
    const result = filterStudents(students, CLASS_FILTER_ALL, '不存在的名字', new Set(), false)
    expect(result).toHaveLength(0)
  })

  it('默认隐藏已存档班级学生', () => {
    const archived = new Set(['G7-1'])
    const result = filterStudents(students, CLASS_FILTER_ALL, '', archived, false)
    expect(result).toHaveLength(2) // 排除张三、李四（G7-1 已存档）
    expect(result.every((s) => s.class_id !== 'G7-1')).toBe(true)
  })

  it('showArchivedClass=true 时显示已存档班级学生', () => {
    const archived = new Set(['G7-1'])
    const result = filterStudents(students, CLASS_FILTER_ALL, '', archived, true)
    expect(result).toHaveLength(4)
  })

  it('按班级筛选 + 已存档隐藏组合：筛选已存档班级时不显示（因默认隐藏）', () => {
    const archived = new Set(['G7-1'])
    const result = filterStudents(students, 'G7-1', '', archived, false)
    expect(result).toHaveLength(0)
  })

  it('空学生列表返回空', () => {
    expect(filterStudents([], CLASS_FILTER_ALL, '', new Set(), false)).toEqual([])
  })
})

// =============================================================
// sortStudentsByRisk
// =============================================================
describe('sortStudentsByRisk', () => {
  it('按风险降序排列（极高在前）', () => {
    const result = sortStudentsByRisk(students)
    expect(result[0].risk).toBe('极高')
    expect(result[1].risk).toBe('高')
    expect(result[2].risk).toBe('中')
    expect(result[3].risk).toBe('低')
  })

  it('不修改原数组', () => {
    const original = [...students]
    sortStudentsByRisk(students)
    expect(students).toEqual(original)
  })

  it('空数组返回空数组', () => {
    expect(sortStudentsByRisk([])).toEqual([])
  })

  it('RISK_ORDER 权重正确', () => {
    expect(RISK_ORDER['极高']).toBeLessThan(RISK_ORDER['高'])
    expect(RISK_ORDER['高']).toBeLessThan(RISK_ORDER['中'])
    expect(RISK_ORDER['中']).toBeLessThan(RISK_ORDER['低'])
  })
})

// =============================================================
// isAllSelected
// =============================================================
describe('isAllSelected', () => {
  it('全部选中时返回 true', () => {
    const selected = new Set(students.map((s) => s.name))
    expect(isAllSelected(students, selected)).toBe(true)
  })

  it('部分选中时返回 false', () => {
    const selected = new Set(['张三'])
    expect(isAllSelected(students, selected)).toBe(false)
  })

  it('空列表返回 false', () => {
    expect(isAllSelected([], new Set())).toBe(false)
  })

  it('全选集合为空时返回 false', () => {
    expect(isAllSelected(students, new Set())).toBe(false)
  })
})

// =============================================================
// countArchivedHidden
// =============================================================
describe('countArchivedHidden', () => {
  it('正确统计已存档班级学生数', () => {
    const archived = new Set(['G7-1'])
    expect(countArchivedHidden(students, archived)).toBe(2) // 张三、李四
  })

  it('无已存档班级返回 0', () => {
    expect(countArchivedHidden(students, new Set())).toBe(0)
  })

  it('未分班学生不计入', () => {
    const archived = new Set(['G7-1', 'G7-2'])
    // 赵六 class_id=null，即使 archived 含其（不可能但测试）也不计入
    expect(countArchivedHidden(students, archived)).toBe(3) // 张三李四王五
  })
})

// =============================================================
// buildClassIdToNameMap
// =============================================================
describe('buildClassIdToNameMap', () => {
  it('构建 class_id → name 映射', () => {
    const map = buildClassIdToNameMap([
      { class_id: 'G7-1', name: '七年级1班' },
      { class_id: 'G7-2', name: '七年级2班' },
    ])
    expect(map['G7-1']).toBe('七年级1班')
    expect(map['G7-2']).toBe('七年级2班')
  })

  it('空列表返回空对象', () => {
    expect(buildClassIdToNameMap([])).toEqual({})
  })
})
