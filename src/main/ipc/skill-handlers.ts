// =============================================================
// 技能 IPC 处理器
// C-2 修复: 所有参数增加类型和格式验证,防止路径遍历/命令注入
// =============================================================

import { type BrowserWindow, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { skillService } from '../services/skill-service'

/** C-2 修复: 验证技能名称(文件名安全) */
function validateSkillName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('name must be a non-empty string')
  }
  if (name.length > 128) {
    throw new Error('name too long (max 128 chars)')
  }
  // 拒绝路径分隔符和危险字符
  if (/[/\\]|\.\.|\0/.test(name)) {
    throw new Error('name contains invalid characters')
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
