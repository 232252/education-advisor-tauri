// =============================================================
// 主布局 — 侧边栏导航 + 内容区
// =============================================================

import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  GraduationCap,
  LayoutDashboard,
  Lock,
  MessageSquare,
  NotebookPen,
  Settings,
  Timer,
  Users,
} from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ThemeToggle } from '../components/ThemeToggle'
import { useT } from '../i18n'
import { cn } from '../lib/ui-utils'
import { useAgentStore } from '../stores/agentStore'

interface NavItem {
  path: string
  icon: LucideIcon
  labelKey: string
}
interface NavDivider {
  divider: true
}

const NAV_ITEMS: (NavItem | NavDivider)[] = [
  { path: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { path: '/chat', icon: MessageSquare, labelKey: 'nav.chat' },
  { divider: true },
  { path: '/students', icon: Users, labelKey: 'nav.students' },
  { path: '/classes', icon: GraduationCap, labelKey: 'nav.classes' },
  { divider: true },
  { path: '/academics', icon: BookOpen, labelKey: 'nav.academics' },
  { divider: true },
  { path: '/agents', icon: Bot, labelKey: 'nav.agents' },
  { path: '/scheduler', icon: Timer, labelKey: 'nav.scheduler' },
  { divider: true },
  { path: '/models', icon: Brain, labelKey: 'nav.models' },
  { path: '/skills', icon: NotebookPen, labelKey: 'nav.skills' },
  { path: '/privacy', icon: Lock, labelKey: 'nav.privacy' },
  { path: '/settings', icon: Settings, labelKey: 'nav.settings' },
]

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
    <div className="flex h-screen bg-gray-50 text-gray-900 dark:bg-[#0f1117] dark:text-gray-100">
      {/* ── 侧边栏 ── */}
      <aside className="w-56 flex-shrink-0 border-r border-gray-200/60 dark:border-white/[0.06] flex flex-col bg-white/80 dark:bg-[#161920] backdrop-blur-xl">
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-gray-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/25">
              <BarChart3 size={16} strokeWidth={2.2} />
            </div>
            <div className="flex flex-col">
              <span className="text-[13px] font-bold tracking-tight leading-tight text-gray-900 dark:text-white">
                Education Advisor
              </span>
              <span className="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
                智能学情分析
              </span>
            </div>
          </div>
        </div>

        {/* 导航 */}
        <nav className="flex-1 py-3 px-2.5 overflow-y-auto space-y-0.5">
          {NAV_ITEMS.map((item, i) =>
            'divider' in item ? (
              <div
                key={`div-before-${'path' in NAV_ITEMS[i + 1] ? NAV_ITEMS[i + 1].path : i}`}
                className="my-2 mx-2 border-t border-gray-100 dark:border-white/[0.06]"
              />
            ) : (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 px-3 py-[9px] text-[13px] font-medium rounded-[9px] transition-all duration-200',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-500/[0.12] text-blue-600 dark:text-blue-400 shadow-[0_1px_3px_rgba(59,130,246,0.08)] dark:shadow-none'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-800 dark:hover:text-gray-200',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      size={17}
                      strokeWidth={isActive ? 2.2 : 1.8}
                      className={cn(
                        'flex-shrink-0 transition-colors duration-200',
                        isActive
                          ? 'text-blue-500 dark:text-blue-400'
                          : 'text-gray-400 dark:text-gray-500',
                      )}
                    />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </>
                )}
              </NavLink>
            ),
          )}
        </nav>

        {/* Agent 状态 */}
        <div className="border-t border-gray-100 dark:border-white/[0.06] px-4 py-3">
          <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-2 uppercase tracking-wider font-semibold">
            {t('page.agents.title')}
          </div>
          <div className="space-y-1.5 max-h-28 overflow-y-auto">
            {visibleAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 text-xs group">
                <span
                  className={cn(
                    'w-[5px] h-[5px] rounded-full flex-shrink-0 transition-colors',
                    agent.status === 'running' &&
                      'bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.6)]',
                    agent.status === 'error' && 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]',
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
        <div className="border-t border-gray-100 dark:border-white/[0.06] p-2.5">
          <ThemeToggle />
        </div>
      </aside>

      {/* ── 内容区 ── */}
      <main className="flex-1 overflow-hidden bg-gray-50/50 dark:bg-[#0f1117]">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
