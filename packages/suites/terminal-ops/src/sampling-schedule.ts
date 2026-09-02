/**
 * A deliberately tiny cron: five-field syntax where only the minute and hour
 * fields may vary (sub-hourly frequencies are all the sampling workflow
 * needs); day-of-month, month, and day-of-week must stay wildcards. A field
 * is a wildcard, a number, a range, a stepped wildcard, or a comma list —
 * the classic combinations an operator would write for "every 30 minutes"
 * or "at :00 and :30 of hours 8-20".
 *
 * @module @snap-rail/suite-terminal-ops/sampling/schedule
 */

/** A parsed schedule: the matching minute and hour values. */
export interface CronSpec {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
}

/** Field forms: wildcard, `a`, `a-b`, each with an optional step suffix, and
 * comma lists. */
function parseField(field: string, low: number, high: number): Set<number> {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const slash = part.indexOf('/')
    const base = slash === -1 ? part : part.slice(0, slash)
    const stepText = slash === -1 ? undefined : part.slice(slash + 1)
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10)
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长不合法：${part}`)
    let from = low
    let to = high
    if (base !== '*') {
      const range = /^(\d+)(?:-(\d+))?$/.exec(base)
      if (range === null) throw new Error(`cron 字段不合法：${part}`)
      from = Number.parseInt(range[1]!, 10)
      to = range[2] !== undefined ? Number.parseInt(range[2], 10) : from
    }
    if (from < low || to > high || from > to) throw new Error(`cron 范围越界：${part}（${low}-${high}）`)
    for (let value = from; value <= to; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`cron 字段为空：${field}`)
  return values
}

/**
 * Parse a five-field cron expression (minute hour * * *).
 * @throws a labelled error naming the offending part.
 */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron 需要 5 个字段（分 时 日 月 周）：${expr}`)
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  if (dom !== '*' || month !== '*' || dow !== '*') {
    throw new Error('cron 只支持分钟与小时字段，日/月/周必须为 *')
  }
  return { minutes: parseField(minute, 0, 59), hours: parseField(hour, 0, 23) }
}

function matches(spec: CronSpec, at: Date): boolean {
  return spec.minutes.has(at.getMinutes()) && spec.hours.has(at.getHours())
}

/**
 * The next due time strictly after `from`, at minute resolution.
 * @returns epoch milliseconds of the next matching minute.
 */
export function nextDue(spec: CronSpec, from: Date): number {
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  // Two days covers any hour-field pattern (the wildest is sparse hours).
  for (let i = 0; i < 2 * 24 * 60; i += 1) {
    if (matches(spec, cursor)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new Error('cron 两天内无匹配时刻（字段为空集？）')
}
