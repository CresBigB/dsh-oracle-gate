/**
 * `oracle_gate_gate`：算准入。
 *
 * 输入只有三样：冻结的判据、真实的回执、结构化的评审结论。没有任何地方读 agent
 * 自己的「我觉得做完了」——这是这套内核相对「让模型自己判断」的唯一区别。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadOracles } from '../kernel/oracles.js'
import { evaluateGate, NEXT_BY_VERDICT, normalizeReviews, summarizeGate } from '../kernel/gate.js'
import { readReceipts } from '../kernel/receipt.js'
import { runDirOf } from '../kernel/run.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    verdict: { type: 'string' },
    total: { type: 'integer' },
    passed: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'object', additionalProperties: true } },
    missing: { type: 'array', items: { type: 'string' } },
    awaiting_human: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    vetoed: { type: 'json' },
    with_unknowns: { type: 'json' },
    without_evidence_refs: { type: 'json' },
    next_step: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

export function registerGateTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_gate',
      title: '计算准入裁决（oracle_gate_gate）',
      description:
        '判据都跑完之后算准入结论：pass / rejected / insufficient-evidence / blocked-on-human。'
        + '由「已冻结判据 + 真实执行回执 + 结构化评审」算出来，硬门失败时人工传 pass 也无效。'
        + '人工判据（L2/L3）的结论必须通过 reviews 传进来，任一 veto、unknowns 非空或缺少 evidence_refs 都不准入。'
        + '不要用我来给自己打分：pass 只代表「冻结的判据都过了」，不代表活儿干得对。不读任何 agent 的自我评价。',
      parameters: {
        root: { type: 'string', required: true, description: '项目根目录绝对路径（与冻结时相同）。' },
        run_id: { type: 'string', required: true, description: '冻结时使用的 run_id。' },
        reviews: {
          type: 'json',
          description:
            '人工判据的评审结论。数组形式：[{"oracle_id":"L2-code-review","verdict":"pass","veto":false,"unknowns":[],"evidence_refs":["src/a.ts:12"]}]；也可写成按判据 id 索引的对象：{"L2-code-review":{"verdict":"pass","veto":false,"unknowns":[],"evidence_refs":["src/a.ts:12"]}}。两种都接受。veto 为 true、unknowns 非空、或 evidence_refs 为空都会导致该判据不通过。',
        },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? [
            `## 裁决：${value.verdict}`,
            value.summary,
            `通过 ${value.passed.length} / 共 ${value.total}`,
            value.failed.length === 0 ? '' : `硬失败：${JSON.stringify(value.failed)}`,
            value.missing.length === 0 ? '' : `未执行：${value.missing.join('、')}`,
            value.awaiting_human.length === 0 ? '' : `待人工：${value.awaiting_human.join('、')}`,
            Array.isArray(value.vetoed) && value.vetoed.length > 0 ? `被 veto：${value.vetoed.join('、')}` : '',
            Array.isArray(value.with_unknowns) && value.with_unknowns.length > 0 ? `带 unknowns：${value.with_unknowns.length} 条` : '',
            Array.isArray(value.without_evidence_refs) && value.without_evidence_refs.length > 0 ? `缺证据引用：${value.without_evidence_refs.length} 条` : '',
            value.notes.length === 0 ? '' : `备注：${value.notes.join('；')}`,
            '',
            value.next_step,
          ].filter((line) => line !== '').join('\n')
          : `oracle_gate_gate 失败：${value.summary || value.error}`,
        }],
      },
      async execute(args) {
        const bad = (summary, error) => ({
          ok: false,
          summary,
          verdict: '',
          total: 0,
          passed: [],
          failed: [],
          missing: [],
          awaiting_human: [],
          notes: [],
          next_step: '',
          error,
        })

        const rawRoot = typeof args.root === 'string' ? args.root.trim() : ''
        if (rawRoot === '' || !isAbsolute(rawRoot)) return bad('root 必须是绝对路径', 'root is not absolute')
        const root = resolve(rawRoot)
        try {
          const info = await stat(root)
          if (!info.isDirectory()) return bad('root 不是目录', `not a directory: ${root}`)
        } catch {
          return bad('root 不存在', `not found: ${root}`)
        }

        const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
        if (runId === '') return bad('run_id 不能为空', 'run_id is empty')
        let runDir
        try {
          runDir = runDirOf(root, runId)
        } catch (error) {
          return bad(error instanceof Error ? error.message : String(error), 'bad run_id')
        }

        const loaded = await loadOracles(runDir)
        if (!loaded.ok) {
          return bad(
            loaded.error === 'not-frozen'
              ? `run_id「${runId}」还没有冻结判据，先调用 oracle_gate_freeze。`
              : loaded.error === 'hash-mismatch'
                ? 'oracles.json 在冻结后被修改过，本次运行作废。'
                : `判据不可用：${loaded.error}`,
            JSON.stringify(loaded),
          )
        }

        const reviews = normalizeReviews(args.reviews)
        const { receipts } = await readReceipts(runDir)
        const result = evaluateGate({ doc: loaded.doc, receipts, reviews })

        return {
          ok: true,
          summary: summarizeGate(result),
          ...result,
          next_step: NEXT_BY_VERDICT[result.verdict] ?? '',
          error: '',
        }
      },
    }),
  )
}
