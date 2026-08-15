import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  emptyFields,
  parseExpression,
  describeExpression,
  computeNextRuns,
  resolveTimeZone,
  resolveNow,
} from './cron.js'

export const name = 'dsh-cron-parse'
export const inject = ['tools']

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    valid: { type: 'boolean', required: true },
    description: { type: 'string', required: true },
    fields: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        minute: { type: 'array', items: { type: 'number' }, required: true },
        hour: { type: 'array', items: { type: 'number' }, required: true },
        dom: { type: 'array', items: { type: 'number' }, required: true },
        month: { type: 'array', items: { type: 'number' }, required: true },
        dow: { type: 'array', items: { type: 'number' }, required: true },
      },
    },
    nextRuns: { type: 'array', items: { type: 'string' }, required: true },
    timezone: { type: 'string', required: true },
    errors: { type: 'array', items: { type: 'string' }, required: true },
  },
}

function runCronParse(args) {
  const count = args.count == null ? 5 : args.count
  const expression = typeof args.expression === 'string' ? args.expression.trim() : ''

  const tz = resolveTimeZone(args.tz)
  if (!tz.ok) {
    return {
      ok: false,
      valid: false,
      description: '无效的 IANA 时区',
      fields: emptyFields(),
      nextRuns: [],
      timezone: args.tz == null ? '' : String(args.tz),
      errors: [`无效时区 "${args.tz}"（需为 IANA 时区名，如 Asia/Shanghai、UTC）`],
    }
  }
  const timezone = tz.timeZone

  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return {
      ok: false,
      valid: false,
      description: 'count 参数无效',
      fields: emptyFields(),
      nextRuns: [],
      timezone,
      errors: [`count 必须为 1–10 的整数，收到 ${JSON.stringify(args.count)}`],
    }
  }

  const now = resolveNow(args.now)
  if (!now.ok) {
    return {
      ok: false,
      valid: false,
      description: 'now 参数无效',
      fields: emptyFields(),
      nextRuns: [],
      timezone,
      errors: [`now 必须为 ISO 8601 时间字符串，收到 "${args.now}"`],
    }
  }

  const parsed = parseExpression(expression)
  if (!parsed.ok) {
    return {
      ok: false,
      valid: false,
      description: '无效的 cron 表达式',
      fields: parsed.fields,
      nextRuns: [],
      timezone,
      errors: parsed.errors,
    }
  }

  const description = describeExpression(parsed.parts, parsed.fields)
  const runs = computeNextRuns(expression, { count, now: now.date, timeZone: timezone })

  return {
    ok: runs.ok,
    valid: true,
    description,
    fields: parsed.fields,
    nextRuns: runs.nextRuns,
    timezone,
    errors: runs.errors,
  }
}

function renderCron(args, value) {
  const lines = [`cron 表达式：${args.expression}`]
  if (!value.ok) {
    lines.push(`解析结果：失败${value.errors.length ? `（${value.errors.join('；')}）` : ''}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const f = value.fields
  const arr = (a) => (a && a.length ? a.join(',') : '—')
  lines.push(`描述：${value.description}`)
  lines.push(`时区：${value.timezone}`)
  lines.push(`字段展开：分钟=[${arr(f.minute)}] 小时=[${arr(f.hour)}] 日=[${arr(f.dom)}] 月=[${arr(f.month)}] 星期=[${arr(f.dow)}]`)
  lines.push(`接下来 ${value.nextRuns.length} 次运行：`)
  for (const t of value.nextRuns) lines.push(`  - ${t}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function isWeekend(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return true
  const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()
  return wd === 0 || wd === 6
}

async function runSelfTest(ctx) {
  const cases = [
    {
      label: '①工作日 9 点',
      expression: '0 9 * * 1-5',
      count: 3,
      check: (v) => v.ok && v.nextRuns.length === 3 && v.nextRuns.every((t) => !isWeekend(t)),
    },
    {
      label: '②每 15 分钟',
      expression: '*/15 * * * *',
      count: 3,
      check: (v) => v.ok && v.nextRuns.length === 3,
    },
    {
      label: '③每年 1 月 1 日',
      expression: '0 0 1 jan *',
      count: 3,
      check: (v) => v.ok && v.nextRuns.every((t) => t.includes('-01-01T00:00:00')),
    },
    {
      label: '④非法值',
      expression: '99 99 * * *',
      count: 3,
      check: (v) => v.ok === false && v.valid === false && v.errors.length > 0,
    },
    {
      label: '⑤2 月 30 日永不触发',
      expression: '0 0 30 2 *',
      count: 3,
      check: (v) => v.ok === false && v.valid === true && v.errors.some((e) => e.includes('永不触发') || e.includes('未凑满')),
    },
  ]

  for (const c of cases) {
    try {
      const result = await ctx.tools.execute({
        callId: CallId(`cron-parse-self-test-${c.label}`),
        name: 'cron_parse',
        arguments: { expression: c.expression, count: c.count },
        signal: new AbortController().signal,
      })
      const value = result.value
      const pass = !!value && c.check(value)
      console.log(
        `[dsh-cron-parse] self-test ${c.label} "${c.expression}" => ${pass ? 'PASS' : 'FAIL'} (ok=${value?.ok}, valid=${value?.valid}, runs=${value?.nextRuns?.length}, errors=${(value?.errors || []).length})`,
      )
    } catch (err) {
      console.log(`[dsh-cron-parse] self-test ${c.label} "${c.expression}" => ERROR: ${err?.message || err}`)
    }
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'cron_parse',
    description:
      '解析 5 段标准 cron 表达式（minute hour dayOfMonth month dayOfWeek），返回校验结果、中文人性化描述、各字段展开值与未来若干次运行时间（支持 IANA 时区）。',
    parameters: {
      expression: {
        type: 'string',
        required: true,
        description: '5 段标准 cron 表达式，如 "0 9 * * 1-5"（分钟 小时 日 月 星期）',
      },
      count: {
        type: 'number',
        default: 5,
        description: '返回未来运行次数（1–10），默认 5',
      },
      tz: {
        type: 'string',
        description: 'IANA 时区名（如 Asia/Shanghai、UTC），默认本地时区',
      },
      now: {
        type: 'string',
        description: 'ISO 8601 基准时间，默认当前时间',
      },
    },
    output: {
      schema: OUT_SCHEMA,
      render: renderCron,
    },
    async execute(args) {
      return runCronParse(args)
    },
  }))

  console.log('[dsh-cron-parse] plugin loaded, tool cron_parse registered')

  void runSelfTest(ctx)
}
