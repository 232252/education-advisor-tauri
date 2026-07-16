// =============================================================
// useAsync — 异步操作 hook
// 用法:
//   const { data, error, loading, run } = useAsync(async () => fetch(...))
// =============================================================

import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
}

export function useAsync<T, Args extends unknown[] = []>(
  fn: (...args: Args) => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
) {
  const [state, setState] = useState<AsyncState<T>>({
    data: undefined,
    error: undefined,
    loading: false,
  })
  const mounted = useRef(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  // L-9 修复: runId 防止旧异步结果覆盖新结果(stale closure race)
  const runIdRef = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(
    async (...args: Args) => {
      const runId = ++runIdRef.current
      setState({ data: undefined, error: undefined, loading: true })
      try {
        const data = await fnRef.current(...args)
        // L-9: 仅当本次 run 是最新的才更新状态
        if (mounted.current && runId === runIdRef.current) {
          setState({ data, error: undefined, loading: false })
        }
        return data
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (mounted.current && runId === runIdRef.current) {
          setState({ data: undefined, error, loading: false })
        }
        throw error
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: 用户控制 deps
    deps,
  )

  // 首次挂载自动执行
  useEffect(() => {
    void run(...([] as unknown as Args))
    // biome-ignore lint/correctness/useExhaustiveDependencies: 用户控制 deps
  }, deps)

  return { ...state, run }
}
