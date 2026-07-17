// =============================================================
// 学业管理页面 — 学生选择器 + 成绩总览 + 考试管理 + 成绩录入
// 独立页面, 非学生档案内的 Tab
// =============================================================

import type {
  AcademicConfig,
  ClassEntity,
  EAAEventRecord,
  EAAStudent,
  ExamDef,
  ExamType,
  GradeEntryMode,
  GradeRecord,
  SubjectDef,
} from '@shared/types'
import { BarChart, LineChart, RadarChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '../../components/Badge'
import { Card } from '../../components/Card'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DeltaBadge } from '../../components/DeltaBadge'
import { EmptyState } from '../../components/EmptyState'
import { CardSkeleton, PageSkeleton } from '../../components/Skeleton'
import { useTheme } from '../../hooks/useTheme'
import { useT } from '../../i18n'
import { getAPI, getErrorMessage } from '../../lib/ipc-client'
import { cn, deltaColor } from '../../lib/ui-utils'
import { useChatStore } from '../../stores/chatStore'
import { toast } from '../../stores/toastStore'
import {
  aggregateConductDelta,
  compareClassGrades,
  summarizeClassComparison,
} from './exam-comparison'

echarts.use([
  LineChart,
  BarChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  RadarComponent,
  CanvasRenderer,
])

// =============================================================
// 模块级常量 — 避免每次渲染重建引用破坏 useMemo
// =============================================================

/** 默认科目集 (config 缺失时使用) — 覆盖全部 10 个科目 */
const DEFAULT_SUBJECTS: SubjectDef[] = [
  { id: 'chinese', name: '语文', category: 'core', fullMark: 150, isCore: true },
  { id: 'math', name: '数学', category: 'core', fullMark: 150, isCore: true },
  { id: 'english', name: '英语', category: 'core', fullMark: 150, isCore: true },
  { id: 'physics', name: '物理', category: 'science', fullMark: 100 },
  { id: 'chemistry', name: '化学', category: 'science', fullMark: 100 },
  { id: 'biology', name: '生物', category: 'science', fullMark: 100 },
  { id: 'politics', name: '政治', category: 'arts', fullMark: 100 },
  { id: 'history', name: '历史', category: 'arts', fullMark: 100 },
  { id: 'geography', name: '地理', category: 'arts', fullMark: 100 },
  { id: 'pe', name: '体育', category: 'pe', fullMark: 100 },
]

/** 默认考试类型 — 与 ExamType 一一对应 */
const DEFAULT_EXAM_TYPES: Array<{ value: ExamType; label: string }> = [
  { value: 'monthly', label: '月考' },
  { value: 'midterm', label: '期中' },
  { value: 'final', label: '期末' },
  { value: 'test', label: '平时测试' },
  { value: 'quiz', label: '随堂测验' },
  { value: 'mock', label: '模拟考试' },
  { value: 'other', label: '其他' },
]

/** 考试类型 → 中文标签 (快速查找) */
const EXAM_TYPE_LABEL: Record<ExamType, string> = {
  monthly: '月考',
  midterm: '期中',
  final: '期末',
  quiz: '随堂测验',
  test: '平时测试',
  mock: '模拟考试',
  other: '其他',
}

/** 图表配色 — 每个科目一种颜色 */
const SUBJECT_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#22c55e',
  '#a855f7',
  '#f97316',
  '#06b6d4',
  '#ec4899',
  '#eab308',
  '#14b8a6',
  '#6366f1',
]

/** 考试类型 → Badge 颜色 */
const EXAM_TYPE_BADGE: Record<ExamType, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  monthly: 'info',
  midterm: 'warning',
  final: 'danger',
  quiz: 'neutral',
  test: 'neutral',
  mock: 'success',
  other: 'neutral',
}

// =============================================================
// 模块级纯函数
// =============================================================

