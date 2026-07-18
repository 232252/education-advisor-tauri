// =============================================================
// 技能 IPC 处理器
// C-2 修复: 所有参数增加类型和格式验证,防止路径遍历/命令注入
// =============================================================

import { type BrowserWindow, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { isValidSkillName, skillService } from '../services/skill-service'

/**
 * C-2 修复: 验证技能名称(文件名安全)。
 * R4-4 修复: 复用 skill-service 的 isValidSkillName(单点真相),
 * 消除此前 handler/service 两套不一致的 regex。
 */
function validateSkillName(name: unknown): string {
  if (!isValidSkillName(name)) {
    throw new Error('name must be a valid skill name (non-empty, ≤128 chars, no path/reserved chars)')
  }
  return name
}

export function registerSkillHandlers(_win: BrowserWindow) {
  ipcMain.handle(IPC.IPC_SKILL_LIST, async () => {
    try {
      return await skillService.listSkills()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] skill:list failed:', msg)
      return []
    }
  })

  ipcMain.handle(IPC.IPC_SKILL_GET, async (_e, name: string) => {
    try {
      return await skillService.getSkill(validateSkillName(name))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] skill:get failed:', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(IPC.IPC_SKILL_SAVE, async (_e, name: string, content: string) => {
    try {
      const safeName = validateSkillName(name)
      if (typeof content !== 'string') {
        throw new Error('content must be a string')
      }
      if (content.length > 1024 * 1024) {
        throw new Error('content too large (max 1MB)')
      }
      // P4 修复: 拒绝 null byte,防止注入到 .md 文件下游解析
      if (content.includes('\0')) {
        throw new Error('content contains null byte')
      }
      return await skillService.saveSkill(safeName, content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] skill:save failed:', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(IPC.IPC_SKILL_DELETE, async (_e, name: string) => {
    try {
      return await skillService.deleteSkill(validateSkillName(name))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] skill:delete failed:', msg)
      return { success: false, error: msg }
    }
  })

  console.log('[IPC] Skill handlers registered')
}
