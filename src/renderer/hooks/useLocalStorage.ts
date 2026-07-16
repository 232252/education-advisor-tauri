// =============================================================
// useLocalStorage — 同步本地存储 hook
// 用法: const [value, setValue] = useLocalStorage('key', defaultValue)
// =============================================================

import { useCallback, useEffect, useState } from 'react'

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const readValue = useCallback((): T => {
    if (typeof window === 'undefined') return initialValue
    try {
      const raw = window.localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initialValue
    } catch (err) {
      console.warn(`[useLocalStorage] Failed to read '${key}':`, err)
      return initialValue
    }
  }, [key, initialValue])

  const [stored, setStored] = useState<T>(readValue)

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStored((prev) => {
        const next = value instanceof Function ? value(prev) : value
        try {
          window.localStorage.setItem(key, JSON.stringify(next))
        } catch (err) {
          console.warn(`[useLocalStorage] Failed to write '${key}':`, err)
        }
        // L-12 修复: 传入 newValue,使同标签页内其他订阅相同 key 的组件也能同步
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(next) }))
        return next
      })
    },
    [key],
  )

  // 跨标签页同步
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== key || e.newValue === null) return
      try {
        setStored(JSON.parse(e.newValue) as T)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [key])

  return [stored, setValue]
}
