// =============================================================
// 主布局 — 侧边栏导航 + 内容区
// =============================================================

import { useEffect, useMemo } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ThemeToggle } from '../components/ThemeToggle'
import { useT } from '../i18n'
import { cn } from '../lib/ui-utils'
import { useAgentStore } from '../stores/agentStore'

const NAV_ITEMS = [
  { path: '/dashboard', icon: '\u{1F4CA}', labelKey: 'nav.dashboard' },
  { path: '/chat', icon: '\u{1F4AC}', labelKey: 'nav.chat' },
  { divider: true },
  { path: '/students', icon: '\u{1F465}', labelKey: 'nav.students' },
  { path: '/classes', icon: '\u{1F393}', labelKey: 'nav.classes' },
  { divider: true },
  { path: '/academics', icon: '\u{1F4DA}', labelKey: 'nav.academics' },
  { divider: true },
  { path: '/agents', icon: '\u{1F916}', labelKey: 'nav.agents' },
  { path: '/scheduler', icon: '\u{23F0}', labelKey: 'nav.scheduler' },
  { divider: true },
  { path: '/models', icon: '\u{1F9E0}', labelKey: 'nav.models' },
  { path: '/skills', icon: '\u{1F4DD}', labelKey: 'nav.skills' },
  { path: '/privacy', icon: '\u{1F512}', labelKey: 'nav.privacy' },
  { path: '/settings', icon: '\u{2699}\u{FE0F}', labelKey: 'nav.settings' },
] as const

export function MainLayout() {
  const { t } = useT()
  const agents = useAgentStore((s) => s.agents)
  const fetchAgents = useAgentStore((s) => s.fetchAgents)
  const initStatusListener = useAgentStore((s) => s.initStatusListener)
  // P2 优化: 缓存 agents.slice(0,6),避免 agent 状态更新时重复分配数组
  const visibleAgents = useMemo(() => agents.slice(0, 6), [agents])

  useEffect(() => {
    fetchAgents()
    // 初始化 Agent 状态推送监听器（修复:原代码未调用导致实时状态不更新）
    initStatusListener()
  }, [fetchAgents, initStatusListener])

  return (
    <div className="flex h-screen bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      {/* ── 侧边栏 ── */}
      <aside className="w-52 flex-shrink-0 border-r border-gray-200/80 dark:border-gray-700/80 flex flex-col bg-gray-50/50 dark:bg-gray-900">
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-gray-200/80 dark:border-gray-700/80">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white text-xs font-bold shadow-sm">
              E
            </div>
            <span className="text-sm font-bold tracking-tight">Education Advisor</span>
          </div>
        </div>

        {/* 导航 */}
        <nav className="flex-1 py-2 px-2 overflow-y-auto space-y-0.5">
          {NAV_ITEMS.map((item, i) =>
            'divider' in item ? (
              <div
                key={`div-${i}`}
                className="my-1.5 border-t border-gray-200/60 dark:border-gray-700/60"
              />
            ) : (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium rounded-lg transition-all duration-150',
                    'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-400 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.15)] dark:shadow-[inset_0_0_0_1px_rgba(96,165,250,0.2)]'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-200',
                  )
                }
              >
                <span className="text-[15px] w-5 text-center flex-shrink-0">{item.icon}</span>
                <span className="truncate">{t(item.labelKey)}</span>
              </NavLink>
            ),
          )}
        </nav>

        {/* Agent 状态 */}
        <div className="border-t border-gray-200/80 dark:border-gray-700/80 px-3 py-3">
          <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-2 uppercase tracking-widest font-semibold">
            {t('page.agents.title')}
          </div>
          <div className="space-y-1.5 max-h-32 overflow-y-auto">
            {visibleAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 text-xs group">
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors',
                    agent.status === 'running' && 'bg-blue-400 animate-pulse',
                    agent.status === 'error' && 'bg-red-400',
                    agent.status === 'idle' && 'bg-gray-300 dark:bg-gray-600',
                  )}
                />
                <span className="text-gray-500 dark:text-gray-400 truncate group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors">
                  {agent.name}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 主题切换 */}
        <div className="border-t border-gray-200/80 dark:border-gray-700/80 p-2">
          <ThemeToggle />
        </div>
      </aside>

      {/* ── 内容区 ── */}
      <main className="flex-1 overflow-hidden">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
