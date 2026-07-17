// =============================================================
// 考试对比计算工具测试
// 覆盖：computeScoreDelta（分数差）、computeRankDelta（名次差）、
//       summarizeSubjects（科目进退步统计）、aggregateConductDelta（操行分聚合）、
//       compareStudentGrades（单学生对比）、compareClassGrades（全班对比）、
//       summarizeClassComparison（班级汇总）
// =============================================================

import { describe, expect, it } from 'vitest'
import type { EAAEventRecord, GradeRecord } from '../../../src/shared/types'
import {
  aggregateConductDelta,
  compareClassGrades,
  compareStudentGrades,
  computeRankDelta,
  computeScoreDelta,
  summarizeClassComparison,
  summarizeSubjects,
} from '../../../src/renderer/pages/Academics/exam-comparison'

function makeGrade(overrides: Partial<GradeRecord> = {}): GradeRecord {
  return {
    examId: 'exam-1',
    subjectId: 'math',
    studentName: '张三',
    score: 80,
    fullMark: 100,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeEvent(overrides: Partial<EAAEventRecord> = {}): EAAEventRecord {
  return {
    event_id: 'ev1',
    name: '张三',
    entity_id: 'e1',
    timestamp: '2026-01-01T10:00:00Z',
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

function makeSubjectMap(): Record<string, string> {
  return { math: '数学', chinese: '语文', english: '英语', physics: '物理' }
}

// =============================================================
// computeScoreDelta
// =============================================================
describe('computeScoreDelta', () => {
  it('两数都有效：正差 (80, 90) → 10', () => {
    expect(computeScoreDelta(80, 90)).toBe(10)
  })

  it('两数都有效：负差 (90, 80) → -10', () => {
    expect(computeScoreDelta(90, 80)).toBe(-10)
  })

  it('两数相等：(80, 80) → 0', () => {
    expect(computeScoreDelta(80, 80)).toBe(0)
  })

  it('a 为 null：(null, 90) → null', () => {
    expect(computeScoreDelta(null, 90)).toBeNull()
  })

  it('b 为 null：(80, null) → null', () => {
    expect(computeScoreDelta(80, null)).toBeNull()
  })

  it('都为 null：(null, null) → null', () => {
    expect(computeScoreDelta(null, null)).toBeNull()
  })
})

// =============================================================
// computeRankDelta
// =============================================================
describe('computeRankDelta', () => {
  it('名次上升（数值变小）：(5, 3) → -2', () => {
    expect(computeRankDelta(5, 3)).toBe(-2)
  })

  it('名次下降（数值变大）：(3, 5) → 2', () => {
    expect(computeRankDelta(3, 5)).toBe(2)
  })

  it('名次持平：(4, 4) → 0', () => {
    expect(computeRankDelta(4, 4)).toBe(0)
  })

  it('a 为 null：(null, 3) → null', () => {
    expect(computeRankDelta(null, 3)).toBeNull()
  })

  it('b 为 null：(4, null) → null', () => {
    expect(computeRankDelta(4, null)).toBeNull()
  })
})

// =============================================================
// summarizeSubjects
// =============================================================
describe('summarizeSubjects', () => {
  it('空数组返回零值统计', () => {
    expect(summarizeSubjects([])).toEqual({ improved: 0, declined: 0, unchanged: 0 })
  })

  it('全进步 → improved=N, declined=0, unchanged=0', () => {
    const subjects = [
      { subjectId: 'math', subjectName: '数学', scoreA: 80, scoreB: 90, fullMark: 100, scoreDelta: 10, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
      { subjectId: 'chinese', subjectName: '语文', scoreA: 70, scoreB: 85, fullMark: 100, scoreDelta: 15, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
      { subjectId: 'english', subjectName: '英语', scoreA: 60, scoreB: 75, fullMark: 100, scoreDelta: 15, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
    ]
    expect(summarizeSubjects(subjects)).toEqual({ improved: 3, declined: 0, unchanged: 0 })
  })

  it('全退步 → improved=0, declined=N, unchanged=0', () => {
    const subjects = [
      { subjectId: 'math', subjectName: '数学', scoreA: 90, scoreB: 70, fullMark: 100, scoreDelta: -20, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
      { subjectId: 'chinese', subjectName: '语文', scoreA: 85, scoreB: 75, fullMark: 100, scoreDelta: -10, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
    ]
    expect(summarizeSubjects(subjects)).toEqual({ improved: 0, declined: 2, unchanged: 0 })
  })

  it('混合（有正有负有零有 null）→ null 不计入', () => {
    const subjects = [
      { subjectId: 'math', subjectName: '数学', scoreA: 80, scoreB: 90, fullMark: 100, scoreDelta: 10, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
      { subjectId: 'chinese', subjectName: '语文', scoreA: 85, scoreB: 80, fullMark: 100, scoreDelta: -5, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
      { subjectId: 'english', subjectName: '英语', scoreA: 75, scoreB: 75, fullMark: 100, scoreDelta: 0, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
      { subjectId: 'physics', subjectName: '物理', scoreA: 70, scoreB: null, fullMark: 100, scoreDelta: null, classRankA: null, classRankB: null, classRankDelta: null, gradeRankA: null, gradeRankB: null, gradeRankDelta: null },
    ]
    expect(summarizeSubjects(subjects)).toEqual({ improved: 1, declined: 1, unchanged: 1 })
  })
})

// =============================================================
// aggregateConductDelta
// =============================================================
describe('aggregateConductDelta', () => {
  it('无事件（[]）→ 0', () => {
    expect(aggregateConductDelta([], '张三')).toBe(0)
  })

  it('无匹配学生（事件都是"李四"，查"张三"）→ 0', () => {
    const events = [
      makeEvent({ name: '李四', entity_id: 'e2', score_delta: 5 }),
      makeEvent({ name: '李四', entity_id: 'e2', event_id: 'ev2', score_delta: -3 }),
    ]
    expect(aggregateConductDelta(events, '张三')).toBe(0)
  })

  it('单条加分事件 → 5', () => {
    const events = [makeEvent({ score_delta: 5 })]
    expect(aggregateConductDelta(events, '张三')).toBe(5)
  })

  it('正负混合：[+5, -3, +2] → 4', () => {
    const events = [
      makeEvent({ event_id: 'ev1', score_delta: 5 }),
      makeEvent({ event_id: 'ev2', score_delta: -3 }),
      makeEvent({ event_id: 'ev3', score_delta: 2 }),
    ]
    expect(aggregateConductDelta(events, '张三')).toBe(4)
  })

  it('过滤 is_valid=false：有一条 is_valid:false, score_delta:100 的不计数', () => {
    const events = [
      makeEvent({ event_id: 'ev1', score_delta: 5, is_valid: true }),
      makeEvent({ event_id: 'ev2', score_delta: 100, is_valid: false }),
    ]
    expect(aggregateConductDelta(events, '张三')).toBe(5)
  })

  it('过滤 reverted_by 非空：有一条 reverted_by:"ev-x", score_delta:50 的不计数', () => {
    const events = [
      makeEvent({ event_id: 'ev1', score_delta: 3, reverted_by: null }),
      makeEvent({ event_id: 'ev2', score_delta: 50, reverted_by: 'ev-x' }),
    ]
    expect(aggregateConductDelta(events, '张三')).toBe(3)
  })
})

// =============================================================
// compareStudentGrades
// =============================================================
describe('compareStudentGrades', () => {
  it('单科两场都有分：scoreDelta=10, totalScoreDelta=10', () => {
    const gradesA = [makeGrade({ subjectId: 'math', score: 80 })]
    const gradesB = [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })]
    const result = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(result.subjects).toHaveLength(1)
    expect(result.subjects[0].scoreDelta).toBe(10)
    expect(result.totalScoreA).toBe(80)
    expect(result.totalScoreB).toBe(90)
    expect(result.totalScoreDelta).toBe(10)
    expect(result.studentName).toBe('张三')
  })

  it('多科两场都有分：subjects 长度=2, totalScoreA=两科之和', () => {
    const gradesA = [
      makeGrade({ subjectId: 'math', score: 80 }),
      makeGrade({ subjectId: 'chinese', score: 70 }),
    ]
    const gradesB = [
      makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' }),
      makeGrade({ subjectId: 'chinese', score: 85, examId: 'exam-2' }),
    ]
    const result = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(result.subjects).toHaveLength(2)
    expect(result.totalScoreA).toBe(150)
    expect(result.totalScoreB).toBe(175)
    expect(result.totalScoreDelta).toBe(25)
  })

  it('有缺考（examB 无 math）：scoreB=null, scoreDelta=null, totalScoreB=null', () => {
    const gradesA = [makeGrade({ subjectId: 'math', score: 80 })]
    const gradesB: GradeRecord[] = [] // examB 无该生 math 成绩
    const result = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(result.subjects[0].scoreA).toBe(80)
    expect(result.subjects[0].scoreB).toBeNull()
    expect(result.subjects[0].scoreDelta).toBeNull()
    expect(result.totalScoreA).toBe(80)
    expect(result.totalScoreB).toBeNull()
    expect(result.totalScoreDelta).toBeNull()
  })

  it('名次变化：classRankA=5, classRankB=3 → classRankDelta=-2', () => {
    const gradesA = [makeGrade({ subjectId: 'math', score: 80, classRank: 5 })]
    const gradesB = [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2', classRank: 3 })]
    const result = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(result.subjects[0].classRankA).toBe(5)
    expect(result.subjects[0].classRankB).toBe(3)
    expect(result.subjects[0].classRankDelta).toBe(-2)
  })

  it('名次未录入（都无 classRank）：classRankDelta=null', () => {
    const gradesA = [makeGrade({ subjectId: 'math', score: 80 })] // 无 classRank
    const gradesB = [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })] // 无 classRank
    const result = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(result.subjects[0].classRankA).toBeNull()
    expect(result.subjects[0].classRankB).toBeNull()
    expect(result.subjects[0].classRankDelta).toBeNull()
  })

  it('科目映射缺失：subjectMap 不含某 subjectId → subjectName 回退为 subjectId', () => {
    const gradesA = [makeGrade({ subjectId: 'unknown-sub', score: 80 })]
    const gradesB = [makeGrade({ subjectId: 'unknown-sub', score: 90, examId: 'exam-2' })]
    const result = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(result.subjects[0].subjectId).toBe('unknown-sub')
    expect(result.subjects[0].subjectName).toBe('unknown-sub')
  })

  it('空成绩（gradesA=[], gradesB=[]）：subjects=[], totalScoreA=null', () => {
    const result = compareStudentGrades([], [], makeSubjectMap())
    expect(result.subjects).toEqual([])
    expect(result.totalScoreA).toBeNull()
    expect(result.totalScoreB).toBeNull()
    expect(result.totalScoreDelta).toBeNull()
  })

  it('conductDelta 透传：传入 conductDelta=7 → conductDelta=7；不传 → null', () => {
    const gradesA = [makeGrade({ subjectId: 'math', score: 80 })]
    const gradesB = [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })]
    // 不传 conductDelta
    const r1 = compareStudentGrades(gradesA, gradesB, makeSubjectMap())
    expect(r1.conductDelta).toBeNull()
    // 传入 conductDelta=7
    const r2 = compareStudentGrades(gradesA, gradesB, makeSubjectMap(), 7)
    expect(r2.conductDelta).toBe(7)
  })
})

// =============================================================
// compareClassGrades
// =============================================================
describe('compareClassGrades', () => {
  it('空班级（{}, {}）→ []', () => {
    expect(compareClassGrades({}, {}, makeSubjectMap())).toEqual([])
  })

  it('单学生两场都有 → 返回 1 个 StudentComparison', () => {
    const classGradesA = { '张三': [makeGrade({ subjectId: 'math', score: 80 })] }
    const classGradesB = {
      '张三': [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })],
    }
    const result = compareClassGrades(classGradesA, classGradesB, makeSubjectMap())
    expect(result).toHaveLength(1)
    expect(result[0].studentName).toBe('张三')
    expect(result[0].subjects[0].scoreDelta).toBe(10)
  })

  it('学生只在 examA 有成绩（examB 无）：gradesB=[] → 该学生 subjects 配对时 scoreB=null', () => {
    const classGradesA = { '张三': [makeGrade({ subjectId: 'math', score: 80 })] }
    const classGradesB: Record<string, GradeRecord[]> = {}
    const result = compareClassGrades(classGradesA, classGradesB, makeSubjectMap())
    expect(result).toHaveLength(1)
    expect(result[0].subjects[0].scoreA).toBe(80)
    expect(result[0].subjects[0].scoreB).toBeNull()
    expect(result[0].subjects[0].scoreDelta).toBeNull()
    expect(result[0].totalScoreA).toBe(80)
    expect(result[0].totalScoreB).toBeNull()
  })

  it('多学生：返回数组长度 = 学生并集数', () => {
    const classGradesA = {
      '张三': [makeGrade({ subjectId: 'math', score: 80 })],
      '李四': [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 70 })],
    }
    const classGradesB = {
      '张三': [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })],
      '李四': [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 60, examId: 'exam-2' })],
      // examB 还多一个学生王五
      '王五': [makeGrade({ studentName: '王五', entity_id: 'e3', subjectId: 'math', score: 95, examId: 'exam-2' })],
    }
    const result = compareClassGrades(classGradesA, classGradesB, makeSubjectMap())
    expect(result).toHaveLength(3) // 张三、李四、王五
    const names = result.map((r) => r.studentName)
    expect(names).toContain('张三')
    expect(names).toContain('李四')
    expect(names).toContain('王五')
  })

  it('conductDeltas 透传：{"张三": 5} → 张三的 conductDelta=5，其他学生=null', () => {
    const classGradesA = {
      '张三': [makeGrade({ subjectId: 'math', score: 80 })],
      '李四': [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 70 })],
    }
    const classGradesB = {
      '张三': [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })],
      '李四': [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 60, examId: 'exam-2' })],
    }
    const conductDeltas = { '张三': 5 }
    const result = compareClassGrades(classGradesA, classGradesB, makeSubjectMap(), conductDeltas)
    const zhangsan = result.find((r) => r.studentName === '张三')!
    const lisi = result.find((r) => r.studentName === '李四')!
    expect(zhangsan.conductDelta).toBe(5)
    expect(lisi.conductDelta).toBeNull()
  })
})

