// =============================================================
// McpServerCard — MCP 服务器详情卡片(右侧详情区)
// 展示单个 server 的状态、元信息、工具列表(可折叠)及操作按钮:
// 测试 / 连接 / 断开 / 编辑 / 删除 / 启用开关。
// 由 McpTab 选中列表项后渲染,所有副作用通过回调上抛。
// =============================================================

import type { McpServerStatus, McpTool } from '@shared/types'
import { useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { useT } from '../../../i18n'
import { cn } from '../../../lib/ui-utils'

interface McpServerCardProps {
  server: McpServerStatus
  tools: McpTool[]
  toolsLoading: boolean
  onTest: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
  onToggleEnabled: (enabled: boolean) => void
}

export function McpServerCard({
  server,
  tools,
  toolsLoading,
  onTest,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onToggleEnabled,
}: McpServerCardProps) {
  const { t } = useT()
  const [showTools, setShowTools] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const statusColor = server.connected
    ? 'bg-green-500'
    : server.lastError
      ? 'bg-red-500'
      : 'bg-gray-400'

  const statusText = server.connected
    ? t('page.mcp.status.connected')
    : server.lastError
      ? t('page.mcp.status.error')
      : t('page.mcp.status.disconnected')

  return (
    <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      {/* 头部:名称 + 来源 badge */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={cn('inline-block w-2 h-2 rounded-full', statusColor)} />
          <h3 className="font-medium text-gray-900 dark:text-gray-100">{server.name}</h3>
          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
            {server.source === 'global' ? t('page.mcp.source.global') : t('page.mcp.source.user')}
          </span>
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            className="rounded"
          />
          {t('page.mcp.field.enabled')}
        </label>
      </div>

      {/* 元信息 */}
      <dl className="text-sm space-y-1 text-gray-600 dark:text-gray-400 mb-3">
        <div>
          <dt className="inline font-medium">id:</dt>
          <dd className="inline ml-2 font-mono">{server.id}</dd>
        </div>
        <div>
          <dt className="inline font-medium">{t('page.mcp.field.transport')}:</dt>
          <dd className="inline ml-2">{t(`page.mcp.transport.${server.transport}`)}</dd>
        </div>
        <div>
          <dt className="inline font-medium">{t('page.mcp.tools')}:</dt>
          <dd className="inline ml-2">
            {statusText}
            {server.connected && ` (${tools.length})`}
          </dd>
          {server.lastError && (
            <span className="block ml-2 text-red-500 text-xs mt-1">{server.lastError}</span>
          )}
        </div>
      </dl>

      {/* 工具列表(可折叠) */}
      {server.connected && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowTools(!showTools)}
            className="text-xs text-blue-500 hover:text-blue-600"
          >
            {showTools ? '▼' : '▶'} {t('page.mcp.tools')} ({toolsLoading ? '...' : tools.length})
          </button>
          {showTools && (
            <ul className="mt-2 ml-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
              {tools.map((tool) => (
                <li key={tool.name} className="font-mono">
                  <span className="text-blue-500">{tool.name}</span>
                  {tool.description && (
                    <span className="text-gray-400 ml-2">— {tool.description}</span>
                  )}
                </li>
              ))}
              {tools.length === 0 && !toolsLoading && (
                <li className="text-gray-400 italic">{t('page.mcp.tools.empty')}</li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onTest}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {t('page.mcp.test')}
        </button>
        {server.connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t('page.mcp.disconnect')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="px-3 py-1 text-xs rounded border border-blue-500 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20"
          >
            {t('page.mcp.connect')}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {t('page.mcp.edit')}
        </button>
        {server.source === 'user' && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="px-3 py-1 text-xs rounded border border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            {t('page.mcp.delete')}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        message={t('page.mcp.confirm.delete').replace('{name}', server.name)}
        variant="danger"
        onConfirm={() => {
          setConfirmOpen(false)
          onDelete()
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
