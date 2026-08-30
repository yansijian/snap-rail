/**
 * Station-terminal clock formatting shared across pages (Chinese-facing
 * surfaces; `toLocaleTimeString` respects the runtime locale settings).
 *
 * @module @snap-rail/util/clock
 */

/** Local wall-clock `HH:mm:ss` of an epoch-milliseconds timestamp. */
export function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false })
}

/** Human duration in Chinese: `X时X分`, `X分X秒`, or `X秒`, floored at zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}时${minutes}分`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}
