/**
 * 预设 MCP server 模板(种子数据,用户可任意修改)
 *
 * 注意:`${VAR}` 形式是后端 deepInterpolate 占位符(见 src/main/services/mcp-helpers.ts),
 * 不是 JS 模板字符串,不需要反斜杠转义。biome 的 noTemplateCurlyInString 在此误报。
 */
/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: 占位符由后端 deepInterpolate 处理 */
import type { McpServerConfig } from '@shared/types'

/** 预设 MCP server 模板(种子数据,用户可任意修改) */
export interface McpPreset {
  /** i18n key 后缀,对应 page.mcp.preset.<suffix> */
  i18nSuffix: string
  config: McpServerConfig
}

export const MCP_PRESETS: McpPreset[] = [
  {
    i18nSuffix: 'filesystem',
    config: {
      id: 'filesystem',
      name: '本地文件系统',
      description: '让 Agent 读写本地文档目录',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '${USER_DOCS}'],
      env: {
        USER_DOCS: '${env.USERPROFILE}/Documents',
      },
    },
  },
  {
    i18nSuffix: 'websearch',
    config: {
      id: 'web-search',
      name: '网页搜索',
      description: '让 Agent 搜索互联网(需要 API key)',
      enabled: true,
      transport: 'sse',
      url: 'https://mcpsearch.example.com/sse',
      headers: {
        Authorization: 'Bearer ${MCP_SEARCH_KEY}',
      },
    },
  },
  {
    i18nSuffix: 'sqlite',
    config: {
      id: 'sqlite',
      name: 'SQLite 数据库',
      description: '查询本地 SQLite 数据库',
      enabled: true,
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', '${USER_DATA}/app.db'],
    },
  },
]
