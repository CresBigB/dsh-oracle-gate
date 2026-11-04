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
import { codeFingerprint } from '../kernel/fingerprint.js'
import { makeRefChecker } from '../kernel/evidence.js'
import { appendReviews, mergeReviews, readReviews } from '../kernel/reviews.js'
import { readLedger } from '../kernel/ledger.js'
import { signingContext } from '../kernel/signing.js'

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
    bad_evidence_refs: { type: 'json' },
    stale: { type: 'json' },
    reviews_from_archive: { type: 'json' },
    stale_reviews: { type: 'json' },
    code_fingerprint: { type: 'json' },
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
        + '不要用我来给自己打分：pass 只代表「冻结的判据都过了」，不代表活儿干得对。不读任何 agent 的自我评价。'
        + '在 git 工作区里，回执若对应的是旧代码（执行之后又改过代码），该判据按「未跑」处理，需要重跑。',
      parameters: {
        root: { type: 'string', required: true, description: '项目根目录绝对路径（与冻结时相同）。' },
        run_id: { type: 'string', required: true, description: '冻结时使用的 run_id。' },
        reviews: {
          type: 'json',
          description:
            '人工判据的评审结论。数组形式：[{"oracle_id":"L2-code-review","verdict":"pass","veto":false,"unknowns":[],"evidence_refs":["src/a.ts:12"]}]；也可写成按判据 id 索引的对象：{"L2-code-review":{"verdict":"pass","veto":false,"unknowns":[],"evidence_refs":["src/a.ts:12"]}}。两种都接受。veto 为 true、unknowns 非空、evidence_refs 为空或含无效引用都会导致该判据不通过。evidence_refs 每项须是 root 内真实存在的文件（可带行号，如 src/a.ts:12 或 src/a.ts:12-30，行号不能超出文件）或本 run 的回执 id（如 rcpt_3_L0-test）；URL 与自由文本不算证据。传入的评审会追加存档到 reviews.jsonl（带代码指纹），之后不传 reviews 时沿用存档中仍对应当前代码的最新一条。',
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
            Array.isArray(value.bad_evidence_refs) && value.bad_evidence_refs.length > 0 ? `无效证据引用：${value.bad_evidence_refs.map((item) => `${item.id}：${item.refs.map((r) => `${r.ref}（${r.reason}）`).join('，')}`).join('；')}` : '',
            Array.isArray(value.stale) && value.stale.length > 0 ? `回执过期（代码已改）：${value.stale.join('、')}` : '',
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

        const signingCtx = signingContext(loaded.doc)
        if (!signingCtx.ok) return bad(`签名校验不可用，无法裁决：${signingCtx.hint}`, signingCtx.error)
        const key = signingCtx.key
        const passedIn = normalizeReviews(args.reviews)
        const { receipts, tampered: tamperedReceipts = 0 } = await readReceipts(runDir, { key })
        const ledgerAudit = key !== null ? await readLedger(runDir, { key }) : { tampered: 0 }
        const fingerprint = codeFingerprint(root)
        // 本次传入的评审先存档（带当时的代码指纹），再与历史存档合并：没传的判据沿用存档里
        // 最新且仍对应当前代码的那条。存档只追加，不改写。
        const manualIds = new Set(loaded.doc.oracles.filter((oracle) => oracle.manual).map((oracle) => oracle.id))
        const toArchive = passedIn.filter((review) => manualIds.has(String(review.oracle_id ?? review.id ?? '')))
        const { reviews: archived, tampered: tamperedReviews = 0 } = await readReviews(runDir, { key })
        await appendReviews(runDir, toArchive, fingerprint.kind === 'git' ? { kind: 'git', head: fingerprint.head, value: fingerprint.value } : null, { key })
        const merged = mergeReviews({ passed: passedIn, archived, fingerprint })
        const checkRef = makeRefChecker(root, {
          receiptIds: new Set(receipts.map((receipt) => receipt.receipt_id).filter((id) => typeof id === 'string')),
        })
        const result = evaluateGate({ doc: loaded.doc, receipts, reviews: merged.reviews, fingerprint, checkRef })
        if (merged.from_archive.length > 0) result.notes.push(`沿用存档评审：${merged.from_archive.join('、')}`)
        if (merged.stale_reviews.length > 0) result.notes.push(`存档评审针对的是旧代码，不再采信：${merged.stale_reviews.join('、')}`)
        if (fingerprint.kind !== 'git') result.notes.push('root 不是 git 工作区：没有检查回执/评审是否对应当前代码')
        if (tamperedReceipts > 0) result.notes.push(`${tamperedReceipts} 份回执签名不符，已不采信（按未跑处理）`)
        if (tamperedReviews > 0) result.notes.push(`${tamperedReviews} 条存档评审签名不符，已不采信`)
        if (key === null) result.notes.push('本 run 冻结时未启用签名：回执/账本/评审未做防篡改校验')
        // 账本被删改：预算记录不可信，整个 run 不能准入
        if (ledgerAudit.tampered > 0) {
          result.notes.push(`账本有 ${ledgerAudit.tampered} 行签名或链校验不通过，本 run 不可信`)
          result.verdict = 'rejected'
        }

        return {
          ok: true,
          summary: summarizeGate(result),
          ...result,
          reviews_from_archive: merged.from_archive,
          stale_reviews: merged.stale_reviews,
          code_fingerprint: fingerprint,
          tampered: { receipts: tamperedReceipts, reviews: tamperedReviews, ledger: ledgerAudit.tampered },
          next_step: NEXT_BY_VERDICT[result.verdict] ?? '',
          error: '',
        }
      },
    }),
  )
}
