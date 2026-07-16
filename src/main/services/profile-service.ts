// =============================================================
// Student Profile Service — 学生扩展档案存储
// 存储于 eaa-data/profiles/{name}.json
// =============================================================

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { StudentProfileData } from '../../shared/types'

class ProfileService {
  private profilesDir: string

  constructor() {
    this.profilesDir = path.join(app.getPath('userData'), 'eaa-data', 'profiles')
    // 确保目录存在
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true })
    }
  }

  private profilePath(name: string): string {
    // 防止路径遍历攻击
    const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
    return path.join(this.profilesDir, `${safeName}.json`)
  }

  /** 读取学生扩展档案 */
  async get(name: string): Promise<StudentProfileData> {
    const filePath = this.profilePath(name)
    try {
      await fsp.access(filePath)
    } catch {
      return {}
    }
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      return JSON.parse(content) as StudentProfileData
    } catch {
      return {}
    }
  }

  /** 写入学生扩展档案（全量覆盖） */
  async set(name: string, data: StudentProfileData): Promise<{ success: boolean; error?: string }> {
    try {
      const filePath = this.profilePath(name)
      const tmpPath = `${filePath}.tmp`
      const json = JSON.stringify(data, null, 2)
      await fsp.writeFile(tmpPath, json, 'utf-8')
      await fsp.rename(tmpPath, filePath)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  /** 部分更新学生扩展档案（合并） */
  async update(name: string, patch: Partial<StudentProfileData>): Promise<{ success: boolean; error?: string }> {
    const existing = await this.get(name)
    const merged = { ...existing, ...patch }
    return this.set(name, merged)
  }
}

export const profileService = new ProfileService()
