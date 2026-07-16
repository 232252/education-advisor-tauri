// =============================================================
// 根组件 — 路由 + 布局（路由级代码分割版）
// =============================================================

import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ContextMenu } from './components/ContextMenu'
import { ToastContainer } from './components/ToastContainer'
import { useForwardConsole } from './hooks/useForwardConsole'
import { useTheme } from './hooks/useTheme'
import { MainLayout } from './layouts/MainLayout'

// 路由级懒加载 — 首屏仅加载 MainLayout + DashboardPage
const DashboardPage = lazy(() =>
  import('./pages/Dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
const ChatPage = lazy(() => import('./pages/Chat/ChatPage').then((m) => ({ default: m.ChatPage })))
const StudentsPage = lazy(() =>
  import('./pages/Students/StudentsPage').then((m) => ({ default: m.StudentsPage })),
)
const ClassesPage = lazy(() =>
  import('./pages/Classes/ClassesPage').then((m) => ({ default: m.ClassesPage })),
)
const AcademicsPage = lazy(() =>
  import('./pages/Academics/AcademicsPage').then((m) => ({ default: m.AcademicsPage })),
)
const AgentsPage = lazy(() =>
  import('./pages/Agents/AgentsPage').then((m) => ({ default: m.AgentsPage })),
)
const ModelsPage = lazy(() =>
  import('./pages/Models/ModelsPage').then((m) => ({ default: m.ModelsPage })),
)
const SkillsPage = lazy(() =>
  import('./pages/Skills/SkillsPage').then((m) => ({ default: m.SkillsPage })),
)
const SchedulerPage = lazy(() =>
  import('./pages/Scheduler/SchedulerPage').then((m) => ({ default: m.SchedulerPage })),
)
const PrivacyPage = lazy(() =>
  import('./pages/Privacy/PrivacyPage').then((m) => ({ default: m.PrivacyPage })),
)
const SettingsPage = lazy(() =>
  import('./pages/Settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)

/** 路由懒加载时的占位 — 保持极简,避免骨架屏→真实内容的形态跳变 */
function RouteFallback() {
  return <div className="h-full" />
}

/** 预拉取所有页面 chunk,消除首次切换时的下载延迟 */
function usePrefetchPages() {
  useEffect(() => {
    // 用 requestIdleCallback 在浏览器空闲时预加载,不阻塞首屏
    const prefetch = () => {
      // 这些 import 只会触发 chunk 下载,不会真正执行模块副作用
      import('./pages/Chat/ChatPage')
      import('./pages/Students/StudentsPage')
      import('./pages/Classes/ClassesPage')
      import('./pages/Agents/AgentsPage')
      import('./pages/Models/ModelsPage')
      import('./pages/Skills/SkillsPage')
      import('./pages/Scheduler/SchedulerPage')
      import('./pages/Privacy/PrivacyPage')
      import('./pages/Settings/SettingsPage')
    }
    if ('requestIdleCallback' in window) {
      requestIdleCallback(prefetch, { timeout: 3000 })
    } else {
      setTimeout(prefetch, 1500)
    }
  }, [])
}

export function App() {
  // 初始化主题（dark/light/system）
  useTheme()
  // T2: 装 console 劫持 hook,所有 console 输出转发到 logs/renderer-*.log
  useForwardConsole()
  // 预拉取所有页面 chunk,消除导航闪烁
  usePrefetchPages()

  return (
    <HashRouter>
      {/* P2-8: 全局 toast 通知容器,挂载在 Router 之外,跨页面保持 */}
      <ToastContainer />
      {/* 桌面级自定义右键菜单,替代浏览器默认右键 */}
      <ContextMenu />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/students" element={<StudentsPage />} />
            <Route path="/academics" element={<AcademicsPage />} />
            <Route path="/classes" element={<ClassesPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/scheduler" element={<SchedulerPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* 兜底：未匹配路由重定向到 dashboard，避免空白页 */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  )
}
