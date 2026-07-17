// =============================================================
// Class Service 测试 — 班级管理 CRUD（存档/恢复/删除/校验）
// 覆盖：validateClassId/validateName、create/update/archive/restore/delete、list/toEntity
// 模式：mock dbService（class-service 唯一外部依赖），无需 mock electron
// =============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock dbService：class-service 的唯一依赖
const mocks = vi.hoisted(() => ({
  listClasses: vi.fn(() => []),
  getClassByClassId: vi.fn(() => undefined),
  insertClass: vi.fn(() => true),
  updateClass: vi.fn(() => true),
  getClassById: vi.fn(() => undefined),
  deleteClass: vi.fn(() => true),
  getLastError: vi.fn(() => null),
}))

vi.mock('../../src/main/services/db-service', () => ({
  dbService: {
    listClasses: mocks.listClasses,
    getClassByClassId: mocks.getClassByClassId,
    insertClass: mocks.insertClass,
    updateClass: mocks.updateClass,
    getClassById: mocks.getClassById,
    deleteClass: mocks.deleteClass,
    getLastError: mocks.getLastError,
  },
}))

const { classService } = await import('../../src/main/services/class-service')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('classService.list', () => {
  it('空列表返回空数组', () => {
    mocks.listClasses.mockReturnValue([])
    expect(classService.list()).toEqual([])
  })

  it('将 DB 行（archived 0/1）映射为实体（archived boolean）', () => {
    mocks.listClasses.mockReturnValue([
      {
        id: 'r1', class_id: 'G7-1', name: '七年级1班', grade: '七年级',
        note: null, archived: 0, created_at: 1000, archived_at: null, teacher: '张老师',
      },
      {
        id: 'r2', class_id: 'G7-2', name: '七年级2班', grade: null,
        note: '备注', archived: 1, created_at: 2000, archived_at: 5000, teacher: null,
      },
    ])
    const list = classService.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      id: 'r1', class_id: 'G7-1', name: '七年级1班', grade: '七年级',
      note: undefined, archived: false, created_at: 1000, archived_at: undefined, teacher: '张老师',
    })
    expect(list[1].archived).toBe(true)
    expect(list[1].archived_at).toBe(5000)
    expect(list[1].grade).toBeUndefined()
    expect(list[1].teacher).toBeUndefined()
  })
})

