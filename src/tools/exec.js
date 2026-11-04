/**
 * `oracle_gate_exec`：按冻结判据 id 执行命令。
 *
 * 它刻意不接受 command 参数。命令只可能来自冻结过的 oracles.json —— 这是整个内核
 * 唯一值得叫「铁律」的地方：如果执行时可以临时给命令，那冻结就没意义，agent 完全
 * 可以先跑一条宽松的命令拿到绿色，再宣布通过。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { normalizeBudget, reserve, readLedger } from '../kernel/ledger.js'
import { findOracle, loadOracles, verifyFiles } from '../kernel/oracles.js'
import { executeOracle, writeReceipt, verdictOf } from '../kernel/receipt.js'
import { runDirOf } from '../kernel/run.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    oracle_id: { type: 'string' },
    verdict: { type: 'string' },
    exit_code: { type: 'json' },
    duration_ms: { type: 'integer' },
    timed_out: { type: 'boolean' },
    receipt_file: { type: 'string' },
    stdout_head: { type: 'string' },
    stderr_head: { type: 'string' },
    remaining_budget: { type: 'object', additionalProperties: true },
    next_step: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

const EMPTY = {
  ok: false,
  summary: '',
  oracle_id: '',
  verdict: '',
  exit_code: null,
  duration_ms: 0,
  timed_out: false,
  receipt_file: '',
  stdout_head: '',
  stderr_head: '',
  remaining_budget: {},
  next_step: '',
  error: '',
}

export function registerExecTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_exec',
      title: '按冻结判据执行（oracle_gate_exec）',
      description:
        '冻结之后每一次实际执行都要经过我。'
        + '按已冻结的判据 id 跑一条命令：先过账本预留（预留即消耗，失败也不退），再用不经过 shell 的 spawn 执行，最后把退出码、输出哈希、耗时写成回执。'
        + '判据没跑过就是「未执行」，不会被当成通过——所以别拿自己随手跑的输出去替代我。'
        + '只在 oracle_gate_freeze 冻结之后调用；不接受临时指定的命令；账本余额不足时直接拒绝执行。',
      parameters: {
        root: { type: 'string', required: true, description: '项目根目录绝对路径（与冻结时相同）。' },
        run_id: { type: 'string', required: true, description: '冻结时使用的 run_id。' },
        oracle_id: {
          type: 'string',
          required: true,
          description: '要执行的判据 id，必须存在于已冻结的 oracles.json 中。',
        },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? [
            `## ${value.summary}`,
            `判据：\`${value.oracle_id}\` · 结果：${value.verdict}${value.timed_out ? '（超时被杀）' : ''}`,
            `退出码：${value.exit_code === null ? 'null' : value.exit_code} · 耗时：${value.duration_ms} ms`,
            `回执：\`${value.receipt_file}\``,
            value.stdout_head === '' ? '' : '\nstdout:\n```\n' + value.stdout_head + '\n```',
            value.stderr_head === '' ? '' : '\nstderr:\n```\n' + value.stderr_head + '\n```',
            '',
            `剩余预算：${JSON.stringify(value.remaining_budget)}`,
            value.next_step,
          ].filter((line) => line !== '').join('\n')
          : `oracle_gate_exec 失败：${value.summary || value.error}`,
        }],
      },
      async execute(args) {
        const bad = (summary, error, extra = {}) => ({ ...EMPTY, summary, error, ...extra })

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
          const reason =
            loaded.error === 'not-frozen'
              ? `run_id「${runId}」还没有冻结判据，请先调用 oracle_gate_freeze。`
              : loaded.error === 'hash-mismatch'
                ? `oracles.json 在冻结后被修改过（期望 ${loaded.expected?.slice(0, 20)}…，实际 ${loaded.actual?.slice(0, 20)}…），本次运行作废。`
                : `判据不可用：${loaded.error}`
          return bad(reason, JSON.stringify(loaded), { oracle_id: '' })
        }

        const oracleId = typeof args.oracle_id === 'string' ? args.oracle_id.trim() : ''
        const oracle = findOracle(loaded.doc, oracleId)
        if (oracle === null) {
          return bad(
            `判据「${oracleId}」不存在。已冻结的判据：${loaded.doc.oracles.map((item) => item.id).join('、')}`,
            'oracle-not-found',
            { oracle_id: oracleId },
          )
        }
        if (oracle.manual) {
          return bad(
            `判据「${oracleId}」是人工判据（${oracle.level}），不能由 oracle_gate_exec 执行；请评审给出结论后通过 oracle_gate_gate 的 reviews 传入。`,
            'manual-oracle',
            { oracle_id: oracleId },
          )
        }

        // 冻结时记下的文件必须还是原样。放在预算预留之前 —— 文件被改不该扣一次额度。
        const intact = verifyFiles(root, oracle.files)
        if (!intact.ok) {
          const lines = [
            ...intact.changed.map(
              (item) =>
                `  - ${item.path}：期望 ${item.expected.slice(0, 12)}…，实际 ${item.actual.slice(0, 12)}…`,
            ),
            ...intact.missing.map((item) => `  - ${item.path}：文件已不存在`),
          ].join('\\n')
          return bad(
            `判据「${oracleId}」引用的文件在冻结后被改过，判定已不可信，拒绝执行：\\n${lines}\\n要跑新的验收，请开新的 run-id 重新冻结。`,
            JSON.stringify(intact),
            { oracle_id: oracleId },
          )
        }

        // 预算在冻结时定死。若允许执行时传 budget，「超了就把额度调高」就是一条后门。
        const budget = normalizeBudget(loaded.doc.budget)
        const reserved = await reserve(runDir, {
          bucket: oracle.bucket,
          amount: 1,
          budget,
          oracle_id: oracle.id,
          note: oracle.command,
        })
        if (!reserved.ok) {
          return bad(
            reserved.error === 'budget-exhausted'
              ? `预算不足：桶「${oracle.bucket}」已用 ${budget[oracle.bucket] - reserved.remaining}/${budget[oracle.bucket]}，本次需要 ${reserved.need}。预留即消耗、不退款，所以没有余额就是不能跑。`
              : `账本预留失败：${reserved.error}`,
            JSON.stringify(reserved),
            { oracle_id: oracleId },
          )
        }

        const result = await executeOracle({ root, oracle, signal: undefined })
        const { entries } = await readLedger(runDir)
        const { file, receipt } = await writeReceipt(runDir, result, entries.length)
        const verdict = verdictOf(receipt)

        const tail = receipt.stderr_head.trim().split('\n').slice(-6).join('\n')
        const headline =
          verdict === 'passed'
            ? `判据「${oracleId}」通过（退出码 ${receipt.exit_code}，${receipt.duration_ms}ms）`
            : verdict === 'timed-out'
              ? `判据「${oracleId}」超时（${oracle.timeout_ms}ms 上限）`
              : verdict === 'spawn-failed'
                ? `判据「${oracleId}」无法启动：${receipt.spawn_error}`
                : verdict === 'assertion-failed'
                  ? `判据「${oracleId}」输出断言未通过（退出码 ${receipt.exit_code} 符合预期）：${(receipt.assertions ?? []).filter((item) => item.ok !== true).map((item) => item.detail ?? item.kind).join('；')}`
                  : `判据「${oracleId}」失败（退出码 ${receipt.exit_code}，期望 ${receipt.expected_exit_code}）`

        return {
          // ok 表示「工具本身执行成功」，判据是否通过由 verdict 单独表达。
          // 判据不通过是有效结果，不是工具错误。
          ok: true,
          summary: headline,
          oracle_id: oracleId,
          verdict,
          exit_code: receipt.exit_code,
          duration_ms: receipt.duration_ms,
          timed_out: receipt.timed_out,
          receipt_file: file,
          stdout_head: receipt.stdout_head.slice(-2000),
          stderr_head: tail,
          remaining_budget: reserved.remaining,
          next_step:
            verdict === 'passed'
              ? '继续执行下一条判据，全部跑完后调用 oracle_gate_gate。'
              : '失败就记进 oracle_gate_failures 并归类（实现缺陷回 implement，判据本身定错回 freeze 开新 run，基础设施问题不重放）。注意这次额度已经花掉了，不会退还。',
          error: '',
        }
      },
    }),
  )
}