/** 计算指定科目的平均分 (跨多次考试) */
function calcSubjectAvg(grades: GradeRecord[], subjectId: string): number | null {
  const scores = grades
    .filter((g) => g.subjectId === subjectId && g.score != null && g.score > 0)
    .map((g) => g.score as number)
  if (scores.length === 0) return null
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/** 按考试日期升序排序 */
function sortByDateAsc<T extends { date?: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
}

/** 按考试日期降序排序 (最新在前) */
function sortByDateDesc<T extends { date?: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
}

/** 获取当前学期标识 (如 "2025-2026-1") */
function getCurrentSemester(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  // 9-2月 → 第一学期; 3-7月 → 第二学期
  const semester = month >= 9 || month <= 2 ? 1 : 2
  const startYear = month >= 9 ? year : year - 1
  const endYear = startYear + 1
  return `${startYear}-${endYear}-${semester}`
}

// =============================================================
// 主组件
// =============================================================

type AcademicsTab = 'overview' | 'exams' | 'entry' | 'compare'

const TAB_LIST: Array<{ id: AcademicsTab; label: string; icon: string }> = [
  { id: 'overview', label: '成绩总览', icon: '📊' },
  { id: 'exams', label: '考试管理', icon: '📝' },
  { id: 'entry', label: '成绩录入', icon: '✏️' },
  { id: 'compare', label: '成绩对比', icon: '📈' },
]

export function AcademicsPage() {
  const { t } = useT()
  const theme = useTheme()
  const isDark = theme === 'dark'

  // ===== 状态 =====
  const [students, setStudents] = useState<EAAStudent[]>([])
  const [classList, setClassList] = useState<ClassEntity[]>([])
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null)
  const [config, setConfig] = useState<AcademicConfig | null>(null)
  const [exams, setExams] = useState<ExamDef[]>([])
  const [grades, setGrades] = useState<GradeRecord[]>([])
  const [activeTab, setActiveTab] = useState<AcademicsTab>('overview')
  const [searchQuery, setSearchQuery] = useState('')
  const [classFilter, setClassFilter] = useState<string>('__ALL__')
  const [loading, setLoading] = useState(true)
  const [gradesLoading, setGradesLoading] = useState(false)
  const [semesterFilter, setSemesterFilter] = useState<string>('__ALL__')

  // ===== 派生数据 =====

  /** 当前使用的科目列表 (config 优先, 否则用默认) */
  const subjects = useMemo<SubjectDef[]>(
    () => (config?.subjects?.length ? config.subjects : DEFAULT_SUBJECTS),
    [config],
  )

  /** 当前使用的考试类型列表 */
  const examTypes = useMemo(
    () => (config?.defaultExamTypes?.length ? config.defaultExamTypes : DEFAULT_EXAM_TYPES),
    [config],
  )

  /** 科目 ID → SubjectDef 映射 */
  const subjectMap = useMemo(() => {
    const m: Record<string, SubjectDef> = {}
    for (const s of subjects) m[s.id] = s
    return m
  }, [subjects])

  /** 过滤后的学生列表 (按班级 + 搜索词) */
  const filteredStudents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    let list = students.filter((s) => s.status !== 'Deleted')
    // 班级筛选
    if (classFilter === '__NONE__') {
      list = list.filter((s) => !s.class_id)
    } else if (classFilter !== '__ALL__') {
      list = list.filter((s) => s.class_id === classFilter)
    }
    if (q) {
      list = list.filter((s) => s.name.toLowerCase().includes(q))
    }
    // 按姓名排序, 便于查找
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [students, searchQuery, classFilter])

  /** 班级 ID → 班级名称 */
  const classIdToName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of classList) m[c.class_id] = c.name
    return m
  }, [classList])

  /** 活跃班级列表 (未存档) */
  const activeClassList = useMemo(() => classList.filter((c) => !c.archived), [classList])

  /** 学期列表 (从 exams 中提取去重) */
  const semesterList = useMemo(() => {
    const set = new Set<string>()
    for (const e of exams) if (e.semester) set.add(e.semester)
    return Array.from(set).sort().reverse()
  }, [exams])

  /** 按学期过滤后的考试列表 */
  const filteredExams = useMemo(() => {
    if (semesterFilter === '__ALL__') return exams
    return exams.filter((e) => e.semester === semesterFilter)
  }, [exams, semesterFilter])

  /** 当前选中学生对象 */
  const selectedStudentObj = useMemo(
    () => students.find((s) => s.name === selectedStudent) ?? null,
    [students, selectedStudent],
  )

  // ===== 数据加载 =====

  const loadInitialData = useCallback(async () => {
    setLoading(true)
    try {
      const results = await Promise.allSettled([
        getAPI().eaa.listStudents(),
        getAPI().class.list(),
        getAPI().academic.getConfig(),
        getAPI().academic.listExams(),
      ])

      const stuRes = results[0]
      if (stuRes.status === 'fulfilled' && stuRes.value.success && stuRes.value.data?.students) {
        const list = stuRes.value.data.students.filter((s) => s.status !== 'Deleted')
        setStudents(list)
        // 默认选中第一个学生
        if (list.length > 0) setSelectedStudent(list[0].name)
      }

      const clsRes = results[1]
      if (clsRes.status === 'fulfilled' && clsRes.value.success && clsRes.value.data) {
        setClassList(clsRes.value.data)
      }

      const cfgRes = results[2]
      if (cfgRes.status === 'fulfilled' && cfgRes.value.success && cfgRes.value.data) {
        setConfig(cfgRes.value.data)
      }

      const examRes = results[3]
      if (examRes.status === 'fulfilled' && examRes.value.success && examRes.value.data) {
        setExams(examRes.value.data)
      }

      const failed = results.filter((r) => r.status === 'rejected')
      if (failed.length > 0) {
        console.warn(
          '[Academics] Some initial loads failed:',
          failed.map((r) => String((r as PromiseRejectedResult).reason)),
        )
      }
    } catch (err) {
      console.error('[Academics] Failed to load initial data:', err)
      toast.error(t('error.unknown', '未知错误'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadGrades = useCallback(async (studentName: string) => {
    if (!studentName) {
      setGrades([])
      return
    }
    setGradesLoading(true)
    try {
      const res = await getAPI().academic.getGrades(studentName)
      if (res.success && res.data) {
        setGrades(res.data)
      } else {
        setGrades([])
      }
    } catch (err) {
      console.warn('[Academics] Failed to load grades:', err)
      setGrades([])
    } finally {
      setGradesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadInitialData()
  }, [loadInitialData])

  // 学生切换时重新加载成绩
  useEffect(() => {
    if (selectedStudent) loadGrades(selectedStudent)
    else setGrades([])
  }, [selectedStudent, loadGrades])

  // ===== 事件处理 =====

  const handleSelectStudent = useCallback((name: string) => {
    setSelectedStudent(name)
    setActiveTab('overview')
  }, [])

  const handleRefreshExams = useCallback(async () => {
    try {
      const res = await getAPI().academic.listExams()
      if (res.success && res.data) setExams(res.data)
    } catch (err) {
      console.warn('[Academics] Refresh exams failed:', err)
    }
  }, [])

  const handleRefreshGrades = useCallback(() => {
    if (selectedStudent) loadGrades(selectedStudent)
  }, [selectedStudent, loadGrades])

  // ===== 主题相关派生常量 (传给子组件) =====
  const themeProps = useMemo(
    () => ({
      isDark,
      axisColor: isDark ? '#9ca3af' : '#6b7280',
      gridColor: isDark ? '#1f2937' : '#e5e7eb',
      labelColor: isDark ? '#d1d5db' : '#374151',
      legendColor: isDark ? '#9ca3af' : '#6b7280',
    }),
    [isDark],
  )

  if (loading) {
    return <PageSkeleton />
  }

  return (
    <div className="flex h-full bg-gray-50 dark:bg-gray-900">
      {/* ===== 左侧: 学生列表 ===== */}
      <aside className="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2 flex items-center gap-1.5">
            <span>👥</span>
            <span>学生列表</span>
            <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 font-normal">
              {filteredStudents.length}
            </span>
          </h2>
          <div className="space-y-2">
            {/* 班级筛选 */}
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-400"
              title="按班级筛选"
            >
              <option value="__ALL__">全部班级</option>
              <option value="__NONE__">未分班</option>
              {activeClassList.map((c) => (
                <option key={c.class_id} value={c.class_id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* 搜索 */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索学生..."
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 placeholder:text-gray-400"
              />
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                🔍
              </span>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredStudents.length === 0 ? (
            <div className="text-center text-xs text-gray-400 dark:text-gray-500 py-8">
              {searchQuery || classFilter !== '__ALL__' ? '未找到匹配的学生' : '暂无学生'}
            </div>
          ) : (
            filteredStudents.map((s) => {
              const clsName = s.class_id ? (classIdToName[s.class_id] ?? null) : null
              return (
                <button
                  type="button"
                  key={s.entity_id}
                  onClick={() => handleSelectStudent(s.name)}
                  className={cn(
                    'w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors border-l-2',
                    selectedStudent === s.name
                      ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500 text-blue-700 dark:text-blue-300 font-medium'
                      : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300',
                  )}
                >
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {s.name[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{s.name}</div>
                    {clsName && (
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                        {clsName}
                      </div>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </aside>

      {/* ===== 右侧: 学业详情 ===== */}
      <main className="flex-1 overflow-y-auto">
        {/* 头部 */}
        <div className="sticky top-0 z-10 bg-white/80 dark:bg-gray-800/80 backdrop-blur border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                {t('page.academics.title', '学业管理')}
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {selectedStudentObj ? `当前学生: ${selectedStudentObj.name}` : '请从左侧选择学生'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* 学期筛选 */}
              <select
                value={semesterFilter}
                onChange={(e) => setSemesterFilter(e.target.value)}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                title="按学期筛选考试"
              >
                <option value="__ALL__">全部学期</option>
                {semesterList.map((sem) => (
                  <option key={sem} value={sem}>
                    {sem}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={loadInitialData}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 px-3 py-1.5 rounded-lg text-sm transition-colors"
              >
                🔄 刷新
              </button>
            </div>
          </div>

          {/* Tab 导航 */}
          <div className="flex gap-1 mt-4 -mb-1">
            {TAB_LIST.map((tab) => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'px-4 py-2 text-sm border-b-2 transition-colors',
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300',
                )}
              >
                <span className="mr-1.5">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab 内容 */}
        <div className="p-6">
          {/* compare tab 是全班对比功能,不依赖 selectedStudent;exams tab 也独立 */}
          {!selectedStudent && activeTab !== 'exams' && activeTab !== 'compare' ? (
            <EmptyState
              icon="👈"
              title="请先选择学生"
              description="从左侧学生列表中选择一个学生以查看学业详情"
            />
          ) : activeTab === 'overview' ? (
            <OverviewTab
              studentName={selectedStudent ?? ''}
              subjects={subjects}
              subjectMap={subjectMap}
              exams={filteredExams}
              grades={grades}
              gradesLoading={gradesLoading}
              themeProps={themeProps}
            />
          ) : activeTab === 'exams' ? (
            <ExamManagementTab
              subjects={subjects}
              examTypes={examTypes}
              exams={exams}
              onRefresh={handleRefreshExams}
            />
          ) : activeTab === 'compare' ? (
            <CompareTab
              students={students}
              classList={classList}
              subjects={subjects}
              exams={exams}
              themeProps={themeProps}
            />
          ) : (
            <GradeEntryTab
              studentName={selectedStudent ?? ''}
              students={students}
              subjects={subjects}
              subjectMap={subjectMap}
              exams={filteredExams}
              examTypes={examTypes}
              currentGrades={grades}
              onSaved={handleRefreshGrades}
              onExamCreated={handleRefreshExams}
            />
          )}
        </div>
      </main>
    </div>
  )
}

// =============================================================
// 成绩对比 Tab — 选两场考试,对比全班学生的分数/名次/操行分变化
// =============================================================

interface CompareTabProps {
  students: EAAStudent[]
  classList: ClassEntity[]
  subjects: SubjectDef[]
  exams: ExamDef[]
  themeProps: ThemeProps
}

function CompareTab({ students, classList, subjects, exams, themeProps }: CompareTabProps) {
  const { axisColor, gridColor } = themeProps
  const [classFilter, setClassFilter] = useState<string>('__ALL__')
  const [examAId, setExamAId] = useState<string>('')
  const [examBId, setExamBId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [classGradesA, setClassGradesA] = useState<Record<string, GradeRecord[]> | null>(null)
  const [classGradesB, setClassGradesB] = useState<Record<string, GradeRecord[]> | null>(null)
  const [conductEvents, setConductEvents] = useState<EAAEventRecord[] | null>(null)

  // subjectId → 中文名(纯函数模块要求 Record<string,string>)
  const subjectNameMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const s of subjects) m[s.id] = s.name
    return m
  }, [subjects])

  // 当前班级的学生名(按 classFilter 过滤,status 非 Deleted)
  const targetStudentNames = useMemo(() => {
    let list = students.filter((s) => s.status !== 'Deleted')
    if (classFilter === '__NONE__') {
      list = list.filter((s) => !s.class_id)
    } else if (classFilter !== '__ALL__') {
      list = list.filter((s) => s.class_id === classFilter)
    }
    return list.map((s) => s.name)
  }, [students, classFilter])

  // 按日期升序的考试列表
  const sortedExams = useMemo(
    () => [...exams].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
    [exams],
  )

  // 默认选最近两场
  useEffect(() => {
    if (sortedExams.length >= 2 && !examAId && !examBId) {
      setExamAId(sortedExams[sortedExams.length - 2].id)
      setExamBId(sortedExams[sortedExams.length - 1].id)
    }
  }, [sortedExams, examAId, examBId])

  // 加载对比数据
  const loadComparison = useCallback(async () => {
    if (!examAId || !examBId || examAId === examBId || targetStudentNames.length === 0) {
      setClassGradesA(null)
      setClassGradesB(null)
      setConductEvents(null)
      return
    }
    setLoading(true)
    try {
      const examA = exams.find((e) => e.id === examAId)
      const examB = exams.find((e) => e.id === examBId)
      const [resA, resB] = await Promise.allSettled([
        getAPI().academic.getClassGrades(targetStudentNames, examAId),
        getAPI().academic.getClassGrades(targetStudentNames, examBId),
      ])
      if (resA.status === 'fulfilled' && resA.value.success && resA.value.data) {
        setClassGradesA(resA.value.data)
      }
      if (resB.status === 'fulfilled' && resB.value.success && resB.value.data) {
        setClassGradesB(resB.value.data)
      }
      // 加载两次考试日期之间的操行分事件
      if (examA?.date && examB?.date) {
        const start = examA.date <= examB.date ? examA.date : examB.date
        const end = examA.date <= examB.date ? examB.date : examA.date
        try {
          const rangeRes = await getAPI().eaa.range(start, end, 5000)
          if (rangeRes.success && rangeRes.data) {
            setConductEvents(rangeRes.data.events ?? [])
          } else {
            setConductEvents(null)
          }
        } catch {
          setConductEvents(null)
        }
      }
    } catch (err) {
      console.warn('[CompareTab] load failed:', err)
      toast.error(getErrorMessage({ success: false } as never, '加载对比数据失败'))
    } finally {
      setLoading(false)
    }
  }, [examAId, examBId, exams, targetStudentNames])

  useEffect(() => {
    loadComparison()
  }, [loadComparison])

  // 计算对比结果(纯函数)
  const { studentComparisons, summary } = useMemo(() => {
    if (!classGradesA || !classGradesB) return { studentComparisons: [], summary: null }
    // 聚合每个学生的操行分变化
    const conductDeltas: Record<string, number> = {}
    if (conductEvents) {
      for (const name of targetStudentNames) {
        conductDeltas[name] = aggregateConductDelta(conductEvents, name)
      }
    }
    const comps = compareClassGrades(classGradesA, classGradesB, subjectNameMap, conductDeltas)
    // 按 totalScoreDelta 降序(进步多的在前)
    comps.sort((a, b) => {
      const da = a.totalScoreDelta ?? -Infinity
      const db = b.totalScoreDelta ?? -Infinity
      return db - da
    })
    return { studentComparisons: comps, summary: summarizeClassComparison(comps) }
  }, [classGradesA, classGradesB, conductEvents, targetStudentNames, subjectNameMap])

  const canCompare = examAId && examBId && examAId !== examBId && targetStudentNames.length > 0

  return (
    <div className="space-y-4">
      {/* 选择器栏 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className={cn(
              'text-sm rounded-lg border border-gray-300 dark:border-gray-600',
              'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 px-3 py-1.5',
            )}
          >
            <option value="__ALL__">全部班级</option>
            <option value="__NONE__">未分班</option>
            {classList.map((c) => (
              <option key={c.class_id} value={c.class_id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-gray-400 text-sm">|</span>
          <select
            value={examAId}
            onChange={(e) => setExamAId(e.target.value)}
            className={cn(
              'text-sm rounded-lg border border-gray-300 dark:border-gray-600',
              'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 px-3 py-1.5',
            )}
          >
            <option value="">选择考试 A</option>
            {sortedExams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}（{e.date}）
              </option>
            ))}
          </select>
          <span className="text-gray-400">→</span>
          <select
            value={examBId}
            onChange={(e) => setExamBId(e.target.value)}
            className={cn(
              'text-sm rounded-lg border border-gray-300 dark:border-gray-600',
              'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 px-3 py-1.5',
            )}
          >
            <option value="">选择考试 B</option>
            {sortedExams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}（{e.date}）
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-400 ml-auto">{targetStudentNames.length} 名学生</span>
        </div>
      </div>

      {loading ? (
        <CardSkeleton />
      ) : !canCompare ? (
        <EmptyState
          icon="📈"
          title="选择两场考试进行对比"
          description={
            sortedExams.length < 2
              ? '至少需要 2 场考试才能对比'
              : examAId === examBId && examAId
                ? '请选择两场不同的考试'
                : '从上方选择班级和两场考试'
          }
        />
      ) : studentComparisons.length === 0 ? (
        <EmptyState icon="📭" title="暂无对比数据" description="所选班级在两次考试中均无成绩记录" />
      ) : (
        <>
          {/* 汇总卡片 */}
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-400 mb-1">班级平均分变化</div>
                <div className={cn('text-lg font-bold', deltaColor(summary.avgScoreDelta))}>
                  {summary.avgScoreDelta > 0 ? '+' : ''}
                  {summary.avgScoreDelta.toFixed(1)}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-400 mb-1">进步最多</div>
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
                  {summary.mostImprovedStudent ?? '-'}
                </div>
                {summary.mostImprovedDelta !== null && (
                  <DeltaBadge delta={summary.mostImprovedDelta} suffix="分" />
                )}
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-400 mb-1">退步最多</div>
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
                  {summary.mostDeclinedStudent ?? '-'}
                </div>
                {summary.mostDeclinedDelta !== null && (
                  <DeltaBadge delta={summary.mostDeclinedDelta} suffix="分" />
                )}
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-400 mb-1">参与对比</div>
                <div className="text-lg font-bold text-gray-700 dark:text-gray-200">
                  {summary.totalStudents}
                </div>
              </div>
            </div>
          )}

          {/* 科目平均变化柱状图 */}
          {summary && summary.subjectDeltas.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
              <h5 className="text-sm font-medium text-gray-600 dark:text-gray-300 mb-3">
                📊 各科目平均分变化
              </h5>
              <ReactEChartsCore
                echarts={echarts}
                style={{ height: 240 }}
                option={{
                  tooltip: { trigger: 'axis', formatter: '{b}: {c} 分' },
                  grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
                  xAxis: {
                    type: 'category',
                    data: summary.subjectDeltas.map((s) => s.subjectName),
                    axisLabel: { color: axisColor, fontSize: 11 },
                    axisLine: { lineStyle: { color: gridColor } },
                  },
                  yAxis: {
                    type: 'value',
                    axisLabel: { color: axisColor },
                    splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
                  },
                  series: [
                    {
                      type: 'bar',
                      data: summary.subjectDeltas.map((s) => ({
                        value: Number(s.avgDelta.toFixed(2)),
                        // 正=进步绿,负=退步红
                        itemStyle: {
                          color: s.avgDelta >= 0 ? '#22c55e' : '#ef4444',
                          borderRadius: [4, 4, 0, 0],
                        },
                      })),
                      barWidth: '40%',
                      label: { show: true, position: 'top', color: axisColor, fontSize: 10 },
                    },
                  ],
                }}
              />
            </div>
          )}

          {/* 学生对比表 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">学生</th>
                    <th className="text-center px-3 py-2 font-medium">总分 A</th>
                    <th className="text-center px-3 py-2 font-medium">总分 B</th>
                    <th className="text-center px-3 py-2 font-medium">总分变化</th>
                    <th className="text-center px-3 py-2 font-medium">进步/退步</th>
                    <th className="text-center px-3 py-2 font-medium">操行分变化</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {studentComparisons.map((sc) => (
                    <tr key={sc.studentName} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                        {sc.studentName}
                      </td>
                      <td className="text-center px-3 py-2 font-mono text-gray-600 dark:text-gray-300">
                        {sc.totalScoreA ?? '-'}
                      </td>
                      <td className="text-center px-3 py-2 font-mono text-gray-600 dark:text-gray-300">
                        {sc.totalScoreB ?? '-'}
                      </td>
                      <td className="text-center px-3 py-2">
                        <DeltaBadge delta={sc.totalScoreDelta} suffix="分" />
                      </td>
                      <td className="text-center px-3 py-2 text-xs">
                        <span className="text-green-600 dark:text-green-400">
                          {sc.improvedSubjects}
                        </span>
                        <span className="text-gray-300 mx-1">/</span>
                        <span className="text-red-600 dark:text-red-400">
                          {sc.declinedSubjects}
                        </span>
                      </td>
                      <td className="text-center px-3 py-2">
                        {sc.conductDelta !== null ? (
                          <DeltaBadge delta={sc.conductDelta} suffix="分" />
                        ) : (
                          <span className="text-gray-400 text-xs">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// =============================================================
// 成绩总览 Tab — 3 图表 + 成绩表
// =============================================================

interface ThemeProps {
  isDark: boolean
  axisColor: string
  gridColor: string
  labelColor: string
  legendColor: string
}

interface OverviewTabProps {
  studentName: string
  subjects: SubjectDef[]
  subjectMap: Record<string, SubjectDef>
  exams: ExamDef[]
  grades: GradeRecord[]
  gradesLoading: boolean
  themeProps: ThemeProps
}

function OverviewTab({
  studentName,
  subjects,
  subjectMap,
  exams,
  grades,
  gradesLoading,
  themeProps,
}: OverviewTabProps) {
  const { isDark, axisColor, gridColor, legendColor } = themeProps

  /** 与成绩记录关联的有效考试 (按日期升序) */
  const sortedExamsWithGrades = useMemo(() => {
    const examIds = new Set(grades.map((g) => g.examId))
    const matched = exams.filter((e) => examIds.has(e.id))
    return sortByDateAsc(matched)
  }, [exams, grades])

  /** 趋势线图 option — X=考试名, Y=分数, 每个科目一条线 */
  const trendChartOption = useMemo(() => {
    const xData = sortedExamsWithGrades.map((e) => e.name)
    const series = subjects
      .map((sub, idx) => {
        const data = sortedExamsWithGrades.map((exam) => {
          const g = grades.find((gr) => gr.examId === exam.id && gr.subjectId === sub.id)
          return g?.score ?? null
        })
        // 只显示有数据的科目
        if (!data.some((v) => v != null)) return null
        return {
          name: sub.name,
          type: 'line' as const,
          data,
          smooth: true,
          lineStyle: { color: SUBJECT_COLORS[idx % SUBJECT_COLORS.length], width: 2 },
          itemStyle: { color: SUBJECT_COLORS[idx % SUBJECT_COLORS.length] },
          symbol: 'circle',
          symbolSize: 5,
        }
      })
      .filter(Boolean) as Array<Record<string, unknown>>

    return {
      animation: true,
      animationDuration: 800,
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: isDark ? '#1f2937' : '#fff',
        borderColor: isDark ? '#374151' : '#e5e7eb',
        textStyle: { color: isDark ? '#d1d5db' : '#374151' },
      },
      legend: {
        data: series.map((s) => s.name as string),
        bottom: 0,
        textStyle: { color: legendColor, fontSize: 11 },
        type: 'scroll' as const,
      },
      grid: { left: 8, right: 8, top: 8, bottom: 40, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: xData,
        axisLabel: { color: axisColor, fontSize: 11 },
        axisLine: { lineStyle: { color: gridColor } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: axisColor },
        splitLine: { lineStyle: { color: gridColor, type: 'dashed' as const } },
      },
      series,
    }
  }, [sortedExamsWithGrades, grades, subjects, isDark, axisColor, gridColor, legendColor])

  /** 科目柱状图 option — X=科目, Y=平均分 */
  const subjectBarOption = useMemo(() => {
    const subjectAvgs = subjects.map((sub, idx) => {
      const avg = calcSubjectAvg(grades, sub.id)
      return {
        name: sub.name,
        value: avg != null ? Number(avg.toFixed(1)) : 0,
        hasData: avg != null,
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: SUBJECT_COLORS[idx % SUBJECT_COLORS.length] },
            { offset: 1, color: `${SUBJECT_COLORS[idx % SUBJECT_COLORS.length]}80` },
          ]),
        },
      }
    })

    return {
      animation: true,
      animationDuration: 800,
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: isDark ? '#1f2937' : '#fff',
        borderColor: isDark ? '#374151' : '#e5e7eb',
        textStyle: { color: isDark ? '#d1d5db' : '#374151' },
        formatter: (params: Array<{ name: string; value: number; data: { hasData: boolean } }>) => {
          const p = params[0]
          return p.data.hasData ? `${p.name}: ${p.value} 分` : `${p.name}: 暂无数据`
        },
      },
      grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: subjectAvgs.map((s) => s.name),
        axisLabel: { color: axisColor, fontSize: 11, rotate: subjects.length > 6 ? 30 : 0 },
        axisLine: { lineStyle: { color: gridColor } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: axisColor },
        splitLine: { lineStyle: { color: gridColor, type: 'dashed' as const } },
      },
      series: [
        {
          type: 'bar' as const,
          data: subjectAvgs,
          barWidth: '50%',
        },
      ],
    }
  }, [grades, subjects, isDark, axisColor, gridColor])

  /** 雷达图 option — 每个科目一个轴, 显示最新一次考试的成绩 */
  const radarChartOption = useMemo(() => {
    if (sortedExamsWithGrades.length === 0) return null

    const latestExam = sortedExamsWithGrades[sortedExamsWithGrades.length - 1]
    const indicator = subjects.map((sub) => ({
      name: sub.name,
      max: sub.fullMark,
    }))
    const latestScores = subjects.map((sub) => {
      const g = grades.find((gr) => gr.examId === latestExam.id && gr.subjectId === sub.id)
      return g?.score ?? 0
    })

    return {
      animation: true,
      animationDuration: 1000,
      tooltip: {
        backgroundColor: isDark ? '#1f2937' : '#fff',
        borderColor: isDark ? '#374151' : '#e5e7eb',
        textStyle: { color: isDark ? '#d1d5db' : '#374151' },
      },
      radar: {
        indicator,
        radius: '65%',
        center: ['50%', '50%'],
        axisName: { color: axisColor, fontSize: 11 },
        splitLine: { lineStyle: { color: gridColor } },
        splitArea: {
          areaStyle: {
            color: isDark
              ? ['transparent', 'rgba(255,255,255,0.02)']
              : ['transparent', 'rgba(0,0,0,0.02)'],
          },
        },
        axisLine: { lineStyle: { color: gridColor } },
      },
      series: [
        {
          type: 'radar' as const,
          data: [
            {
              value: latestScores,
              name: latestExam.name,
              areaStyle: { color: 'rgba(59,130,246,0.2)' },
              lineStyle: { color: '#3b82f6', width: 2 },
              itemStyle: { color: '#3b82f6' },
            },
          ],
        },
      ],
    }
  }, [sortedExamsWithGrades, grades, subjects, isDark, axisColor, gridColor])

  /** 成绩表数据 — 按考试日期降序 */
  const gradeTableData = useMemo(() => {
    return sortByDateDesc(sortedExamsWithGrades).map((exam) => {
      const examGrades = grades.filter((g) => g.examId === exam.id)
      const scoresBySubject: Record<string, GradeRecord | undefined> = {}
      for (const sub of subjects) {
        scoresBySubject[sub.id] = examGrades.find((g) => g.subjectId === sub.id)
      }
      // 取第一个有 classRank 的记录作为本次考试的排名
      const rankRecord = examGrades.find((g) => g.classRank != null)
      return {
        exam,
        scoresBySubject,
        classRank: rankRecord?.classRank,
      }
    })
  }, [sortedExamsWithGrades, grades, subjects])

  if (gradesLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    )
  }

  if (grades.length === 0) {
    return (
      <EmptyState
        icon="📚"
        title="暂无成绩数据"
        description={`${studentName} 还没有任何成绩记录,请先在"考试管理"中创建考试,然后在"成绩录入"中录入成绩`}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* 3 个图表 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 趋势线图 (占两列) */}
        <Card padding="md" className="lg:col-span-2">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">📈 成绩趋势</h3>
          </div>
          {sortedExamsWithGrades.length > 0 ? (
            <ReactEChartsCore echarts={echarts} style={{ height: 300 }} option={trendChartOption} />
          ) : (
            <div className="flex items-center justify-center h-[300px] text-gray-400 text-sm">
              暂无趋势数据
            </div>
          )}
        </Card>

        {/* 科目柱状图 */}
        <Card padding="md">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              📊 科目平均分
            </h3>
          </div>
          <ReactEChartsCore echarts={echarts} style={{ height: 260 }} option={subjectBarOption} />
        </Card>

        {/* 雷达图 */}
        <Card padding="md">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              🎯 最新考试雷达图
            </h3>
          </div>
          {radarChartOption ? (
            <ReactEChartsCore echarts={echarts} style={{ height: 260 }} option={radarChartOption} />
          ) : (
            <div className="flex items-center justify-center h-[260px] text-gray-400 text-sm">
              暂无数据
            </div>
          )}
        </Card>
      </div>

      {/* 成绩表 */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-3">
          <span className="w-2 h-2 rounded-full bg-orange-500" />
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">📋 成绩明细</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 px-3 font-medium">考试</th>
                <th className="py-2 px-3 font-medium">类型</th>
                <th className="py-2 px-3 font-medium">日期</th>
                {subjects.map((sub) => (
                  <th key={sub.id} className="py-2 px-3 font-medium text-center">
                    {sub.name}
                    <span className="text-[10px] text-gray-400 ml-0.5">/{sub.fullMark}</span>
                  </th>
                ))}
                <th className="py-2 px-3 font-medium text-center">班级排名</th>
              </tr>
            </thead>
            <tbody>
              {gradeTableData.map(({ exam, scoresBySubject, classRank }) => (
                <tr
                  key={exam.id}
                  className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="py-2 px-3 font-medium text-gray-700 dark:text-gray-200">
                    {exam.name}
                  </td>
                  <td className="py-2 px-3">
                    <Badge variant={EXAM_TYPE_BADGE[exam.type]}>{EXAM_TYPE_LABEL[exam.type]}</Badge>
                  </td>
                  <td className="py-2 px-3 text-gray-500 dark:text-gray-400 text-xs">
                    {exam.date}
                  </td>
                  {subjects.map((sub) => {
                    const g = scoresBySubject[sub.id]
                    return (
                      <td
                        key={sub.id}
                        className="py-2 px-3 text-center font-mono text-gray-700 dark:text-gray-300"
                      >
                        {g?.score != null ? (
                          <span
                            className={cn(
                              g.score >= sub.fullMark * 0.85
                                ? 'text-green-600 dark:text-green-400 font-medium'
                                : g.score < sub.fullMark * 0.6
                                  ? 'text-red-600 dark:text-red-400 font-medium'
                                  : '',
                            )}
                          >
                            {g.score}
                          </span>
                        ) : (
                          <span className="text-gray-300 dark:text-gray-600">-</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="py-2 px-3 text-center font-mono">
                    {classRank != null ? (
                      <span className="text-blue-600 dark:text-blue-400 font-medium">
                        第 {classRank}
                      </span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// =============================================================
// 考试管理 Tab — 列表 + 创建 + 删除
// =============================================================

interface ExamManagementTabProps {
  subjects: SubjectDef[]
  examTypes: Array<{ value: ExamType; label: string }>
  exams: ExamDef[]
  onRefresh: () => void
}

function ExamManagementTab({ subjects, examTypes, exams, onRefresh }: ExamManagementTabProps) {
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; exam: ExamDef | null }>({
    open: false,
    exam: null,
  })

  // 创建表单状态
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<ExamType>('monthly')
  const [formDate, setFormDate] = useState(new Date().toISOString().slice(0, 10))
  const [formSemester, setFormSemester] = useState(getCurrentSemester())
  const [formScope, setFormScope] = useState('')
  const [formSubjects, setFormSubjects] = useState<Set<string>>(new Set())

  const sortedExams = useMemo(() => sortByDateDesc(exams), [exams])

  const handleToggleSubject = useCallback((subjectId: string) => {
    setFormSubjects((prev) => {
      const next = new Set(prev)
      if (next.has(subjectId)) next.delete(subjectId)
      else next.add(subjectId)
      return next
    })
  }, [])

  const handleSelectAllSubjects = useCallback(() => {
    setFormSubjects(new Set(subjects.map((s) => s.id)))
  }, [subjects])

  const handleClearSubjects = useCallback(() => {
    setFormSubjects(new Set())
  }, [])

  const resetForm = useCallback(() => {
    setFormName('')
    setFormType('monthly')
    setFormDate(new Date().toISOString().slice(0, 10))
    setFormSemester(getCurrentSemester())
    setFormScope('')
    setFormSubjects(new Set())
  }, [])

  const handleCreate = useCallback(async () => {
    if (!formName.trim()) {
      toast.error('请输入考试名称')
      return
    }
    if (formSubjects.size === 0) {
      toast.error('请至少选择一个科目')
      return
    }
    setCreating(true)
    try {
      const res = await getAPI().academic.createExam({
        name: formName.trim(),
        type: formType,
        date: formDate,
        semester: formSemester.trim() || getCurrentSemester(),
        scope: formScope.trim() || undefined,
        subjects: Array.from(formSubjects),
      })
      if (res.success) {
        toast.success('考试创建成功')
        resetForm()
        setShowCreateForm(false)
        onRefresh()
      } else {
        toast.error(getErrorMessage(res, '创建失败'))
      }
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreating(false)
    }
  }, [formName, formType, formDate, formSemester, formScope, formSubjects, resetForm, onRefresh])

  const handleDelete = useCallback((exam: ExamDef) => {
    setDeleteConfirm({ open: true, exam })
  }, [])

  const executeDelete = useCallback(async () => {
    const exam = deleteConfirm.exam
    setDeleteConfirm({ open: false, exam: null })
    if (!exam) return
    try {
      const res = await getAPI().academic.deleteExam(exam.id)
      if (res.success) {
        toast.success('考试已删除')
        onRefresh()
      } else {
        toast.error(res.error ?? '删除失败')
      }
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [deleteConfirm.exam, onRefresh])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">考试列表</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            共 {exams.length} 场考试
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors shadow-sm"
        >
          {showCreateForm ? '取消' : '+ 创建考试'}
        </button>
      </div>

      {/* 创建表单 */}
      {showCreateForm && (
        <Card padding="md">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-4">新建考试</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                考试名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如: 2025年期中考试"
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                考试类型
              </label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value as ExamType)}
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                {examTypes.map((et) => (
                  <option key={et.value} value={et.value}>
                    {et.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                考试日期
              </label>
              <input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">学期</label>
              <input
                type="text"
                value={formSemester}
                onChange={(e) => setFormSemester(e.target.value)}
                placeholder="如: 2025-2026-1"
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                考试范围 (可选)
              </label>
              <input
                type="text"
                value={formScope}
                onChange={(e) => setFormScope(e.target.value)}
                placeholder="如: 第一单元 ~ 第三单元"
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* 科目选择 */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                考试科目 <span className="text-red-500">*</span>
                <span className="text-gray-400 ml-1">({formSubjects.size} 已选)</span>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSelectAllSubjects}
                  className="text-xs text-blue-500 hover:text-blue-600"
                >
                  全选
                </button>
                <span className="text-gray-300 dark:text-gray-600">|</span>
                <button
                  type="button"
                  onClick={handleClearSubjects}
                  className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  清空
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {subjects.map((sub) => (
                <button
                  type="button"
                  key={sub.id}
                  onClick={() => handleToggleSubject(sub.id)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs border transition-colors',
                    formSubjects.has(sub.id)
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-400',
                  )}
                >
                  {sub.name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 shadow-sm"
            >
              {creating ? '创建中...' : '✓ 确认创建'}
            </button>
            <button
              type="button"
              onClick={() => {
                resetForm()
                setShowCreateForm(false)
              }}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-sm px-3"
            >
              取消
            </button>
          </div>
        </Card>
      )}

      {/* 考试列表 */}
      {sortedExams.length === 0 ? (
        <EmptyState
          icon="📝"
          title="暂无考试"
          description={'点击右上角「创建考试」按钮添加第一场考试'}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sortedExams.map((exam) => {
            const examSubjects = exam.subjects
              .map((sid) => subjects.find((s) => s.id === sid)?.name)
              .filter(Boolean)
            return (
              <Card key={exam.id} padding="md">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {exam.name}
                      </h4>
                      <Badge variant={EXAM_TYPE_BADGE[exam.type]}>
                        {EXAM_TYPE_LABEL[exam.type]}
                      </Badge>
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                      <div>📅 {exam.date}</div>
                      <div>📚 学期: {exam.semester}</div>
                      {exam.scope && <div>📖 范围: {exam.scope}</div>}
                      <div>
                        📝 科目 ({examSubjects.length}): {examSubjects.join('、') || '无'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(exam)}
                    className="text-red-400 hover:text-red-600 dark:hover:text-red-400 text-xs px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
                    title="删除考试"
                  >
                    🗑 删除
                  </button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={deleteConfirm.open}
        title="删除考试"
        message={`确定要删除考试"${deleteConfirm.exam?.name}"吗？相关成绩记录也将被删除,此操作不可恢复。`}
        confirmText="删除"
        variant="danger"
        onConfirm={executeDelete}
        onCancel={() => setDeleteConfirm({ open: false, exam: null })}
      />
    </div>
  )
}

// =============================================================
// 成绩录入 Tab — 单科录入 / 全科录入
// =============================================================

interface GradeEntryTabProps {
  studentName: string
  students: EAAStudent[]
  subjects: SubjectDef[]
  subjectMap: Record<string, SubjectDef>
  exams: ExamDef[]
  examTypes: Array<{ value: ExamType; label: string }>
  currentGrades: GradeRecord[]
  onSaved: () => void
  onExamCreated: () => void
}

function GradeEntryTab({
  studentName,
  students,
  subjects,
  subjectMap,
  exams,
  examTypes,
  currentGrades,
  onSaved,
  onExamCreated,
}: GradeEntryTabProps) {
  const [mode, setMode] = useState<GradeEntryMode>('single-subject')
  const [selectedExamId, setSelectedExamId] = useState<string>('')
  const [examNameInput, setExamNameInput] = useState<string>('')
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('')
  const [entryStudentName, setEntryStudentName] = useState<string>(studentName)
  const [saving, setSaving] = useState(false)
  // 快速建考试
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [quickName, setQuickName] = useState('')
  const [quickType, setQuickType] = useState<ExamType>('monthly')
  const [quickDate, setQuickDate] = useState('')
  const [quickCreating, setQuickCreating] = useState(false)
  // AI 智能录入
  const [showAIEntry, setShowAIEntry] = useState(false)
  const [aiInputText, setAiInputText] = useState('')
  const [aiParsing, setAiParsing] = useState(false)
  const [aiProgress, setAiProgress] = useState('')
  const currentProvider = useChatStore((s) => s.currentProvider)
  const currentModel = useChatStore((s) => s.currentModel)

  // 单科录入: 学生 → 分数/排名
  const [singleScores, setSingleScores] = useState<Record<string, { score: string; rank: string }>>(
    {},
  )
  // 全科录入: 科目 → 分数/排名
  const [allScores, setAllScores] = useState<Record<string, { score: string; rank: string }>>({})

  const sortedExams = useMemo(() => sortByDateDesc(exams), [exams])

  // 同步外部学生切换
  useEffect(() => {
    setEntryStudentName(studentName)
  }, [studentName])

  /** 当切换科目/模式/学生时清除成绩; 当切换考试/成绩数据时加载已有成绩 */
  // 注意: 未选考试时不清除成绩,允许用户直接录入(考试在保存时自动创建)
  const prevEntryDepsRef = useRef('')
  useEffect(() => {
    const depsKey = `${selectedSubjectId}|${mode}|${entryStudentName}`
    const depsChanged = prevEntryDepsRef.current !== depsKey
    prevEntryDepsRef.current = depsKey

    if (depsChanged) {
      setSingleScores({})
      setAllScores({})
    }

    if (!selectedExamId) {
      // 未选考试: 不清除已有输入,允许直接录入
      return
    }

    if (mode === 'single-subject') {
      // 单科模式: 加载所有学生在该考试该科目的成绩
      const scores: Record<string, { score: string; rank: string }> = {}
      for (const g of currentGrades) {
        if (g.examId === selectedExamId && g.subjectId === selectedSubjectId) {
          // currentGrades 只包含当前学生, 其他学生的需要通过 getClassGrades 加载
          // 此处先填充当前学生
          scores[g.studentName] = {
            score: g.score != null ? String(g.score) : '',
            rank: g.classRank != null ? String(g.classRank) : '',
          }
        }
      }
      setSingleScores(scores)
    } else {
      // 全科模式: 加载当前学生在该考试所有科目的成绩
      const scores: Record<string, { score: string; rank: string }> = {}
      for (const g of currentGrades) {
        if (g.examId === selectedExamId && g.studentName === entryStudentName) {
          scores[g.subjectId] = {
            score: g.score != null ? String(g.score) : '',
            rank: g.classRank != null ? String(g.classRank) : '',
          }
        }
      }
      setAllScores(scores)
    }
  }, [selectedExamId, selectedSubjectId, mode, entryStudentName, currentGrades])

  /** 加载同班学生在指定考试/科目的成绩 (单科模式) */
  const loadClassGrades = useCallback(
    async (examId: string, subjectId: string) => {
      if (!examId || !subjectId) return
      try {
        const studentNames = students.map((s) => s.name)
        const res = await getAPI().academic.getClassGrades(studentNames, examId, subjectId)
        if (res.success && res.data) {
          const scores: Record<string, { score: string; rank: string }> = {}
          for (const [name, gradeList] of Object.entries(res.data)) {
            const g = gradeList?.[0]
            if (g) {
              scores[name] = {
                score: g.score != null ? String(g.score) : '',
                rank: g.classRank != null ? String(g.classRank) : '',
              }
            }
          }
          setSingleScores(scores)
        }
      } catch (err) {
        console.warn('[GradeEntry] Load class grades failed:', err)
      }
    },
    [students],
  )

  // 单科模式切换考试/科目时,加载班级成绩
  useEffect(() => {
    if (mode === 'single-subject' && selectedExamId && selectedSubjectId) {
      loadClassGrades(selectedExamId, selectedSubjectId)
    }
  }, [mode, selectedExamId, selectedSubjectId, loadClassGrades])

  const selectedExam = useMemo(
    () => exams.find((e) => e.id === selectedExamId) ?? null,
    [exams, selectedExamId],
  )

  /** 快速创建考试 (无需跳转考试管理 Tab) */
  const handleQuickCreate = useCallback(async () => {
    const name = quickName.trim()
    if (!name) {
      toast.error('请输入考试名称')
      return
    }
    setQuickCreating(true)
    try {
      const semester = getCurrentSemester()
      const res = await getAPI().academic.createExam({
        name,
        type: quickType,
        date: quickDate || new Date().toISOString().slice(0, 10),
        semester,
        scope: '',
        subjects: subjects.map((s) => s.id),
      })
      if (res.success && res.data) {
        toast.success(`考试「${name}」已创建`)
        onExamCreated()
        setSelectedExamId(res.data.id)
        setShowQuickCreate(false)
        setQuickName('')
        setQuickDate('')
      } else {
        toast.error(getErrorMessage(res, '创建失败'))
      }
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setQuickCreating(false)
    }
  }, [quickName, quickType, quickDate, subjects, onExamCreated])

  /**
   * 解析当前考试: 优先用 selectedExamId; 否则按 examNameInput 查找已有考试;
   * 找不到则自动创建 (名称可选,留空时用"快速录入 YYYY-MM-DD")。
   * 返回 examId 或 null(创建失败时)。
   */
  const resolveExamForSave = useCallback(async (): Promise<string | null> => {
    // 1. 已选择考试
    if (selectedExamId) return selectedExamId

    // 2. 按名称查找已有考试
    const trimmedName = examNameInput.trim()
    if (trimmedName) {
      const existing = exams.find(
        (e) => e.name === trimmedName || e.name.toLowerCase() === trimmedName.toLowerCase(),
      )
      if (existing) {
        setSelectedExamId(existing.id)
        return existing.id
      }
    }

    // 3. 自动创建
    const name = trimmedName || `快速录入 ${new Date().toISOString().slice(0, 10)}`
    try {
      const res = await getAPI().academic.createExam({
        name,
        type: 'other',
        date: new Date().toISOString().slice(0, 10),
        semester: getCurrentSemester(),
        scope: '',
        subjects: subjects.map((s) => s.id),
      })
      if (res.success && res.data) {
        toast.success(`已自动创建考试「${name}」`)
        onExamCreated()
        setSelectedExamId(res.data.id)
        return res.data.id
      }
      toast.error(getErrorMessage(res, '创建考试失败'))
      return null
    } catch (err) {
      toast.error(`创建考试失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }, [selectedExamId, examNameInput, exams, subjects, onExamCreated])

  /** AI 智能解析成绩文本,自动填充分数表 */
  const handleAIParse = useCallback(async () => {
    if (!aiInputText.trim()) {
      toast.error('请粘贴成绩文本')
      return
    }
    if (!currentProvider || !currentModel) {
      toast.error('请先在"模型"页面配置 AI 模型')
      return
    }
    setAiParsing(true)
    setAiProgress('AI 解析中...')

    const studentNames = students.filter((s) => s.status !== 'Deleted').map((s) => s.name)
    const systemPrompt = `你是一个成绩录入助手。用户会粘贴成绩文本,请将其解析为JSON数组。
格式要求: [{"name":"学生姓名","score":分数,"rank":排名可选}]
学生名单(只解析这些学生): ${studentNames.join('、')}
规则:
1. 尝试模糊匹配文本中的姓名到学生名单
2. score 必须是数字
3. rank 如果文本中有则填数字,没有则不填
4. 只返回JSON数组,不要任何其他文字、不要markdown代码块标记`

    let fullText = ''
    let streamDone = false

    const unsub = getAPI().ai.onStream(
      (event: { type: string; delta?: string; message?: string }) => {
        if (event.type === 'text_delta' && event.delta) {
          fullText += event.delta
          setAiProgress(`已接收 ${fullText.length} 字符...`)
        } else if (event.type === 'done') {
          streamDone = true
          try {
            // 从响应中提取 JSON 数组
            const jsonMatch = fullText.match(/\[[\s\S]*\]/)
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as Array<{
                name: string
                score?: number
                rank?: number
              }>
              const newScores: Record<string, { score: string; rank: string }> = {}
              let matched = 0
              for (const item of parsed) {
                if (!item.name || item.score == null) continue
                // 模糊匹配学生姓名
                const matchedName = studentNames.find(
                  (n) => n === item.name || n.includes(item.name) || item.name.includes(n),
                )
                if (matchedName) {
                  newScores[matchedName] = {
                    score: String(item.score),
                    rank: item.rank != null ? String(item.rank) : '',
                  }
                  matched++
                }
              }
              setSingleScores((prev) => ({ ...prev, ...newScores }))
              setAiProgress(`解析完成: 匹配 ${matched} 名学生`)
              toast.success(`AI 已填充 ${matched} 名学生成绩`)
            } else {
              setAiProgress('解析失败: AI 返回格式异常')
              toast.error('AI 返回格式异常,请检查文本')
            }
          } catch {
            setAiProgress('解析失败: JSON 解析错误')
            toast.error('解析 AI 响应失败')
          }
          setAiParsing(false)
        } else if (event.type === 'error') {
          streamDone = true
          setAiParsing(false)
          setAiProgress(`错误: ${event.message ?? '未知错误'}`)
          toast.error(`AI 错误: ${event.message ?? '未知'}`)
        }
      },
    )

    try {
      await getAPI().ai.chat({
        providerId: currentProvider,
        modelId: currentModel,
        messages: [{ role: 'user', content: aiInputText }],
        systemPrompt,
        maxTokens: 2000,
      })
    } catch (err) {
      setAiParsing(false)
      setAiProgress(`调用失败: ${err instanceof Error ? err.message : String(err)}`)
      toast.error(`AI 调用失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // 延迟取消订阅,确保所有流事件都已接收
      setTimeout(() => {
        if (!streamDone) {
          setAiParsing(false)
          setAiProgress('超时: AI 响应超时')
        }
        unsub()
      }, 30000)
    }
  }, [aiInputText, currentProvider, currentModel, students])

  /** 单科模式: 更新学生分数 */
  const updateSingleScore = useCallback((name: string, field: 'score' | 'rank', value: string) => {
    setSingleScores((prev) => ({
      ...prev,
      [name]: {
        score: prev[name]?.score ?? '',
        rank: prev[name]?.rank ?? '',
        [field]: value,
      },
    }))
  }, [])

  /** 全科模式: 更新科目分数 */
  const updateAllScore = useCallback(
    (subjectId: string, field: 'score' | 'rank', value: string) => {
      setAllScores((prev) => ({
        ...prev,
        [subjectId]: {
          score: prev[subjectId]?.score ?? '',
          rank: prev[subjectId]?.rank ?? '',
          [field]: value,
        },
      }))
    },
    [],
  )

  /** 保存单科成绩 (批量) — 考试未选时自动解析/创建 */
  const handleSaveSingle = useCallback(async () => {
    if (!selectedSubjectId) {
      toast.error('请先选择科目')
      return
    }
    const subject = subjectMap[selectedSubjectId]
    if (!subject) return

    const records = Object.entries(singleScores)
      .filter(([, v]) => v.score !== '')
      .map(([name, v]) => ({
        examId: '', // 占位,下面填充
        subjectId: selectedSubjectId,
        studentName: name,
        score: parseFloat(v.score) || null,
        fullMark: subject.fullMark,
        classRank: v.rank ? parseInt(v.rank, 10) || undefined : undefined,
      }))

    if (records.length === 0) {
      toast.error('没有可保存的成绩')
      return
    }

    setSaving(true)
    try {
      const examId = await resolveExamForSave()
      if (!examId) {
        setSaving(false)
        return
      }
      const finalRecords = records.map((r) => ({ ...r, examId }))
      const res = await getAPI().academic.batchSetGrades(finalRecords)
      if (res.success) {
        toast.success(`已保存 ${finalRecords.length} 条成绩`)
        onSaved()
      } else {
        toast.error(getErrorMessage(res, '保存失败'))
      }
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [selectedSubjectId, subjectMap, singleScores, resolveExamForSave, onSaved])

  /** 保存全科成绩 — 考试未选时自动解析/创建 */
  const handleSaveAll = useCallback(async () => {
    if (!entryStudentName) {
      toast.error('请先选择学生')
      return
    }

    const records = Object.entries(allScores)
      .filter(([, v]) => v.score !== '')
      .map(([subjectId, v]) => {
        const subject = subjectMap[subjectId]
        return {
          examId: '', // 占位,下面填充
          subjectId,
          studentName: entryStudentName,
          score: parseFloat(v.score) || null,
          fullMark: subject?.fullMark ?? 100,
          classRank: v.rank ? parseInt(v.rank, 10) || undefined : undefined,
        }
      })

    if (records.length === 0) {
      toast.error('没有可保存的成绩')
      return
    }

    setSaving(true)
    try {
      const examId = await resolveExamForSave()
      if (!examId) {
        setSaving(false)
        return
      }
      const finalRecords = records.map((r) => ({ ...r, examId }))
      const res = await getAPI().academic.batchSetGrades(finalRecords)
      if (res.success) {
        toast.success(`已保存 ${finalRecords.length} 个科目成绩`)
        onSaved()
      } else {
        toast.error(getErrorMessage(res, '保存失败'))
      }
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [entryStudentName, subjectMap, allScores, resolveExamForSave, onSaved])

  if (showQuickCreate) {
    return (
      <Card padding="lg">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">快速创建考试</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              考试名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={quickName}
              onChange={(e) => setQuickName(e.target.value)}
              placeholder="如: 第一次月考"
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">考试类型</label>
            <select
              value={quickType}
              onChange={(e) => setQuickType(e.target.value as ExamType)}
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {examTypes.map((et) => (
                <option key={et.value} value={et.value}>
                  {et.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              考试日期 <span className="text-gray-400">(可选)</span>
            </label>
            <input
              type="date"
              value={quickDate}
              onChange={(e) => setQuickDate(e.target.value)}
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={handleQuickCreate}
            disabled={quickCreating || !quickName.trim()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 shadow-sm"
          >
            {quickCreating ? '创建中...' : '创建并录入'}
          </button>
          <button
            type="button"
            onClick={() => setShowQuickCreate(false)}
            className="bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 px-4 py-2 rounded-lg text-sm transition-colors"
          >
            取消
          </button>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* 模式切换 + AI 录入入口 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500 dark:text-gray-400">录入模式:</span>
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setMode('single-subject')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs transition-colors',
              mode === 'single-subject'
                ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 font-medium shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
            )}
          >
            📝 单科录入 (科任老师)
          </button>
          <button
            type="button"
            onClick={() => setMode('all-subjects')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs transition-colors',
              mode === 'all-subjects'
                ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 font-medium shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
            )}
          >
            📋 全科录入 (班主任)
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowAIEntry(!showAIEntry)}
          className={cn(
            'ml-auto px-3 py-1.5 rounded-md text-xs transition-colors border',
            showAIEntry
              ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 border-purple-300 dark:border-purple-700'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 border-transparent',
          )}
          title="粘贴成绩文本,AI 自动解析并填充"
        >
          🤖 AI 智能录入
        </button>
      </div>

      {/* AI 智能录入面板 */}
      {showAIEntry && (
        <Card padding="md">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              🤖 AI 智能录入 — 粘贴文本,自动解析
            </h4>
            <button
              type="button"
              onClick={() => setShowAIEntry(false)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            支持多种格式: &ldquo;张三 85, 李四 92&rdquo;、表格文本、微信聊天记录等。
            {currentProvider && currentModel
              ? ` 当前模型: ${currentProvider}/${currentModel}`
              : ' ⚠️ 请先在"模型"页面配置 AI 模型'}
          </p>
          <textarea
            value={aiInputText}
            onChange={(e) => setAiInputText(e.target.value)}
            placeholder={'粘贴成绩文本,例如:\n张三 85\n李四 92\n王五 78分\n赵六 88 排名3'}
            rows={6}
            className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 font-mono"
            disabled={aiParsing}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={handleAIParse}
              disabled={aiParsing || !aiInputText.trim() || !currentProvider || !currentModel}
              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {aiParsing ? '⏳ 解析中...' : '🤖 AI 解析并填充'}
            </button>
            {aiProgress && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{aiProgress}</span>
            )}
          </div>
          {!currentProvider && (
            <p className="text-xs text-amber-500 mt-2">
              💡 未检测到 AI 模型配置。请先到&ldquo;模型&rdquo;页面选择并配置一个 AI 提供商。
            </p>
          )}
        </Card>
      )}

      {/* 选择器区 */}
      <Card padding="md">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              考试 <span className="text-gray-400 text-[10px]">(可选,留空自动创建)</span>
            </label>
            <div className="flex gap-1.5">
              {sortedExams.length > 0 ? (
                <>
                  <select
                    value={selectedExamId}
                    onChange={(e) => {
                      setSelectedExamId(e.target.value)
                      setExamNameInput('')
                    }}
                    className="flex-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— 不选,直接录入 —</option>
                    {sortedExams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.name} ({exam.date})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={examNameInput}
                    onChange={(e) => {
                      setExamNameInput(e.target.value)
                      setSelectedExamId('')
                    }}
                    list="exam-name-suggestions"
                    placeholder="或输入新名称"
                    className="flex-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                  <datalist id="exam-name-suggestions">
                    {sortedExams.map((exam) => (
                      <option key={exam.id} value={exam.name} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    onClick={() => setShowQuickCreate(true)}
                    className="flex-shrink-0 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-600 dark:text-blue-400 px-2.5 rounded-lg text-sm transition-colors border border-blue-200 dark:border-blue-800"
                    title="快速创建考试(设置类型/日期)"
                  >
                    +
                  </button>
                </>
              ) : (
                <input
                  type="text"
                  value={examNameInput}
                  onChange={(e) => setExamNameInput(e.target.value)}
                  placeholder="输入考试名称(可选),留空保存时自动创建"
                  className="flex-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              )}
            </div>
          </div>

          {mode === 'single-subject' ? (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                科目 <span className="text-red-500">*</span>
              </label>
              <select
                value={selectedSubjectId}
                onChange={(e) => setSelectedSubjectId(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">请选择科目...</option>
                {subjects.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name} (满分 {sub.fullMark})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                学生 <span className="text-red-500">*</span>
              </label>
              <select
                value={entryStudentName}
                onChange={(e) => setEntryStudentName(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">请选择学生...</option>
                {students
                  .filter((s) => s.status !== 'Deleted')
                  .map((s) => (
                    <option key={s.entity_id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          <div className="flex items-end">
            {selectedExam && (
              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                <div>
                  类型:{' '}
                  <Badge variant={EXAM_TYPE_BADGE[selectedExam.type]}>
                    {EXAM_TYPE_LABEL[selectedExam.type]}
                  </Badge>
                </div>
                <div>学期: {selectedExam.semester}</div>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 成绩录入表 */}
      {mode === 'single-subject' ? (
        !selectedSubjectId ? (
          <EmptyState
            icon="👆"
            title="请先选择科目"
            description="选择科目后即可录入成绩,考试可不选"
          />
        ) : (
          <Card padding="md">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                单科成绩录入 — {subjectMap[selectedSubjectId]?.name}
              </h4>
              <button
                type="button"
                onClick={handleSaveSingle}
                disabled={saving}
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50 shadow-sm"
              >
                {saving ? '保存中...' : '💾 保存成绩'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 px-3 font-medium">学生</th>
                    <th className="py-2 px-3 font-medium text-center">
                      成绩
                      <span className="text-[10px] text-gray-400 ml-1">
                        /{subjectMap[selectedSubjectId]?.fullMark}
                      </span>
                    </th>
                    <th className="py-2 px-3 font-medium text-center">班级排名</th>
                  </tr>
                </thead>
                <tbody>
                  {students
                    .filter((s) => s.status !== 'Deleted')
                    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
                    .map((s) => {
                      const entry = singleScores[s.name]
                      return (
                        <tr
                          key={s.entity_id}
                          className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                        >
                          <td className="py-2 px-3 font-medium text-gray-700 dark:text-gray-200">
                            {s.name}
                          </td>
                          <td className="py-2 px-3 text-center">
                            <input
                              type="number"
                              value={entry?.score ?? ''}
                              onChange={(e) => updateSingleScore(s.name, 'score', e.target.value)}
                              placeholder="-"
                              min="0"
                              max={subjectMap[selectedSubjectId]?.fullMark}
                              step="0.5"
                              className="w-20 text-center bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                            />
                          </td>
                          <td className="py-2 px-3 text-center">
                            <input
                              type="number"
                              value={entry?.rank ?? ''}
                              onChange={(e) => updateSingleScore(s.name, 'rank', e.target.value)}
                              placeholder="-"
                              min="1"
                              className="w-16 text-center bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                            />
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </Card>
        )
      ) : !entryStudentName ? (
        <EmptyState icon="👆" title="请先选择学生" description="选择学生后即可录入成绩" />
      ) : (
        <Card padding="md">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              全科成绩录入 — {entryStudentName}
            </h4>
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={saving}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50 shadow-sm"
            >
              {saving ? '保存中...' : '💾 保存成绩'}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 px-3 font-medium">科目</th>
                  <th className="py-2 px-3 font-medium text-center">满分</th>
                  <th className="py-2 px-3 font-medium text-center">成绩</th>
                  <th className="py-2 px-3 font-medium text-center">班级排名</th>
                </tr>
              </thead>
              <tbody>
                {subjects.map((sub) => {
                  const entry = allScores[sub.id]
                  return (
                    <tr
                      key={sub.id}
                      className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <td className="py-2 px-3 font-medium text-gray-700 dark:text-gray-200">
                        {sub.name}
                        {sub.isCore && <span className="ml-1 text-[10px] text-blue-500">主科</span>}
                      </td>
                      <td className="py-2 px-3 text-center text-gray-400 dark:text-gray-500 font-mono">
                        {sub.fullMark}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <input
                          type="number"
                          value={entry?.score ?? ''}
                          onChange={(e) => updateAllScore(sub.id, 'score', e.target.value)}
                          placeholder="-"
                          min="0"
                          max={sub.fullMark}
                          step="0.5"
                          className="w-20 text-center bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                        />
                      </td>
                      <td className="py-2 px-3 text-center">
                        <input
                          type="number"
                          value={entry?.rank ?? ''}
                          onChange={(e) => updateAllScore(sub.id, 'rank', e.target.value)}
                          placeholder="-"
                          min="1"
                          className="w-16 text-center bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
