// cron.js — 纯函数 cron 解析 / 人性化 / 下次运行计算。零依赖，无 I/O。

/** 月名（大小写不敏感）。 */
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** 星期名（大小写不敏感）。 */
const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/** 各字段取值范围。dow 允许 0-7，7 视作周日（0）。 */
const FIELD_SPECS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: MONTH_NAMES },
  dow: { min: 0, max: 7, names: DOW_NAMES, sunday7: true },
}

const FIELD_ORDER = ['minute', 'hour', 'dom', 'month', 'dow']

/** 每月最大天数（按闰年，覆盖 2 月 29 日）。 */
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** 迭代上限（扫描天数；对可满足表达式与 count≤10 永不触顶，仅作兜底）。 */
export const MAX_ITERATIONS = 100000

export function emptyFields() {
  return { minute: [], hour: [], dom: [], month: [], dow: [] }
}

function resolveValue(token, spec) {
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  if (spec.names) {
    const lower = token.toLowerCase()
    if (Object.hasOwn(spec.names, lower)) return spec.names[lower]
  }
  return null
}

function parseToken(part, spec, fieldName) {
  let base = part
  let step = 1

  if (part.includes('/')) {
    const slash = part.indexOf('/')
    base = part.slice(0, slash)
    const stepStr = part.slice(slash + 1)
    if (!/^\d+$/.test(stepStr)) {
      return { ok: false, errors: [`${fieldName} 字段步长非法："${stepStr}"`] }
    }
    step = parseInt(stepStr, 10)
    if (step < 1) {
      return { ok: false, errors: [`${fieldName} 字段步长必须 ≥ 1："${stepStr}"`] }
    }
  }

  let lo
  let hi
  if (base === '*' || base === '') {
    lo = spec.min
    hi = spec.max
  } else if (base.includes('-')) {
    const seg = base.split('-')
    if (seg.length !== 2 || seg[0] === '' || seg[1] === '') {
      return { ok: false, errors: [`${fieldName} 字段非法范围："${base}"`] }
    }
    const a = resolveValue(seg[0], spec)
    const b = resolveValue(seg[1], spec)
    if (a == null || b == null) {
      return { ok: false, errors: [`${fieldName} 字段非法 token："${base}"`] }
    }
    lo = a
    hi = b
    if (lo > hi) {
      return { ok: false, errors: [`${fieldName} 字段范围起点大于终点："${base}"`] }
    }
  } else {
    const v = resolveValue(base, spec)
    if (v == null) {
      return { ok: false, errors: [`${fieldName} 字段非法 token："${base}"`] }
    }
    lo = v
    hi = v
  }

  if (lo < spec.min || hi > spec.max) {
    return { ok: false, errors: [`${fieldName} 字段值越界："${base}"（允许 ${spec.min}-${spec.max}）`] }
  }

  const values = []
  for (let v = lo; v <= hi; v += step) {
    values.push(spec.sunday7 && v === 7 ? 0 : v)
  }
  return { ok: true, values, errors: [] }
}

function parseField(text, spec, fieldName) {
  const errors = []
  const set = new Set()
  for (const part of text.split(',').map((s) => s.trim())) {
    if (part === '') {
      errors.push(`${fieldName} 字段包含空 token`)
      continue
    }
    const r = parseToken(part, spec, fieldName)
    if (!r.ok) errors.push(...r.errors)
    else for (const v of r.values) set.add(v)
  }
  if (errors.length) return { ok: false, values: [], errors }
  return { ok: true, values: [...set].sort((a, b) => a - b), errors: [] }
}

/**
 * 解析 5 段标准 cron 表达式。
 * @returns {{ ok: boolean, fields: object, errors: string[], parts: string[] }}
 */
export function parseExpression(expression) {
  const fields = emptyFields()
  const errors = []
  const raw = typeof expression === 'string' ? expression : ''
  const parts = raw.trim().split(/\s+/).filter(Boolean)

  if (parts.length !== 5) {
    errors.push(`cron 表达式必须恰好 5 个字段（当前 ${parts.length} 个）：minute hour dayOfMonth month dayOfWeek`)
    return { ok: false, fields, errors, parts }
  }

  let ok = true
  for (let i = 0; i < 5; i++) {
    const name = FIELD_ORDER[i]
    const r = parseField(parts[i], FIELD_SPECS[name], name)
    if (!r.ok) {
      ok = false
      errors.push(...r.errors)
    } else {
      fields[name] = r.values
    }
  }
  return { ok, fields, errors, parts }
}

/** 经典 Vixie 语义：字段只有为纯 `*` 时才视为“不受限”。 */
export function isRestricted(fieldText) {
  return (fieldText || '').trim() !== '*'
}

