// =============================================================
// 班级编号生成工具测试 — gradeToNumber / classNoFromName / computeAutoClassId
// 从 ClassesPage 提取的纯函数，覆盖中文年级/阿拉伯数字/混合/边界场景
// =============================================================

import { describe, expect, it } from 'vitest'
import { classNoFromName, computeAutoClassId, gradeToNumber } from '../../../src/renderer/pages/Classes/class-id'

describe('gradeToNumber', () => {
  it('中文年级 一~九 → 1~9', () => {
    expect(gradeToNumber('一年级')).toBe('1')
    expect(gradeToNumber('三年级')).toBe('3')
    expect(gradeToNumber('九年级')).toBe('9')
  })

  it('含阿拉伯数字的年级直接提取数字', () => {
    expect(gradeToNumber('7年级')).toBe('7')
    expect(gradeToNumber('高三3')).toBe('3')
  })

  it('中文优先于阿拉伯数字（七年级7班 → 7）', () => {
    // "七" 匹配在前，返回 7
    expect(gradeToNumber('七年级7班')).toBe('7')
  })

  it('空字符串返回 null', () => {
    expect(gradeToNumber('')).toBeNull()
  })

  it('无中文无数字返回 null', () => {
    expect(gradeToNumber('高年级')).toBeNull()
    expect(gradeToNumber('abc')).toBeNull()
  })

  it('十以上数字完整提取', () => {
    expect(gradeToNumber('12年级')).toBe('12')
  })

  it('混合中英文（初二）→ 2', () => {
    // "二" 在 cnMap 索引1
    expect(gradeToNumber('初二')).toBe('2')
  })
})

describe('classNoFromName', () => {
  it('从 "3班" 提取 3', () => {
    expect(classNoFromName('3班')).toBe('3')
  })

  it('从 "七年级3班" 提取首个数字 3（中文不算数字）', () => {
    expect(classNoFromName('七年级3班')).toBe('3')
  })

  it('无数字返回 null', () => {
    expect(classNoFromName('实验班')).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(classNoFromName('')).toBeNull()
  })

  it('十以上班号完整提取', () => {
    expect(classNoFromName('12班')).toBe('12')
  })
})

describe('computeAutoClassId', () => {
  it('七年级 + 3班 → G7-3', () => {
    expect(computeAutoClassId('七年级', '3班')).toBe('G7-3')
  })

  it('一年级 + 1班 → G1-1', () => {
    expect(computeAutoClassId('一年级', '1班')).toBe('G1-1')
  })

  it('九年级 + 9班 → G9-9', () => {
    expect(computeAutoClassId('九年级', '9班')).toBe('G9-9')
  })

  it('年级无法识别时返回 null', () => {
    expect(computeAutoClassId('高年级', '3班')).toBeNull()
    expect(computeAutoClassId('', '3班')).toBeNull()
  })

  it('班号无法识别时返回 null', () => {
    expect(computeAutoClassId('七年级', '实验班')).toBeNull()
    expect(computeAutoClassId('七年级', '')).toBeNull()
  })

  it('两者都无法识别时返回 null', () => {
    expect(computeAutoClassId('', '')).toBeNull()
  })

  it('阿拉伯数字年级也能生成', () => {
    expect(computeAutoClassId('7年级', '3班')).toBe('G7-3')
  })

  it('双位数年级/班号', () => {
    // 班号一般不超 20，但年级理论上可超（虽然少见）
    expect(computeAutoClassId('12年级', '5班')).toBe('G12-5')
  })
})