// =============================================================
// summarizeClassComparison
// =============================================================
describe('summarizeClassComparison', () => {
  it('空学生列表 → totalStudents=0, avgScoreDelta=0, mostImproved=null, subjectDeltas=[]', () => {
    const summary = summarizeClassComparison([])
    expect(summary.totalStudents).toBe(0)
    expect(summary.avgScoreDelta).toBe(0)
    expect(summary.mostImprovedStudent).toBeNull()
    expect(summary.mostImprovedDelta).toBeNull()
    expect(summary.mostDeclinedStudent).toBeNull()
    expect(summary.mostDeclinedDelta).toBeNull()
    expect(summary.subjectDeltas).toEqual([])
  })

  it('单学生有正 delta → mostImprovedStudent=该生, mostDeclinedStudent=该生', () => {
    // 张三：两场都考 math，scoreA=80, scoreB=100 → totalScoreDelta=20
    const zhangsan = compareStudentGrades(
      [makeGrade({ subjectId: 'math', score: 80 })],
      [makeGrade({ subjectId: 'math', score: 100, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    const summary = summarizeClassComparison([zhangsan])
    expect(summary.totalStudents).toBe(1)
    expect(summary.avgScoreDelta).toBe(20)
    expect(summary.mostImprovedStudent).toBe('张三')
    expect(summary.mostImprovedDelta).toBe(20)
    // 正 delta 时，根据循环逻辑 both 都会被设为同一个学生
    expect(summary.mostDeclinedStudent).toBe('张三')
    expect(summary.mostDeclinedDelta).toBe(20)
  })

  it('多学生：进步最多和退步最多分别是不同学生', () => {
    // 张三：totalScoreDelta=+10
    const zhangsan = compareStudentGrades(
      [makeGrade({ subjectId: 'math', score: 80 })],
      [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    // 李四：totalScoreDelta=-15
    const lisi = compareStudentGrades(
      [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 85 })],
      [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 70, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    const summary = summarizeClassComparison([zhangsan, lisi])
    expect(summary.mostImprovedStudent).toBe('张三')
    expect(summary.mostImprovedDelta).toBe(10)
    expect(summary.mostDeclinedStudent).toBe('李四')
    expect(summary.mostDeclinedDelta).toBe(-15)
    // 平均：(10 + -15) / 2 = -2.5
    expect(summary.avgScoreDelta).toBe(-2.5)
  })

  it('总分 delta 为 null 的学生不计入平均（缺考学生）', () => {
    // 张三：有效 delta=10
    const zhangsan = compareStudentGrades(
      [makeGrade({ subjectId: 'math', score: 80 })],
      [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    // 李四：examB 无 math，totalScoreDelta=null
    const lisi = compareStudentGrades(
      [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 80 })],
      [], // examB 没有
      makeSubjectMap(),
    )
    // 王五：有效 delta=-20
    const wangwu = compareStudentGrades(
      [makeGrade({ studentName: '王五', entity_id: 'e3', subjectId: 'math', score: 90 })],
      [makeGrade({ studentName: '王五', entity_id: 'e3', subjectId: 'math', score: 70, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    const summary = summarizeClassComparison([zhangsan, lisi, wangwu])
    // 只算 张三(10) 和 王五(-20)，平均 = (10 + -20) / 2 = -5
    expect(summary.avgScoreDelta).toBe(-5)
    expect(summary.totalStudents).toBe(3) // 总人数包含 null 的
  })

  it('subjectDeltas 计算平均：两学生 math 都进步(+10, +20) → avgDelta=15', () => {
    const zhangsan = compareStudentGrades(
      [makeGrade({ subjectId: 'math', score: 80 })],
      [makeGrade({ subjectId: 'math', score: 90, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    const lisi = compareStudentGrades(
      [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 70 })],
      [makeGrade({ studentName: '李四', entity_id: 'e2', subjectId: 'math', score: 90, examId: 'exam-2' })],
      makeSubjectMap(),
    )
    const summary = summarizeClassComparison([zhangsan, lisi])
    expect(summary.subjectDeltas).toHaveLength(1)
    expect(summary.subjectDeltas[0].subjectId).toBe('math')
    expect(summary.subjectDeltas[0].subjectName).toBe('数学')
    expect(summary.subjectDeltas[0].avgDelta).toBe(15) // (10+20)/2
    expect(summary.subjectDeltas[0].sampleCount).toBe(2)
  })

  it('subjectDeltas 只统计有 scoreDelta 的科目（null 的不计）', () => {
    // 张三 math 缺考：scoreDelta=null；chinese 正常：scoreDelta=5
    const zhangsan = compareStudentGrades(
      [
        makeGrade({ subjectId: 'math', score: 80 }),
        makeGrade({ subjectId: 'chinese', score: 70 }),
      ],
      [
        makeGrade({ subjectId: 'chinese', score: 75, examId: 'exam-2' }),
        // examB 无 math
      ],
      makeSubjectMap(),
    )
    const summary = summarizeClassComparison([zhangsan])
    // math scoreDelta=null 被过滤；只剩 chinese，avgDelta=5, sampleCount=1
    expect(summary.subjectDeltas).toHaveLength(1)
    expect(summary.subjectDeltas[0].subjectId).toBe('chinese')
    expect(summary.subjectDeltas[0].avgDelta).toBe(5)
    expect(summary.subjectDeltas[0].sampleCount).toBe(1)
  })
})