/**
 * `oracle_gate_status`：一条命令回答「这个 run 跑到哪一步」。
 *
 * 与 oracle_gate_gate 的分工：oracle_gate_gate 回答「能不能准入」，oracle_gate_status 回答「现在到哪了」。
 * 两者共用同一个 evaluateGate，所以不会出现「进度说绿、裁决说红」的两套真相；
 * 但表面契约分开，调用方不会把某个工具的 verdict 误当成另一件事的结论。
 *
 * 严格只读：不 reserve、不写回执、不改 oracles.json，连 mkdir 都没有。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { loadOracles } from '../kernel/oracles.js'
import { readLedger } from '../kernel/ledger.js'
import { readReceipts } from '../kernel/receipt.js'
import { normalizeReviews } from '../kernel/gate.js'
import { runDirOf } from '../kernel/run.js'
import { renderRunStatus, summarizeRunStatus } from '../kernel/status.js'

// 三种失败码各自该怎么查。
// 原来这里只判一个 `'oracles-unavailable'`，而 loadOracles 从不产生这个码
// （实际是 not-frozen / hash-mismatch / corrupted），等于提示行恒为空 —— 评审
// 2026-11-01 notes 指出的死分支。
const ORACLE_ERROR_HINT = {
  'not-frozen': '先确认这个 run 已经用 oracle_gate_freeze 冻结过判据。',
  'hash-mismatch': 'oracles.json 在冻结后被改过，本次运行作废；要改判据请开新的 run_id 重新冻结。',
  corrupted: 'oracles.json 存在但内容坏了，检查文件是否被截断或写坏。',
}

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    markdown: { type: 'string' },
    verdict: { type: 'string' },
    total: { type: 'number' },
    passed: { type: 'json' },
    failed: { type: 'json' },
    missing: { type: 'json' },
    awaiting_human: { type: 'json' },
    notes: { type: 'json' },
    next_step: { type: 'string' },
    budget: { type: 'json' },
    items: { type: 'json' },
    receipts_total: { type: 'number' },
    skipped_receipts: { type: 'number' },
    corrupted_entries: { type: 'number' },
    run_dir: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

const EMPTY = {
  ok: false,
  summary: '',
  markdown: '',
  verdict: '',
  total: 0,
  passed: [],
  failed: [],
  missing: [],
  awaiting_human: [],
  notes: [],
  next_step: '',
  budget: {},
  items: [],
  receipts_total: 0,
  skipped_receipts: 0,
  corrupted_entries: 0,
  run_dir: '',
  error: '',
}

export function registerStatusTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_status',
      title: '查看某个 run 的进度（oracle_gate_status）',
      description:
        '回答「这个 run 现在到哪了」：哪些判据过 / 挂 / 没跑、7 个预算桶各剩多少、人工判据什么状态、下一步该做什么。'
        + '用户问进度、或者你不确定还有哪条没跑时用它，一次替代手翻 ledger.jsonl + oracles.json + receipts/ 三处。'
        + '只要知道 run_id 就能调；不确定项目里有哪些 run 就先调 oracle_gate。'
        + '严格只读：不写盘、不占预算。人工判据结论可选通过 reviews 传入，不传按「未传入评审」计。',
      parameters: {
        root: { type: 'string', required: true, description: '项目根目录绝对路径（与冻结时相同）。' },
        run_id: { type: 'string', required: true, description: '冻结时使用的 run_id（必填，与 oracle_gate_gate / oracle_gate_exec 一致）。' },
        reviews: {
          type: 'json',
          description:
            '可选：人工判据的评审结论，格式与 oracle_gate_gate 的 reviews 完全一致（数组或按判据 id 索引的对象）。不传时人工判据一律按「未传入评审」计，不声称「正在等人评」。',
        },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) =>
          value.ok
            ? [{ type: 'text', text: value.markdown }]
            : [{ type: 'text', text: `oracle_gate_status 失败：${value.summary || value.error}\n${ORACLE_ERROR_HINT[value.error] ?? ''}`.trim() }],
      },
      async execute(args) {
        const bad = (summary, error) => ({ ...EMPTY, summary, error })

        const rawRoot = typeof args.root === 'string' ? args.root.trim() : ''
        if (rawRoot === '' || !isAbsolute(rawRoot)) return bad('root 必须是绝对路径', 'root-not-absolute')
        const root = resolve(rawRoot)

        const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
        if (runId === '') return bad('run_id 不能为空', 'run-id-empty')

        let runDir
        try {
          runDir = runDirOf(root, runId)
        } catch (error) {
          return bad(`run_id 不合法：${error.message}`, 'run-id-invalid')
        }

        const loaded = await loadOracles(runDir)
        if (!loaded.ok) {
          // not-frozen / hash-mismatch 一律如实报，绝不降级成「大概对」继续算。
          return {
            ...bad(
              loaded.error === 'not-frozen'
                ? '这个 run 还没冻结过判据（找不到 oracles.json）'
                : 'oracles.json 在冻结后被修改过，本次运行作废',
              loaded.error,
            ),
            run_dir: runDir,
          }
        }

        const ledger = await readLedger(runDir)
        const receiptRead = await readReceipts(runDir)
        const reviews = normalizeReviews(args.reviews)

        const status = summarizeRunStatus({
          doc: loaded.doc,
          entries: ledger.entries,
          receipts: receiptRead.receipts,
          receiptsTotal: receiptRead.files,
          skippedReceipts: receiptRead.skipped,
          corruptedEntries: typeof ledger.corrupted === 'number' ? ledger.corrupted : 0,
          reviews,
        })

        return {
          ok: true,
          summary: `${status.verdict} · ${status.counts}`,
          markdown: renderRunStatus(status),
          verdict: status.verdict,
          total: status.total,
          passed: status.passed,
          failed: status.failed,
          missing: status.missing,
          awaiting_human: status.awaiting_human,
          notes: status.notes,
          next_step: status.next_step,
          budget: status.budget,
          items: status.items,
          receipts_total: status.receipts_total,
          skipped_receipts: status.skipped_receipts,
          corrupted_entries: status.corrupted_entries,
          run_dir: runDir,
          error: '',
        }
      },
    }),
  )
}
