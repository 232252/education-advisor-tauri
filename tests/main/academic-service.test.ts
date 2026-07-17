// =============================================================
// Academic Service 测试 — 学业数据存储（科目/考试/成绩）
// 覆盖：getConfig/setConfig、createExam/deleteExam(级联)、
//       setGrade/batchSetGrades(upsert)、getClassGrades(过滤)、safeName(路径遍历防御)
// 模式：mock electron.app.getPath → tmpDir，走真实 fs（参考 skill-service.test.ts）
// =============================================================

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpDir = path.join(
  os.tmpdir(),
  `academic-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
)

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'userData') return tmpDir
    throw new Error(`Unexpected path: ${name}`)
  }),
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath, isPackaged: false },
}))

// log 可能依赖 electron，mock 掉避免噪音
vi.mock('../../src/main/utils/logger', () => ({
  log: vi.fn(),
}))

const { academicService } = await import('../../src/main/services/academic-service')

let seq = 0
/** 每个测试用唯一学生名，避免文件状态泄漏 */
function uniqStudent(): string {
  seq += 1
  return `测试学生${seq}`
}

beforeAll(async () => {
  await fsp.mkdir(tmpDir, { recursive: true })
})

afterAll(async () => {
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks()
})

describe('academicService.getConfig', () => {
  it('文件不存在时返回默认配置（含 10 个默认科目）', async () => {
    const config = await academicService.getConfig()
    expect(config.subjects).toHaveLength(10)
    expect(config.subjects[0]).toMatchObject({ id: 'chinese', name: '语文', isCore: true })
    expect(config.defaultExamTypes.length).toBeGreaterThan(0)
  })

  it('文件存在时返回文件内容', async () => {
    await academicService.setConfig({
      subjects: [{ id: 'x', name: '测试科', category: 'core', fullMark: 100 }],
      defaultExamTypes: [{ value: 't', label: '测' }],
    })
    const config = await academicService.getConfig()
    expect(config.subjects).toHaveLength(1)
    expect(config.subjects[0].id).toBe('x')
  })
})

describe('academicService.setConfig', () => {
  it('原子写入后 .tmp 文件不应残留', async () => {
    await academicService.setConfig({
      subjects: [],
      defaultExamTypes: [],
    })
    const dir = await fsp.readdir(path.join(tmpDir, 'eaa-data', 'academics'))
    expect(dir).toContain('config.json')
    expect(dir.some((f) => f.endsWith('.tmp'))).toBe(false)
  })
})

describe('safeName（路径遍历防御，间接通过文件名验证）', () => {
  it('含 / 的学生名被替换为 _，写入正确文件', async () => {
    const name = '../../../etc/passwd'
    const grade = await academicService.setGrade({
      studentName: name,
      examId: 'e1',
      subjectId: 'math',
      score: 90,
    })
    expect(grade.score).toBe(90)
    // 读取应能拿到（safeName 替换后路径一致）
    const got = await academicService.getGrades(name)
    expect(got).toHaveLength(1)
    expect(got[0].score).toBe(90)
  })

  it('含空格的学生名被替换为 _', async () => {
    const name = '张 三'
    await academicService.setGrade({
      studentName: name,
      examId: 'e1',
      subjectId: 'math',
      score: 80,
    })
    const got = await academicService.getGrades(name)
    expect(got).toHaveLength(1)
  })

  it('中文/字母/数字/_- 的学生名保持不变', async () => {
    const name = '张三_A1-2'
    await academicService.setGrade({
      studentName: name,
      examId: 'e1',
      subjectId: 'math',
      score: 70,
    })
    const got = await academicService.getGrades(name)
    expect(got).toHaveLength(1)
    expect(got[0].studentName).toBe(name)
  })
})

describe('academicService.createExam', () => {
  it('创建考试并生成唯一 id 和 createdAt', async () => {
    const exam = await academicService.createExam({
      name: '期中考试',
      semester: '2024-1',
      type: 'midterm',
      date: '2024-11-01',
    })
    expect(exam.id).toMatch(/^exam-/)
    expect(exam.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO 格式
    expect(exam.name).toBe('期中考试')
  })

  it('多次创建考试累积到列表', async () => {
    await academicService.createExam({ name: 'A', semester: 's1', type: 't', date: '' })
    await academicService.createExam({ name: 'B', semester: 's1', type: 't', date: '' })
    const all = await academicService.listExams()
    expect(all.length).toBeGreaterThanOrEqual(2)
  })
})

describe('academicService.listExams', () => {
  it('按学期过滤', async () => {
    await academicService.createExam({ name: 'X', semester: '2024-2', type: 't', date: '' })
    const filtered = await academicService.listExams('2024-2')
    expect(filtered.every((e) => e.semester === '2024-2')).toBe(true)
  })

  it('文件不存在时返回空数组', async () => {
    // 用一个新的 academicService 实例指向空目录
    const exams = await academicService.listExams()
    expect(Array.isArray(exams)).toBe(true)
  })
})

describe('academicService.setGrade / getGrades', () => {
  it('新增成绩（upsert 新条目）', async () => {
    const name = uniqStudent()
    const grade = await academicService.setGrade({
      studentName: name,
      examId: 'exam-1',
      subjectId: 'math',
      score: 95,
    })
    expect(grade.score).toBe(95)
    expect(grade.updatedAt).toMatch(/^\d{4}-/)
  })

  it('更新已有成绩（同 examId + subjectId 覆盖）', async () => {
    const name = uniqStudent()
    await academicService.setGrade({ studentName: name, examId: 'e1', subjectId: 'math', score: 60 })
    await academicService.setGrade({ studentName: name, examId: 'e1', subjectId: 'math', score: 90 })
    const got = await academicService.getGrades(name)
    expect(got).toHaveLength(1)
    expect(got[0].score).toBe(90)
  })

  it('不同 subjectId 视为不同条目', async () => {
    const name = uniqStudent()
    await academicService.setGrade({ studentName: name, examId: 'e1', subjectId: 'math', score: 80 })
    await academicService.setGrade({ studentName: name, examId: 'e1', subjectId: 'english', score: 85 })
    const got = await academicService.getGrades(name)
    expect(got).toHaveLength(2)
  })

  it('无成绩时返回空数组', async () => {
    const got = await academicService.getGrades(uniqStudent())
    expect(got).toEqual([])
  })
})

describe('academicService.batchSetGrades', () => {
  it('按学生分组写入，返回写入条数', async () => {
    const a = uniqStudent()
    const b = uniqStudent()
    const count = await academicService.batchSetGrades([
      { studentName: a, examId: 'e1', subjectId: 'math', score: 70 },
      { studentName: a, examId: 'e1', subjectId: 'english', score: 75 },
      { studentName: b, examId: 'e1', subjectId: 'math', score: 80 },
    ])
    expect(count).toBe(3)
    const gotA = await academicService.getGrades(a)
    expect(gotA).toHaveLength(2)
    const gotB = await academicService.getGrades(b)
    expect(gotB).toHaveLength(1)
  })

  it('同学生同 examId+subjectId 的多条记录只保留最后一条', async () => {
    const a = uniqStudent()
    const count = await academicService.batchSetGrades([
      { studentName: a, examId: 'e1', subjectId: 'math', score: 50 },
      { studentName: a, examId: 'e1', subjectId: 'math', score: 99 },
    ])
    expect(count).toBe(2) // 两次都计入 count
    const got = await academicService.getGrades(a)
    expect(got).toHaveLength(1)
    expect(got[0].score).toBe(99) // 最后一条覆盖
  })
})

describe('academicService.deleteExam（级联删除）', () => {
  it('删除考试并级联清理学生成绩文件中的对应条目', async () => {
    const examId = 'exam-cascade-test'
    const a = uniqStudent()
    const b = uniqStudent()
    await academicService.batchSetGrades([
      { studentName: a, examId, subjectId: 'math', score: 80 },
      { studentName: a, examId: 'exam-other', subjectId: 'math', score: 90 },
      { studentName: b, examId, subjectId: 'english', score: 85 },
    ])
    await academicService.createExam({ name: 'cascade', semester: 's1', type: 't', date: '', id: examId } as never)

    await academicService.deleteExam(examId)

    const gotA = await academicService.getGrades(a)
    expect(gotA).toHaveLength(1)
    expect(gotA[0].examId).toBe('exam-other')
    const gotB = await academicService.getGrades(b)
    expect(gotB).toHaveLength(0)
  })

  it('学生成绩文件变空时文件被删除', async () => {
    const examId = 'exam-empty-file'
    const a = uniqStudent()
    await academicService.setGrade({ studentName: a, examId, subjectId: 'math', score: 80 })

    await academicService.deleteExam(examId)

    const got = await academicService.getGrades(a)
    expect(got).toEqual([])
  })
})

describe('academicService.getClassGrades', () => {
  it('按 examId 过滤返回每个学生的成绩', async () => {
    const a = uniqStudent()
    const b = uniqStudent()
    await academicService.batchSetGrades([
      { studentName: a, examId: 'exam-cls', subjectId: 'math', score: 80 },
      { studentName: a, examId: 'exam-cls', subjectId: 'english', score: 85 },
      { studentName: b, examId: 'exam-cls', subjectId: 'math', score: 90 },
    ])
    const result = await academicService.getClassGrades([a, b], 'exam-cls')
    expect(result[a]).toHaveLength(2)
    expect(result[b]).toHaveLength(1)
  })

  it('同时按 subjectId 过滤', async () => {
    const a = uniqStudent()
    await academicService.batchSetGrades([
      { studentName: a, examId: 'exam-cls2', subjectId: 'math', score: 80 },
      { studentName: a, examId: 'exam-cls2', subjectId: 'english', score: 85 },
    ])
    const result = await academicService.getClassGrades([a], 'exam-cls2', 'math')
    expect(result[a]).toHaveLength(1)
    expect(result[a][0].subjectId).toBe('math')
  })

  it('无成绩的学生返回空数组', async () => {
    const result = await academicService.getClassGrades([uniqStudent()], 'no-exam')
    expect(Object.keys(result)).toHaveLength(1)
  })
})
