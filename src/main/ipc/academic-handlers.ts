// =============================================================
// Academic IPC 处理器 — 科目/考试/成绩
// =============================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import type { AcademicConfig, ExamDef, GradeRecord } from '../../shared/types'
import { academicService } from '../services/academic-service'

/** 学生姓名安全过滤(与 profile-handlers 一致) */
function sanitizeName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('name must be a non-empty string')
  }
  if (name.length > 64) {
    throw new Error('name too long (max 64 chars)')
  }
  // 剥离不可见 Unicode 字符,保留常见姓名符号
  const cleaned = name
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g, '')
    .trim()
  if (cleaned.length === 0) {
    throw new Error('name is empty after cleaning')
  }
  // 拒绝控制字符(包括 NUL、换行符 \n \r、制表符等,防止参数注入和数据损坏)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char guard against injection
  if (/[\x00-\x1F\x7F]/.test(cleaned)) {
    throw new Error('name contains control characters')
  }
  if (/[`$;|&<>{}\\]/.test(cleaned)) {
    throw new Error('name contains illegal characters')
  }
  return cleaned
}

export function registerAcademicHandlers(): void {
  // 读取学业配置
  ipcMain.handle(IPC.IPC_ACADEMIC_GET_CONFIG, async () => {
    try {
      const data = await academicService.getConfig()
      return { success: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] academic:get-config failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 更新学业配置
  ipcMain.handle(IPC.IPC_ACADEMIC_SET_CONFIG, async (_e, config: AcademicConfig) => {
    try {
      if (!config || typeof config !== 'object') {
        throw new Error('config must be a non-null object')
      }
      if (!Array.isArray(config.subjects)) {
        throw new Error('config.subjects must be an array')
      }
      await academicService.setConfig(config)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] academic:set-config failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 列出考试(可选 ?semester=xxx)
  ipcMain.handle(IPC.IPC_ACADEMIC_LIST_EXAMS, async (_e, semester?: string) => {
    try {
      const data = await academicService.listExams(semester)
      return { success: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] academic:list-exams failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 新建考试
  ipcMain.handle(
    IPC.IPC_ACADEMIC_CREATE_EXAM,
    async (_e, exam: Omit<ExamDef, 'id' | 'createdAt'>) => {
      try {
        if (!exam || typeof exam !== 'object') {
          throw new Error('exam must be a non-null object')
        }
        if (!exam.name || typeof exam.name !== 'string') {
          throw new Error('exam.name is required')
        }
        if (!Array.isArray(exam.subjects)) {
          throw new Error('exam.subjects must be an array')
        }
        const data = await academicService.createExam(exam)
        return { success: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] academic:create-exam failed:', msg)
        return { success: false, error: msg }
      }
    },
  )

  // 删除考试
  ipcMain.handle(IPC.IPC_ACADEMIC_DELETE_EXAM, async (_e, examId: string) => {
    try {
      if (typeof examId !== 'string' || examId.trim().length === 0) {
        throw new Error('examId must be a non-empty string')
      }
      await academicService.deleteExam(examId)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] academic:delete-exam failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 读取学生成绩
  ipcMain.handle(IPC.IPC_ACADEMIC_GET_GRADES, async (_e, studentName: string) => {
    try {
      const safeName = sanitizeName(studentName)
      const data = await academicService.getGrades(safeName)
      return { success: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] academic:get-grades failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 设置单条成绩
  ipcMain.handle(IPC.IPC_ACADEMIC_SET_GRADE, async (_e, record: Omit<GradeRecord, 'updatedAt'>) => {
    try {
      if (!record || typeof record !== 'object') {
        throw new Error('record must be a non-null object')
      }
      if (typeof record.examId !== 'string' || !record.examId) {
        throw new Error('record.examId is required')
      }
      if (typeof record.subjectId !== 'string' || !record.subjectId) {
        throw new Error('record.subjectId is required')
      }
      record.studentName = sanitizeName(record.studentName)
      const data = await academicService.setGrade(record)
      return { success: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] academic:set-grade failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 批量设置成绩
  ipcMain.handle(
    IPC.IPC_ACADEMIC_BATCH_SET_GRADES,
    async (_e, records: Omit<GradeRecord, 'updatedAt'>[]) => {
      try {
        if (!Array.isArray(records)) {
          throw new Error('records must be an array')
        }
        for (const r of records) {
          if (!r || typeof r !== 'object') {
            throw new Error('each record must be a non-null object')
          }
          if (typeof r.examId !== 'string' || !r.examId) {
            throw new Error('each record must have examId')
          }
          if (typeof r.subjectId !== 'string' || !r.subjectId) {
            throw new Error('each record must have subjectId')
          }
          if (typeof r.studentName !== 'string' || !r.studentName) {
            throw new Error('each record must have studentName')
          }
          r.studentName = sanitizeName(r.studentName)
        }
        const count = await academicService.batchSetGrades(records)
        return { success: true, data: count }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] academic:batch-set-grades failed:', msg)
        return { success: false, error: msg }
      }
    },
  )

  // 读取班级成绩(参数: studentNames[], examId, subjectId?)
  ipcMain.handle(
    IPC.IPC_ACADEMIC_GET_CLASS_GRADES,
    async (_e, studentNames: string[], examId: string, subjectId?: string) => {
      try {
        if (!Array.isArray(studentNames)) {
          throw new Error('studentNames must be an array')
        }
        if (typeof examId !== 'string' || !examId) {
          throw new Error('examId must be a non-empty string')
        }
        const safeNames = studentNames.map((n) => sanitizeName(n))
        const data = await academicService.getClassGrades(safeNames, examId, subjectId)
        return { success: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] academic:get-class-grades failed:', msg)
        return { success: false, error: msg }
      }
    },
  )

  // 试卷分析 — 接收文件路径,返回题目分数和分析文本
  // 目前为占位实现:验证文件存在,返回空分析结果(后续可接入 AI/OCR)
  ipcMain.handle(
    IPC.IPC_ACADEMIC_ANALYZE_PAPER,
    async (_e, filePath: string, examId?: string, subjectId?: string) => {
      try {
        if (typeof filePath !== 'string' || filePath.trim().length === 0) {
          throw new Error('filePath must be a non-empty string')
        }

        // 验证文件是否存在
        try {
          const stat = await fsp.stat(filePath)
          if (!stat.isFile()) {
            throw new Error('path is not a file')
          }
          // 限制文件大小 (50MB)
          if (stat.size > 50 * 1024 * 1024) {
            throw new Error('file too large (max 50MB)')
          }
        } catch (statErr) {
          const msg = statErr instanceof Error ? statErr.message : String(statErr)
          throw new Error(`cannot access file: ${msg}`)
        }

        // 获取文件扩展名
        const ext = path.extname(filePath).toLowerCase()
        const supportedExts = ['.png', '.jpg', '.jpeg', '.pdf', '.webp', '.bmp']
        if (!supportedExts.includes(ext)) {
          throw new Error(`unsupported file type: ${ext} (supported: ${supportedExts.join(', ')})`)
        }

        // 占位分析结果 — 后续可接入 AI/OCR 服务
        const result = {
          filePath,
          fileName: path.basename(filePath),
          fileType: ext,
          examId: examId || null,
          subjectId: subjectId || null,
          questionScores: [] as number[],
          analysis: '试卷分析功能待接入 AI/OCR 服务。文件已验证,可手动录入各题分数。',
          analyzedAt: new Date().toISOString(),
        }

        console.log(`[IPC] academic:analyze-paper: ${result.fileName} (${ext})`)
        return { success: true, data: result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] academic:analyze-paper failed:', msg)
        return { success: false, error: msg }
      }
    },
  )

  console.log('[IPC] Academic handlers registered')
}
