// =============================================================
// 共享 UI 工具函数 — 风险颜色、设计 tokens、class 合并
// =============================================================

import type { EAARiskLevel } from '@shared/types'

/** 风险等级文字颜色（统一 4 处重复的 riskColor 函数） */
export function riskColor(risk: EAARiskLevel | string): string {
  switch (risk) {
    case '低':
      return 'text-green-500 dark:text-green-400'
    case '中':
      return 'text-yellow-500 dark:text-yellow-400'
    case '高':
      return 'text-orange-500 dark:text-orange-400'
    case '极高':
      return 'text-red-500 dark:text-red-400 font-bold'
    default:
      return 'text-gray-500'
  }
}

/** 风险等级背景色（用于 badge / 标签） */
export function riskBgColor(risk: EAARiskLevel | string): string {
  switch (risk) {
    case '低':
      return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
    case '中':
      return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
    case '高':
      return 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
    case '极高':
      return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
    default:
      return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
  }
}

/** 风险等级圆点色 */
export function riskDotColor(risk: EAARiskLevel | string): string {
  switch (risk) {
    case '低':
      return 'bg-green-500'
    case '中':
      return 'bg-yellow-500'
    case '高':
      return 'bg-orange-500'
    case '极高':
      return 'bg-red-500'
    default:
      return 'bg-gray-400'
  }
}

/** Agent 状态颜色 */
export function agentStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-blue-400 animate-pulse'
    case 'error':
      return 'bg-red-400'
    case 'idle':
      return 'bg-gray-400 dark:bg-gray-500'
    default:
      return 'bg-gray-300'
  }
}

/**
 * 分数/总分变化颜色(正=进步绿,负=退步红,零=持平灰)。
 * 用于考试对比中的 scoreDelta、totalScoreDelta、conductDelta。
 * null(数据缺失)返回浅灰。
 */
export function deltaColor(delta: number | null): string {
  if (delta === null || delta === undefined) return 'text-gray-400'
  if (delta > 0) return 'text-green-600 dark:text-green-400'
  if (delta < 0) return 'text-red-600 dark:text-red-400'
  return 'text-gray-500 dark:text-gray-400'
}

/**
 * 名次变化颜色。名次语义与分数相反:数值变小=上升=进步。
 * 因此 delta < 0(名次数字下降)显示绿色,delta > 0 显示红色。
 * null(未录入)返回浅灰。
 */
export function rankDeltaColor(delta: number | null): string {
  if (delta === null || delta === undefined) return 'text-gray-400'
  if (delta < 0) return 'text-green-600 dark:text-green-400' // 名次数字变小 = 上升
  if (delta > 0) return 'text-red-600 dark:text-red-400' // 名次数字变大 = 下降
  return 'text-gray-500 dark:text-gray-400'
}

/** 条件 class 合并（轻量版 clsx） */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

/** 统一卡片样式 */
export const CARD_BASE =
  'rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'

export const CARD_INTERACTIVE = `${CARD_BASE} transition-all duration-200 hover:shadow-md`

/** 统一输入框样式 */
export const INPUT_BASE =
  'rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

/** 统一按钮样式 */
export function btnStyle(
  variant: 'primary' | 'secondary' | 'danger' | 'ghost' = 'primary',
): string {
  const base =
    'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed'
  switch (variant) {
    case 'primary':
      return `${base} bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500 active:scale-[0.97]`
    case 'secondary':
      return `${base} bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 focus:ring-gray-400 border border-gray-200 dark:border-gray-600`
    case 'danger':
      return `${base} bg-red-600 hover:bg-red-700 text-white focus:ring-red-500 active:scale-[0.97]`
    case 'ghost':
      return `${base} hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 focus:ring-gray-400`
  }
}

/** 统一 badge 样式 */
export function badgeStyle(
  variant: 'info' | 'success' | 'warning' | 'danger' | 'neutral' = 'neutral',
): string {
  const base = 'inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full'
  switch (variant) {
    case 'info':
      return `${base} bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400`
    case 'success':
      return `${base} bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400`
    case 'warning':
      return `${base} bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400`
    case 'danger':
      return `${base} bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400`
    case 'neutral':
      return `${base} bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400`
  }
}
