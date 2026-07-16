// =============================================================
// Card — 统一卡片容器组件
// 提供一致的卡片样式，支持交互态、padding 变体。
// =============================================================

import type { ReactNode } from 'react'
import { cn } from '../lib/ui-utils'

interface CardProps {
  children: ReactNode
  /** 是否可交互（添加 hover 效果） */
  interactive?: boolean
  /** padding 变体 */
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /** 额外样式 */
  className?: string
  /** 点击事件 */
  onClick?: () => void
}

const paddingMap = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-6',
}

export function Card({
  children,
  interactive = false,
  padding = 'md',
  className,
  onClick,
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
        paddingMap[padding],
        interactive &&
          'transition-all duration-200 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer',
        onClick && 'cursor-pointer',
        className,
      )}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

/** 卡片标题区（含分隔线） */
export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between mb-4', className)}>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
