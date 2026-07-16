// =============================================================
// Skill Service 测试 — skill 列表、读取、写入、删除
// 覆盖：listSkills/getSkill/saveSkill/deleteSkill、YAML frontmatter
// =============================================================

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpDir = path.join(
  os.tmpdir(),
  `skill-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
)

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'userData') return tmpDir
    throw new Error(`Unexpected path: ${name}`)
  }),
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    isPackaged: false, // 关键:开发模式
  },
}))

const { skillService } = await import('../../src/main/services/skill-service')

// skill-service 构造时会读项目 skills 目录: app.isPackaged=false 时是 __dirname/../../skills
// 在测试中这个目录可能不存在(无 project skills),应静默返回 []
// 用户 skills 目录: userData/skills

describe('skillService', () => {
  beforeAll(async () => {
    await fsp.mkdir(path.join(tmpDir, 'skills'), { recursive: true })
  })

  afterAll(async () => {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    // 清理用户 skills 目录中的文件
    try {
      const dir = path.join(tmpDir, 'skills')
      const files = await fsp.readdir(dir)
      for (const f of files) await fsp.unlink(path.join(dir, f))
    } catch {
      /* ignore */
    }
  })

  it('listSkills 应返回数组', async () => {
    const skills = await skillService.listSkills()
    expect(Array.isArray(skills)).toBe(true)
  })

  it('saveSkill + getSkill 应往返一致', async () => {
    const result = await skillService.saveSkill('test-skill', '# Test Skill\n\nBody content')
    expect(result.success).toBe(true)
    const got = await skillService.getSkill('test-skill')
    expect(got).toBeTruthy()
    expect(got?.content).toBe('# Test Skill\n\nBody content')
    expect(got?.name).toBe('test-skill')
    expect(got?.source).toBe('user')
  })

  it('listSkills 应包含已保存的 skill', async () => {
    await skillService.saveSkill('skill-a', 'Content A')
    await skillService.saveSkill('skill-b', 'Content B')
    const skills = await skillService.listSkills()
    const names = skills.map((s) => s.name)
    expect(names).toContain('skill-a')
    expect(names).toContain('skill-b')
  })

  it('deleteSkill 应移除 user skill', async () => {
    await skillService.saveSkill('temp-skill', 'temp')
    const delResult = await skillService.deleteSkill('temp-skill')
    expect(delResult.success).toBe(true)
    expect(await skillService.getSkill('temp-skill')).toBeNull()
  })

  it('getSkill 不存在应返回 null', async () => {
    expect(await skillService.getSkill('nonexistent-xxx')).toBeNull()
  })

  it('saveSkill 含特殊字符名称应被拒绝', async () => {
    const result = await skillService.saveSkill('invalid/name', 'x')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/reserved|invalid/i)
  })

  it('saveSkill 含空名称应被拒绝', async () => {
    const result = await skillService.saveSkill('', 'x')
    expect(result.success).toBe(false)
  })

  it('overwrite saveSkill 应替换内容', async () => {
    await skillService.saveSkill('overwrite-skill', 'first')
    await skillService.saveSkill('overwrite-skill', 'second')
    const got = await skillService.getSkill('overwrite-skill')
    expect(got?.content).toBe('second')
  })

  it('YAML frontmatter 描述解析', async () => {
    const content = '---\ndescription: 我的自定义技能\n---\n\n# Title\n\nContent'
    await skillService.saveSkill('fm-skill', content)
    const got = await skillService.getSkill('fm-skill')
    expect(got?.description).toBe('我的自定义技能')
  })

  it('无 frontmatter 时取首段非标题文字', async () => {
    const content = '这是第一段描述。\n\n# Title'
    await skillService.saveSkill('no-fm-skill', content)
    const got = await skillService.getSkill('no-fm-skill')
    expect(got?.description).toBe('这是第一段描述。')
  })

  it('中文 / emoji 描述应正常保存', async () => {
    const content = '中文 content / emoji 🎉 / <html>tags</html>'
    await skillService.saveSkill('unicode-skill', content)
    const got = await skillService.getSkill('unicode-skill')
    expect(got?.content).toBe(content)
  })
})
