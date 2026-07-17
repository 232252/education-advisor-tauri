import type { McpServerConfig, McpTransport } from '@shared/types'
import { useMemo, useState } from 'react'
import { useT } from '../../../i18n'
import { validateMcpConfig } from '../mcp-validate'

interface McpServerFormProps {
  initial: Partial<McpServerConfig> | null
  onSubmit: (config: McpServerConfig) => void
  onCancel: () => void
}

/**
 * 表单草稿状态:args/env/headers 以字符串形式存放(textarea 编辑),
 * 提交时再通过 parseArgs/parseKv 转回 McpServerConfig 期望的类型。
 */
interface DraftState {
  id: string
  name: string
  description: string
  enabled: boolean
  transport: McpTransport
  command: string
  args: string
  env: string
  url: string
  headers: string
}

/** 把 Partial<McpServerConfig> 规整成可编辑的 DraftState(数组/对象 → 字符串) */
function toDraft(initial: Partial<McpServerConfig> | null): DraftState {
  return {
    id: initial?.id ?? '',
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    enabled: initial?.enabled ?? true,
    transport: (initial?.transport as McpTransport) ?? 'stdio',
    command: initial?.command ?? '',
    args: Array.isArray(initial?.args) ? initial!.args!.join('\n') : '',
    env: initial?.env ? stringifyKv(initial.env, '=') : '',
    url: initial?.url ?? '',
    headers: initial?.headers ? stringifyKv(initial.headers, ': ') : '',
  }
}

export function McpServerForm({ initial, onSubmit, onCancel }: McpServerFormProps) {
  const { t } = useT()
  const [draft, setDraft] = useState<DraftState>(() => toDraft(initial))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)

  // validateMcpConfig 入参为 Partial<McpServerConfig>;draft 字段已是合法子集
  const draftAsConfig = useMemo<Partial<McpServerConfig>>(
    () => ({
      id: draft.id,
      name: draft.name,
      description: draft.description,
      enabled: draft.enabled,
      transport: draft.transport,
      command: draft.command,
      url: draft.url,
    }),
    [draft],
  )

  const update = (patch: Partial<DraftState>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    if (submitted) {
      // 校验只关心标量字段(args/env/headers 是字符串形式,validator 不读取)
      const next: Partial<McpServerConfig> = {
        id: patch.id ?? draft.id,
        name: patch.name ?? draft.name,
        description: patch.description ?? draft.description,
        enabled: patch.enabled ?? draft.enabled,
        transport: patch.transport ?? draft.transport,
        command: patch.command ?? draft.command,
        url: patch.url ?? draft.url,
      }
      setErrors(validateMcpConfig(next))
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    const errs = validateMcpConfig(draftAsConfig)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    // 把字符串形式的 args/env/headers 解析回数组/对象
    const config: McpServerConfig = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      enabled: draft.enabled,
      transport: draft.transport,
      ...(draft.transport === 'stdio'
        ? {
            command: draft.command.trim(),
            args: parseArgs(draft.args),
            env: parseKv(draft.env),
          }
        : {
            url: draft.url.trim(),
            headers: parseKv(draft.headers),
          }),
    }
    onSubmit(config)
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-auto"
      >
        <h2 className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100">
          {initial ? t('page.mcp.edit') : t('page.mcp.add')}
        </h2>

        <div className="space-y-3">
          <FormField label={t('page.mcp.field.id')} error={errors.id} required>
            <input
              type="text"
              value={draft.id}
              onChange={(e) => update({ id: e.target.value })}
              disabled={!!initial}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600 disabled:opacity-50"
            />
          </FormField>

          <FormField label={t('page.mcp.field.name')} error={errors.name} required>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600"
            />
          </FormField>

          <FormField label={t('page.mcp.field.description')}>
            <input
              type="text"
              value={draft.description}
              onChange={(e) => update({ description: e.target.value })}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600"
            />
          </FormField>

          <FormField label={t('page.mcp.field.transport')} required>
            <select
              value={draft.transport}
              onChange={(e) => update({ transport: e.target.value as McpTransport })}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600"
            >
              <option value="stdio">{t('page.mcp.transport.stdio')}</option>
              <option value="sse">{t('page.mcp.transport.sse')}</option>
              <option value="websocket">{t('page.mcp.transport.websocket')}</option>
            </select>
          </FormField>

          {draft.transport === 'stdio' ? (
            <>
              <FormField label={t('page.mcp.field.command')} error={errors.command} required>
                <input
                  type="text"
                  value={draft.command}
                  onChange={(e) => update({ command: e.target.value })}
                  placeholder="npx"
                  className="w-full px-2 py-1 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
              <FormField label={t('page.mcp.field.args')} hint="空格或换行分隔">
                <textarea
                  value={draft.args}
                  onChange={(e) => update({ args: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                  rows={2}
                  className="w-full px-2 py-1 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
              <FormField label={t('page.mcp.field.env')} hint="KEY=VALUE 每行一个">
                <textarea
                  value={draft.env}
                  onChange={(e) => update({ env: e.target.value })}
                  placeholder={'USER_DOCS=${env.USERPROFILE}/Documents'}
                  rows={2}
                  className="w-full px-2 py-1 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
            </>
          ) : (
            <>
              <FormField label={t('page.mcp.field.url')} error={errors.url} required>
                <input
                  type="text"
                  value={draft.url}
                  onChange={(e) => update({ url: e.target.value })}
                  placeholder="https://example.com/sse"
                  className="w-full px-2 py-1 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
              <FormField label={t('page.mcp.field.headers')} hint="KEY: VALUE 每行一个">
                <textarea
                  value={draft.headers}
                  onChange={(e) => update({ headers: e.target.value })}
                  placeholder={'Authorization: Bearer xxx'}
                  rows={2}
                  className="w-full px-2 py-1 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
            </>
          )}

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            {t('page.mcp.field.enabled')}
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 text-sm rounded bg-blue-500 text-white hover:bg-blue-600"
          >
            {t('common.confirm')}
          </button>
        </div>
      </form>
    </div>
  )
}

function FormField({
  label,
  error,
  required,
  hint,
  children,
}: {
  label: string
  error?: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="mt-0.5 text-xs text-gray-400">{hint}</p>}
      {error && <p className="mt-0.5 text-xs text-red-500">{error}</p>}
    </div>
  )
}

/** 把多行字符串解析为 args 数组(每行一个 arg,或空格分隔) */
function parseArgs(input?: string): string[] {
  if (!input || !input.trim()) return []
  return input
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .flatMap((l) => (l.includes(' ') && !l.startsWith('"') ? l.split(/\s+/) : [l]))
}

/** 把 KEY=VALUE 或 KEY: VALUE 多行解析为对象 */
function parseKv(input?: string): Record<string, string> | undefined {
  if (!input || !input.trim()) return undefined
  const result: Record<string, string> = {}
  for (const line of input.split(/\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(trimmed.includes('=') ? '=' : ':')
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** 把 Record<string,string> 序列化为多行 KEY<sep>VALUE(env 用 '=',headers 用 ': ') */
function stringifyKv(kv: Record<string, string>, sep: string): string {
  return Object.entries(kv)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
}