/**
 * 日匹配（经典 Vixie 语义）。
 * dom 与 dow **都受限**时取并集（OR）；仅一个受限时用它；都不受限时每天匹配。
 */
function dayMatches(domRestricted, dowRestricted, domSet, dowSet, day, weekday) {
  if (domRestricted && dowRestricted) return domSet.has(day) || dowSet.has(weekday)
  if (domRestricted) return domSet.has(day)
  if (dowRestricted) return dowSet.has(weekday)
  return true
}

const formatterCache = new Map()
function getFormatter(timeZone) {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

/** 在目标时区下读取某一时刻的墙钟分量与 UTC 偏移（分钟）。 */
function wallClock(date, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(date)
  const m = {}
  for (const p of parts) m[p.type] = p.value
  const year = +m.year
  const month = +m.month
  const day = +m.day
  const hour = +m.hour % 24
  const minute = +m.minute
  const second = +m.second
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second)
  const offsetMin = Math.round((asUTC - date.getTime()) / 60000)
  return { year, month, day, hour, minute, second, weekday, offsetMin }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 由目标时区墙钟分量反解出绝对时刻（定点迭代，DST 安全）。 */
function dateInTz(year, month, day, hour, minute, second, timeZone) {
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second)
  let ms = asUTC
  for (let i = 0; i < 3; i++) {
    ms = asUTC - wallClock(new Date(ms), timeZone).offsetMin * 60000
  }
  return new Date(ms)
}

function formatISO(date, timeZone) {
  const w = wallClock(date, timeZone)
  const sign = w.offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(w.offsetMin)
  return `${pad2(w.year)}-${pad2(w.month)}-${pad2(w.day)}T${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/**
 * 可满足性预判：仅 dow=* 且 dom 受限时，可能因“日/月”无可行组合而永不触发
 * （例如 2 月 30 日）。dow 受限时其集合恒非空，总会撞到匹配的星期几，故必然触发。
 */
function isSatisfiable(domRestricted, dowRestricted, domSet, monthSet) {
  if (!domRestricted || dowRestricted) return true
  for (const m of monthSet) {
    for (const d of domSet) {
      if (d <= MAX_DAYS[m - 1]) return true
    }
  }
  return false
}

/**
 * 计算未来 count 次运行：从 now 的下一分钟边界起，逐日扫描（日内按 hour×minute
 * 枚举匹配时刻），上限 MAX_ITERATIONS 天。永不触发的表达式由可满足性预判提前拦截。
 * @returns {{ ok: boolean, fields: object, nextRuns: string[], errors: string[], exhausted: boolean }}
 */
export function computeNextRuns(expression, { count, now, timeZone }) {
  const parsed = parseExpression(expression)
  if (!parsed.ok) {
    return { ok: false, fields: parsed.fields, nextRuns: [], errors: parsed.errors, exhausted: false }
  }

  const minuteSet = new Set(parsed.fields.minute)
  const hourSet = new Set(parsed.fields.hour)
  const domSet = new Set(parsed.fields.dom)
  const monthSet = new Set(parsed.fields.month)
  const dowSet = new Set(parsed.fields.dow)
  const domRestricted = isRestricted(parsed.parts[2])
  const dowRestricted = isRestricted(parsed.parts[4])

  if (!isSatisfiable(domRestricted, dowRestricted, domSet, monthSet)) {
    return {
      ok: false,
      fields: parsed.fields,
      nextRuns: [],
      errors: ['表达式永不触发：日/月组合无任何可行日期（例如 2 月 30 日）'],
      exhausted: true,
    }
  }

  const hours = [...hourSet].sort((a, b) => a - b)
  const minutes = [...minuteSet].sort((a, b) => a - b)
  const times = []
  for (const h of hours) for (const m of minutes) times.push([h, m])

  const nowMs = now.getTime()
  const nextMs = Math.floor(nowMs / 60000) * 60000 + 60000

  const nextRuns = []
  let w = wallClock(new Date(Math.floor(nowMs / 60000) * 60000), timeZone)
  let exhausted = false

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (monthSet.has(w.month) && dayMatches(domRestricted, dowRestricted, domSet, dowSet, w.day, w.weekday)) {
      for (const [h, m] of times) {
        const t = dateInTz(w.year, w.month, w.day, h, m, 0, timeZone)
        if (t.getTime() >= nextMs) {
          nextRuns.push(formatISO(t, timeZone))
          if (nextRuns.length >= count) break
        }
      }
      if (nextRuns.length >= count) break
    }
    w = wallClock(dateInTz(w.year, w.month, w.day + 1, 0, 0, 0, timeZone), timeZone)
  }

  exhausted = nextRuns.length < count
  const errors = exhausted
    ? [`在 ${MAX_ITERATIONS} 天迭代内未凑满 ${count} 次运行，表达式可能永不触发`]
    : []
  return { ok: !exhausted, fields: parsed.fields, nextRuns, errors, exhausted }
}

/** 校验 IANA 时区；空值回退本地时区。 */
export function resolveTimeZone(tz) {
  if (tz == null || tz === '') {
    try {
      return { ok: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
    } catch {
      return { ok: true, timeZone: 'UTC' }
    }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return { ok: true, timeZone: tz }
  } catch {
    return { ok: false, timeZone: null }
  }
}

/** 解析 ISO 基准时间；空值回退当前时间。 */
export function resolveNow(now) {
  if (now == null || now === '') return { ok: true, date: new Date() }
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) return { ok: false, date: null }
  return { ok: true, date: d }
}

function hhmm(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`
}

