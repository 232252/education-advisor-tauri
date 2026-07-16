// =============================================================
// useDataLoader — 统一数据加载 Hook
// 封装 loading/error/data 状态管理 + toast 错误提示，
// 消除各页面重复的 useCallback + try/catch + setLoading 模式。
// =============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../stores/toastStore'

interface UseDataLoaderOptions<T> {
  /** 数据获取函数 */
  fetcher: () => Promise<T>
  /** 加载失败时的 toast 前缀（可选，不传则不弹 toast） */
  errorPrefix?: string
  /** 初始值 */
  initialData?: T
  /** 是否立即加载（默认 true） */
  immediate?: boolean
}

interface UseDataLoaderReturn<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** 手动触发加载 */
  load: () => Promise<void>
  /** 直接设置数据（用于乐观更新） */
  setData: (data: T | null) => void
}

export function useDataLoader<T>({
  fetcher,
  errorPrefix,
  initialData,
  immediate = true,
}: UseDataLoaderOptions<T>): UseDataLoaderReturn<T> {
  const [data, setData] = useState<T | null>(initialData as T | null)
  const [loading, setLoading] = useState(immediate)
  const [error, setError] = useState<string | null>(null)
  // L-8 修复: 移除 loadedRef,改为依赖 fetcher 引用变化自动重新加载。
  // 之前 loadedRef 一旦设为 true 永不重置,fetcher 变化时不会重新获取数据。
  const mountedRef = useRef(true)

  const load = useCallback(async () => {
    // R6-6 修复: mountedRef 检查在 setLoading 之前,避免卸载后 setState
    if (!mountedRef.current) return
    setLoading(true)
    setError(null)
    try {
      const result = await fetcher()
      if (mountedRef.current) setData(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (mountedRef.current) {
        setError(msg)
        if (errorPrefix) {
          toast.error(`${errorPrefix}: ${msg}`)
        }
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [fetcher, errorPrefix])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 立即加载,并在 fetcher 变化时重新加载
  useEffect(() => {
    if (immediate) {
      load()
    }
  }, [immediate, load])

  return { data, loading, error, load, setData }
}