describe('classService.create', () => {
  it('成功创建班级', () => {
    mocks.getClassByClassId.mockReturnValue(undefined)
    mocks.insertClass.mockReturnValue(true)
    const res = classService.create({ class_id: 'G7-3', name: '七年级3班' })
    expect(res.success).toBe(true)
    expect(res.data?.class_id).toBe('G7-3')
    expect(res.data?.archived).toBe(false)
    expect(mocks.insertClass).toHaveBeenCalledOnce()
  })

  it('class_id 已存在时返回错误', () => {
    mocks.getClassByClassId.mockReturnValue({ class_id: 'G7-3' })
    const res = classService.create({ class_id: 'G7-3', name: '七年级3班' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('已存在')
    expect(mocks.insertClass).not.toHaveBeenCalled()
  })

  it('DB 写入失败时返回 getLastError', () => {
    mocks.getClassByClassId.mockReturnValue(undefined)
    mocks.insertClass.mockReturnValue(false)
    mocks.getLastError.mockReturnValue('UNIQUE constraint failed')
    const res = classService.create({ class_id: 'G7-3', name: '七年级3班' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('UNIQUE constraint failed')
  })

  it('class_id 为空时校验失败', () => {
    const res = classService.create({ class_id: '  ', name: '七年级3班' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('empty')
  })

  it('class_id 含非法字符时校验失败', () => {
    const res = classService.create({ class_id: 'G7 3', name: '七年级3班' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('alphanumeric')
  })

  it('class_id 超长（>32）时校验失败', () => {
    const res = classService.create({ class_id: 'A'.repeat(33), name: '班' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('too long')
  })

  it('班级名称为空时校验失败', () => {
    const res = classService.create({ class_id: 'G7-3', name: '' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('不能为空')
  })

  it('班级名称以 -- 开头时校验失败', () => {
    const res = classService.create({ class_id: 'G7-3', name: '--注入' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('--')
  })

  it('grade/note/teacher 空白字符串被裁剪为 null/undefined', () => {
    mocks.getClassByClassId.mockReturnValue(undefined)
    mocks.insertClass.mockReturnValue(true)
    classService.create({ class_id: 'G7-3', name: '班', grade: '  ', note: '  ', teacher: '  ' })
    const record = mocks.insertClass.mock.calls[0][0]
    expect(record.grade).toBeUndefined()
    expect(record.note).toBeUndefined()
    expect(record.teacher).toBeNull()
  })
})

describe('classService.update', () => {
  it('成功更新名称', () => {
    mocks.updateClass.mockReturnValue(true)
    const res = classService.update('r1', { name: '新名称' })
    expect(res.success).toBe(true)
    expect(mocks.updateClass).toHaveBeenCalledWith('r1', { name: '新名称' })
  })

  it('teacher 空字符串裁剪为 null', () => {
    mocks.updateClass.mockReturnValue(true)
    classService.update('r1', { teacher: '  ' })
    expect(mocks.updateClass.mock.calls[0][1].teacher).toBeNull()
  })

  it('teacher 有值时保留 trim 结果', () => {
    mocks.updateClass.mockReturnValue(true)
    classService.update('r1', { teacher: '  张老师  ' })
    expect(mocks.updateClass.mock.calls[0][1].teacher).toBe('张老师')
  })

  it('grade 空字符串裁剪为 null', () => {
    mocks.updateClass.mockReturnValue(true)
    classService.update('r1', { grade: '  ' })
    expect(mocks.updateClass.mock.calls[0][1].grade).toBeNull()
  })

  it('更新失败时返回 getLastError', () => {
    mocks.updateClass.mockReturnValue(false)
    mocks.getLastError.mockReturnValue('not found')
    const res = classService.update('r1', { name: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('not found')
  })

  it('名称校验失败时不调用 DB', () => {
    const res = classService.update('r1', { name: '--bad' })
    expect(res.success).toBe(false)
    expect(mocks.updateClass).not.toHaveBeenCalled()
  })

  it('undefined 字段不传入更新对象', () => {
    mocks.updateClass.mockReturnValue(true)
    classService.update('r1', { name: 'x' })
    const update = mocks.updateClass.mock.calls[0][1]
    expect(update).toEqual({ name: 'x' })
    expect(update).not.toHaveProperty('grade')
  })
})

describe('classService.archive / restore', () => {
  it('archive 成功并设置 archived_at 时间戳', () => {
    mocks.updateClass.mockReturnValue(true)
    const before = Date.now()
    const res = classService.archive('r1')
    expect(res.success).toBe(true)
    const [, patch] = mocks.updateClass.mock.calls[0]
    expect(patch.archived).toBe(1)
    expect(patch.archived_at).toBeGreaterThanOrEqual(before)
  })

  it('archive 班级不存在时失败', () => {
    mocks.updateClass.mockReturnValue(false)
    mocks.getLastError.mockReturnValue(null)
    const res = classService.archive('r1')
    expect(res.success).toBe(false)
    expect(res.error).toBe('班级不存在')
  })

  it('restore 成功并清除 archived_at', () => {
    mocks.updateClass.mockReturnValue(true)
    const res = classService.restore('r1')
    expect(res.success).toBe(true)
    const [, patch] = mocks.updateClass.mock.calls[0]
    expect(patch.archived).toBe(0)
    expect(patch.archived_at).toBeNull()
  })

  it('restore 班级不存在时失败', () => {
    mocks.updateClass.mockReturnValue(false)
    const res = classService.restore('r1')
    expect(res.success).toBe(false)
  })
})

describe('classService.delete', () => {
  it('成功删除并返回 class_id', () => {
    mocks.getClassById.mockReturnValue({ id: 'r1', class_id: 'G7-3' })
    mocks.deleteClass.mockReturnValue(true)
    const res = classService.delete('r1')
    expect(res.success).toBe(true)
    expect(res.classId).toBe('G7-3')
  })

  it('班级不存在时返回错误', () => {
    mocks.getClassById.mockReturnValue(undefined)
    const res = classService.delete('r1')
    expect(res.success).toBe(false)
    expect(res.error).toBe('班级不存在')
    expect(mocks.deleteClass).not.toHaveBeenCalled()
  })

  it('DB 删除失败时返回 getLastError', () => {
    mocks.getClassById.mockReturnValue({ id: 'r1', class_id: 'G7-3' })
    mocks.deleteClass.mockReturnValue(false)
    mocks.getLastError.mockReturnValue('constraint')
    const res = classService.delete('r1')
    expect(res.success).toBe(false)
    expect(res.error).toBe('constraint')
  })
})