/** 把升序数组压成连续区间 [[start,end], ...]。 */
function compress(values) {
  const ranges = []
  let start = values[0]
  let end = values[0]
  for (let i = 1; i <= values.length; i++) {
    const v = values[i]
    if (v === end + 1) {
      end = v
      continue
    }
    ranges.push([start, end])
    if (i < values.length) {
      start = v
      end = v
    }
  }
  return ranges
}

function formatRanges(values, labelOf) {
  return compress(values)
    .map(([s, e]) => (s === e ? labelOf(s) : `${labelOf(s)}至${labelOf(e)}`))
    .join('、')
}

function humanizeDow(values) {
  if (values.length === 7) return '每天'
  return `周${formatRanges(values, (v) => DOW_LABELS[v])}`
}

function humanizeMonth(values) {
  return formatRanges(values, (v) => `${v}月`)
}

function humanizeDom(values) {
  return formatRanges(values, (v) => `${v}日`)
}

function fallbackDescription(parts, fields) {
  const arr = (a) => (a.length ? a.join(',') : '—')
  return `cron 表达式 "${parts.join(' ')}"；展开值：分钟=[${arr(fields.minute)}]，小时=[${arr(fields.hour)}]，日=[${arr(fields.dom)}]，月=[${arr(fields.month)}]，星期=[${arr(fields.dow)}]`
}

/**
 * 中文人性化描述，覆盖常见模式；复杂表达式退化为“字段原文 + 展开值”。
 */
export function describeExpression(parts, fields) {
  const [minTxt, hourTxt, domTxt, monthTxt, dowTxt] = parts
  const minute = fields.minute
  const hour = fields.hour
  const dom = fields.dom
  const month = fields.month
  const dow = fields.dow

  const minuteSingle = minute.length === 1
  const hourSingle = hour.length === 1
  const hourWild = hourTxt === '*'
  const minuteWild = minTxt === '*'
  const domWild = domTxt === '*'
  const monthWild = monthTxt === '*'
  const dowWild = dowTxt === '*'

  const time = minuteSingle && hourSingle ? hhmm(hour[0], minute[0]) : null

  // 每天固定时刻
  if (time && domWild && monthWild && dowWild) return `每天 ${time}`

  // 每周（dow 受限、dom=*）
  if (time && domWild && monthWild && !dowWild) {
    const d = humanizeDow(dow)
    if (d === '每天') return `每天 ${time}`
    return `每${d} ${time}`
  }

  // 每小时第 N 分钟
  if (minuteSingle && hourWild && domWild && monthWild && dowWild) {
    const m = minute[0]
    if (m === 0) return '每小时整点'
    return `每小时的第 ${m} 分钟`
  }

  // 每 N 分钟
  const minuteStep = /^\*\/(\d+)$/.exec(minTxt)
  if (minuteStep && hourWild && domWild && monthWild && dowWild) {
    return `每 ${minuteStep[1]} 分钟`
  }

  // 每 N 小时
  const hourStep = /^\*\/(\d+)$/.exec(hourTxt)
  if (minuteSingle && hourStep && domWild && monthWild && dowWild) {
    return minute[0] === 0 ? `每 ${hourStep[1]} 小时整点` : `每 ${hourStep[1]} 小时的第 ${minute[0]} 分钟`
  }

  // 每月固定日期
  if (time && !domWild && monthWild && dowWild) {
    return `每月${humanizeDom(dom)} ${time}`
  }

  // 每年（月受限）
  if (time && dowWild && !monthWild) {
    if (!domWild) return `每年${humanizeMonth(month)}${humanizeDom(dom)} ${time}`
    return `每年${humanizeMonth(month)} ${time}`
  }

  return fallbackDescription(parts, fields)
}
