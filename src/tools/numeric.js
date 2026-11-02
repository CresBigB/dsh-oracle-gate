// kit_numeric —— 把数值内核暴露成一个可以直接问的工具。
//
// 它不是判据执行器：判据仍然是一条命令（脚本内部 import numeric.js）。
// 这个工具的用途是「先看看差多少」——设计阶段估误差、评审阶段复核别人的数字、
// 或者人想知道某个方案到底准不准。不记账、不落盘、不参与裁决。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compareSeries } from '../kernel/numeric.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    metrics: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

export function registerNumericTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'kit_numeric',
    description:
      '比较两条数值曲线，给出相对误差、绝对差、覆盖率与最差点。' +
      '用于估算或复核「算得对不对」，不记账、不参与裁决 —— 需要当判据用的，把断言写进脚本再由 kit_exec 执行。' +
      '阈值有硬上限：target ≤ 5%、maximum ≤ 10%，调高会被直接拒绝。',
    parameters: {
      spec: {
        type: 'json',
        required: true,
        description:
          '比较定义：{name, unit, reference:{points:[{coord:[x],value}], unit, scale?, offset?}, ' +
          'candidate:{...}, alignment?:"exact"|"linear", coordinate_tolerance?:number[], ' +
          'target?:0.05, maximum?:0.10, relative_floor:number, maximum_absolute?:number}。' +
          'unit 必须是 degC/bar/m/kg\/m3/m3\/s/rpm/dimensionless 之一；**参考与候选两边都必须显式给 unit**，省略会被拒绝（否则把 K 当 ℃ 传会算出偏小一个数量级的误差并判通过）。参考点的每个物理坐标都必须在候选里被覆盖，否则报错（不外推）。',
      },
    },
    output: {
      schema: OUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute: async (args) => {
      const spec = args.spec
      if (!spec || typeof spec !== 'object') {
        return { ok: false, summary: 'spec 必须是对象', metrics: null }
      }
      try {
        const metrics = compareSeries(spec)
        return {
          ok: true,
          summary: `${metrics.name}：最大相对误差 ${fmt(metrics.max_relative)}，${metrics.pass ? '通过' : '未通过'}`,
          metrics,
        }
      } catch (error) {
        return { ok: false, summary: error.message, metrics: null }
      }
    },
  }))
}

function renderText(value) {
  if (!value || !value.ok) {
    return `kit_numeric 失败：${value?.summary || value?.error || '未知错误'}`
  }
  const m = value.metrics ?? {}
  const lines = [
    `## ${m.name ?? 'metric'}（${m.unit ?? '?'}）：${m.pass ? '通过' : '未通过'}`,
    '',
    `- 最大相对误差 **${fmt(m.max_relative)}**（目标 ${fmt(m.target)}，上限 ${fmt(m.maximum)}，分母下限 ${m.relative_floor}）`,
    `- 最大绝对差 ${fmt(m.max_absolute)}，平均绝对差 ${fmt(m.mae)}`,
    `- 参考点 ${m.reference_points ?? '?'} / 候选点 ${m.candidate_points ?? '?'}，覆盖率 ${fmt(m.coverage)}`,
    `- 在目标内：${m.within_target ? '是' : '否'}`,
  ]
  if (m.worst && Array.isArray(m.worst.coord)) {
    lines.push(
      `- 最差点 coord=[${m.worst.coord.join(', ')}]：参考 ${fmt(m.worst.reference)} vs 候选 ${fmt(Number(m.worst.candidate))}`,
    )
  }
  const kinds = Object.entries(m.alignment_counts ?? {})
    .map(([key, count]) => `${key} ${count}`)
    .join(' / ')
  if (kinds) lines.push(`- 坐标对齐：${kinds}`)
  lines.push('', `> ${m.claim ?? ''}`)
  return lines.join('\n')
}

function fmt(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return String(x)
  if (x === 0) return '0'
  if (Math.abs(x) < 0.001 || Math.abs(x) >= 1000) return x.toExponential(3)
  return x.toFixed(5)
}
