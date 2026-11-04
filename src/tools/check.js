/**
 * `oracle_gate_check`：轻量模式，一次调用完成「冻结 → 逐条执行 → 裁决」。
 *
 * 不新造任何语义：内部直接调用 freeze / exec / gate 三个工具的 execute，
 * 冻结、预检、签名、指纹、预算、裁决规则与分步调用完全一致，回执照样落在 .protocol-kit/<run_id>/。
 * 不给 oracles 时，按项目已有脚本自动推荐 L0 判据（见 kernel/suggest.js）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { registerFreezeTool } from './freeze.js'
import { registerExecTool } from './exec.js'
import { registerGateTool } from './gate.js'
import { suggestOracles } from '../kernel/suggest.js'
import { suggestRunId } from '../kernel/run.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    run_id: { type: 'string' },
    verdict: { type: 'string' },
    suggested: { type: 'boolean' },
    skipped_suggestions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
    gate: { type: 'object', additionalProperties: true },
    issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
    next_step: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

/** 拿到三个分步工具的 execute，不注册到宿主上（宿主那边已经各自注册过）。 */
function innerTools() {
  const tools = new Map()
  const fake = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  registerFreezeTool(fake)
  registerExecTool(fake)
  registerGateTool(fake)
  // defineTool 要求参数是无损 JSON：值为 undefined 的键要先去掉。
  return (name, args) => tools.get(name).execute(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)))
}

export function registerCheckTool(ctx) {
  const call = innerTools()
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_check',
      title: '一次完成验收（oracle_gate_check）',
      description:
        '轻量模式：一次调用完成「冻结判据 → 逐条执行 → 准入裁决」，适合改完代码想确认测试/类型检查/构建是否都过。'
        + '不给 oracles 时，按项目已有的 package.json scripts（typecheck/lint/test/build）、tsconfig、pytest、Cargo.toml、go.mod 自动推荐 L0 判据，找不到可执行文件的推荐会跳过并列出。'
        + '规则与分步调用 oracle_gate_freeze / oracle_gate_exec / oracle_gate_gate 完全一致（预检、文件锁、签名、代码指纹都照常生效），记录落在 <root>/.protocol-kit/<run_id>/，事后可用 oracle_gate_status 查。'
        + '含 L2/L3 人工判据时可一并传 reviews；不传则结论为 blocked-on-human。需要逐条控制执行顺序或中途改代码重跑时，改用分步工具。',
      parameters: {
        root: { type: 'string', required: true, description: '项目根目录绝对路径。' },
        run_id: { type: 'string', description: '可选；留空自动生成 check-<时间戳>。一个 run_id 只能冻结一次。' },
        oracles: {
          type: 'json',
          description: '可选，判据数组，格式同 oracle_gate_freeze 的 oracles（支持 argv / expect 断言 / lock_paths）。留空则自动推荐。',
        },
        reviews: { type: 'json', description: '可选，人工判据评审，格式同 oracle_gate_gate 的 reviews。' },
        budget: { type: 'json', description: '可选，同 oracle_gate_freeze 的 budget；也可直接给一个数字，表示最多执行多少次。' },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? [
              `## 裁决：${value.verdict}`,
              value.summary,
              ...value.results.map((item) => `- \`${item.oracle_id}\`：${item.verdict}${item.exit_code === null || item.exit_code === undefined ? '' : `（退出码 ${item.exit_code}）`}`),
              value.skipped_suggestions.length === 0 ? '' : `跳过的推荐（找不到可执行文件）：${value.skipped_suggestions.map((item) => item.id).join('、')}`,
              '',
              value.next_step,
            ].filter((line) => line !== '').join('\n')
            : `oracle_gate_check 失败：${value.summary || value.error}`,
        }],
      },
      async execute(args) {
        const base = { ok: false, summary: '', run_id: '', verdict: '', suggested: false, skipped_suggestions: [], results: [], gate: {}, issues: [], next_step: '', error: '' }
        const bad = (summary, error, extra = {}) => ({ ...base, summary, error, ...extra })

        const rawRoot = typeof args.root === 'string' ? args.root.trim() : ''
        if (rawRoot === '' || !isAbsolute(rawRoot)) return bad('root 必须是绝对路径', 'root is not absolute')
        const root = resolve(rawRoot)
        try {
          if (!(await stat(root)).isDirectory()) return bad('root 不是目录', `not a directory: ${root}`)
        } catch {
          return bad('root 不存在', `not found: ${root}`)
        }

        const runId = typeof args.run_id === 'string' && args.run_id.trim() !== '' ? args.run_id.trim() : suggestRunId('check')
        let oracles = Array.isArray(args.oracles) && args.oracles.length > 0 ? args.oracles : null
        let suggested = false
        let skipped = []
        if (oracles === null) {
          const all = suggestOracles(root)
          skipped = all.filter((item) => !item.available).map(({ id, argv, reason }) => ({ id, argv, reason }))
          oracles = all.filter((item) => item.available).map(({ id, level, criterion, argv }) => ({ id, level, criterion, argv }))
          suggested = true
          if (oracles.length === 0) {
            return bad('没给 oracles，项目里也找不到可推荐的检查（package.json scripts / tsconfig / pytest / Cargo / go.mod）；请手写 oracles', 'no-suggestions', { run_id: runId, suggested, skipped_suggestions: skipped })
          }
        }

        const frozen = await call('oracle_gate_freeze', { root, run_id: runId, oracles, budget: args.budget })
        if (!frozen.ok) {
          return bad(`冻结失败：${frozen.summary}`, frozen.error || 'freeze-failed', { run_id: runId, suggested, skipped_suggestions: skipped, issues: frozen.issues ?? [] })
        }

        const results = []
        for (const oracle of frozen.oracles) {
          if (oracle.manual) continue
          const ex = await call('oracle_gate_exec', { root, run_id: runId, oracle_id: oracle.id })
          results.push({
            oracle_id: oracle.id,
            verdict: ex.ok ? ex.verdict : 'not-run',
            exit_code: ex.ok ? ex.exit_code : null,
            receipt_file: ex.ok ? ex.receipt_file : '',
            detail: ex.ok ? (ex.verdict === 'passed' ? '' : (ex.stderr_head || ex.stdout_head || '').slice(-800)) : ex.summary,
          })
        }

        const gate = await call('oracle_gate_gate', { root, run_id: runId, reviews: args.reviews })
        const passed = results.filter((item) => item.verdict === 'passed').length
        return {
          ...base,
          ok: true,
          run_id: runId,
          verdict: gate.verdict,
          suggested,
          skipped_suggestions: skipped,
          results,
          gate,
          summary: `${suggested ? '自动推荐' : '按给定'}判据 ${frozen.oracles.length} 条，执行 ${results.length} 条，通过 ${passed} 条；${gate.summary ?? ''}`,
          next_step: gate.verdict === 'pass'
            ? '全部通过。'
            : gate.verdict === 'blocked-on-human'
              ? `还有人工判据待评审：用 oracle_gate_gate（run_id=${runId}）传 reviews。`
              : `修好后用新的 run_id 再调一次 oracle_gate_check，或对本 run（${runId}）用 oracle_gate_exec 重跑失败项后再 oracle_gate_gate。`,
        }
      },
    }),
  )
}
