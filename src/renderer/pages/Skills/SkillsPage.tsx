// =============================================================
// 技能工作台 — Tab 容器 (Skills / MCP / Plugins)
// =============================================================

import { useLocalStorage } from '../../hooks'
import { useT } from '../../i18n'
import { McpTab } from './tabs/McpTab'
import { PluginsTab } from './tabs/PluginsTab'
import { SkillsTab } from './tabs/SkillsTab'

type TabKey = 'skills' | 'mcp' | 'plugins'

export function SkillsPage() {
  const { t } = useT()
  const [tab, setTab] = useLocalStorage<TabKey>('skills.activeTab', 'skills')

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'skills', label: t('page.skills.tab.skills') },
    { key: 'mcp', label: t('page.skills.tab.mcp') },
    { key: 'plugins', label: t('page.skills.tab.plugins') },
  ]

  return (
    <section className="h-full flex flex-col" aria-label={t('page.skills.title')}>
      {/* Tab 栏 */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        {tabs.map((tb) => (
          <button
            type="button"
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`px-4 py-2 text-sm transition-colors
              ${
                tab === tb.key
                  ? 'text-blue-500 dark:text-blue-400 border-b-2 border-blue-500 dark:border-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 overflow-hidden">
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'plugins' && <PluginsTab />}
      </div>
    </section>
  )
}
