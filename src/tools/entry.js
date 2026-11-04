/**
 * `oracle_gate`：验收台账总入口。
 *
 * 它回答的不是「某个 run 进行到哪了」（那是 oracle_gate_status），而是
 * 「这个项目现在有哪些验收没结清、下一步该调哪个工具」。
 *
 * 存在的理由：12 个平级工具铺在模型面前，它往往干脆一个都不挑。给一个
 * 无参数也能调的总入口，模型在「这活儿要不要验收」上犹豫时就有落点，
 * 而不是必须先想清楚该用 freeze 还是 status。
 *
 * 严格只读：不 reserve、不写回执、不改 oracles.json，连 mkdir 都没有。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { loadOracles } from '../kernel/oracles.js'
import { readLedger } from '../kernel/ledger.js'
import { readReceipts } from '../kernel/receipt.js'
import { summarizeRunStatus } from '../kernel/status.js'
import { STATE_DIR } from '../kernel/run.js'

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    root: { type: 'string' },
    runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
    next_step: { type: 'string' },
    markdown: { type: 'string' },
    error: { type: 'string' },
  },
}

// 每种裁决对应一句「接下来干什么」。与 kernel/gate.js 的 NEXT_BY_VERDICT 同义，
// 但这里面对的是「用户还没说要做哪一步」的场景，所以措辞落到工具名上。
const NEXT_BY_VERDICT = {
  'insufficient-evidence': '还有判据没跑：用 oracle_gate_exec 按 id 逐条补齐，再调 oracle_gate_gate 裁决',
  'blocked-on-human': '人工判据（L2/L3）还没传评审结论：调 oracle_gate_gate 并带上 reviews',
  rejected: '存在硬失败：修好后按同一 run 重跑 oracle_gate_exec，或开新 run_id 重新冻结',
  pass: '已准入，这个 run 无需再动',
}

const EMPTY = {
  ok: false,
  summary: '',
  root: '',
  runs: [],
  next_step: '',
  markdown: '',
  error: '',
}

/**
 * 一条 run 的状态行。未冻结 / 损坏的目录也要列出来 —— 那往往是「冻结到一半」，
 * 静默跳过会让用户以为台账是空的。
 */
async function describeRun(stateRoot, runId) {
  const runDir = join(stateRoot, runId)
  const loaded = await loadOracles(runDir)
  if (!loaded.ok) {
    return {
      run_id: runId,
      run_dir: runDir,
      verdict: null,
      state:
        loaded.error === 'not-frozen'
          ? '未冻结（目录里没有 oracles.json）'
          : loaded.error === 'hash-mismatch'
            ? '作废（oracles.json 在冻结后被改过）'
            : `无法读取（${loaded.error}）`,
      counts: '',
      missing: [],
      awaiting_human: [],
      next_step:
        loaded.error === 'hash-mismatch'
          ? '判据被改过，这个 run 不可信：换一个 run_id 重新 oracle_gate_freeze'
          : '这个 run 还没冻结判据，先 oracle_gate_freeze',
      unresolved: true,
    }
  }

  const ledger = await readLedger(runDir)
  const receiptRead = await readReceipts(runDir)
  const status = summarizeRunStatus({
    doc: loaded.doc,
    entries: ledger.entries,
    receipts: receiptRead.receipts,
    receiptsTotal: receiptRead.files,
    skippedReceipts: receiptRead.skipped,
    corruptedEntries: typeof ledger.corrupted === 'number' ? ledger.corrupted : 0,
    // 总入口不替用户填评审结论：没传就是「未传入评审」，不假装正在等人评。
    reviews: [],
  })

  return {
    run_id: runId,
    run_dir: runDir,
    verdict: status.verdict,
    state: '',
    counts: status.counts,
    total: status.total,
    passed: status.passed.length,
    failed: status.failed.length,
    missing: status.missing,
    awaiting_human: status.awaiting_human,
    next_step: status.next_step || NEXT_BY_VERDICT[status.verdict] || '',
    unresolved: status.verdict !== 'pass',
  }
}

function renderMarkdown(root, runs) {
  const lines = [`## 验收台账 · \`${root}\``, '']
  if (runs.length === 0) {
    lines.push('这个项目下还没有任何验收记录（`.protocol-kit/` 不存在或为空）。', '')
    lines.push('只想确认测试/类型检查/构建都过时，直接调 `oracle_gate_check`（不给 oracles 会按项目脚本自动推荐）；')
    lines.push('需要逐条控制或含人工判据时，先调 `oracle_gate_freeze` 冻结判据；')
    lines.push('判据还没想清楚、需求也模糊时，先用 `oracle_gate_run`（stage="clarify"）把需求澄清成可验收的 spec。')
    return lines.join('\n')
  }

  lines.push('| run | 状态 | 计数 | 下一步 |')
  lines.push('| --- | --- | --- | --- |')
  for (const run of runs) {
    const state = run.verdict === null ? run.state : run.verdict
    lines.push(`| \`${run.run_id}\` | ${state} | ${run.counts || '—'} | ${run.next_step || '—'} |`)
  }

  const open = runs.filter((run) => run.unresolved)
  lines.push('')
  if (open.length === 0) {
    lines.push('全部 run 都已准入，没有欠账。新任务要验收就再 `oracle_gate_freeze` 一轮。')
  } else {
    lines.push(`**还有 ${open.length} 个 run 没结清。** 从最近的一个开始：`)
    for (const run of open.slice(0, 3)) {
      lines.push(`- \`${run.run_id}\`：${run.next_step || '需要推进'}`)
    }
  }
  return lines.join('\n')
}

export function registerEntryTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate',
      title: '验收台账总入口（oracle_gate）',
      description:
        '不确定验收类任务该用哪个 oracle gate 工具时，先调我。'
        + '我扫当前项目 `.protocol-kit/` 下的全部 run，报告每个 run 卡在哪一步、下一步该调 freeze / exec / gate 里的哪一个；'
        + '项目里还没有任何 run 时，我会说明该从冻结判据开始，还是先用 oracle_gate_run 澄清需求。'
        + '无参数也能调（缺省用插件进程当前目录，返回里会写明实际用的路径）。'
        + '严格只读：不写盘、不占预算、不改任何 run 记录。',
      parameters: {
        root: {
          type: 'string',
          description:
            '项目根目录绝对路径，例如 E:\\Vibe Codeing Project\\SomeProject。留空则用插件进程的当前工作目录。',
        },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => [
          { type: 'text', text: value.ok ? value.markdown : `oracle_gate 失败：${value.summary || value.error}` },
        ],
      },
      async execute(args) {
        const bad = (summary, error) => ({ ...EMPTY, summary, error })

        const rawRoot = typeof args.root === 'string' ? args.root.trim() : ''
        if (rawRoot !== '' && !isAbsolute(rawRoot)) {
          return bad('root 必须是绝对路径（或留空用当前目录）', 'root-not-absolute')
        }
        const root = rawRoot === '' ? process.cwd() : resolve(rawRoot)

        const stateRoot = join(root, STATE_DIR)
        let names = []
        try {
          const entries = await readdir(stateRoot, { withFileTypes: true })
          const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
          const stamped = await Promise.all(
            dirs.map(async (dir) => {
              let mtime = 0
              try {
                mtime = (await stat(join(stateRoot, dir))).mtimeMs
              } catch {
                // 单个目录 stat 失败就当它最旧，不影响其它 run。
              }
              return { name: dir, mtime }
            }),
          )
          stamped.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
          names = stamped.map((item) => item.name)
        } catch (error) {
          if (error?.code === 'ENOENT') {
            const markdown = renderMarkdown(root, [])
            return {
              ok: true,
              summary: '这个项目还没有任何验收记录',
              root,
              runs: [],
              next_step: '只想确认测试/构建都过就 oracle_gate_check；要逐条控制就 oracle_gate_freeze 冻结判据；需求还模糊就先 oracle_gate_run（stage="clarify"）',
              markdown,
              error: '',
            }
          }
          return bad(`读不了 ${stateRoot}：${error.message}`, 'state-dir-unreadable')
        }

        const runs = []
        for (const runId of names) {
          try {
            runs.push(await describeRun(stateRoot, runId))
          } catch (error) {
            // 单个 run 读坏不许拖垮整张台账。
            runs.push({
              run_id: runId,
              run_dir: join(stateRoot, runId),
              verdict: null,
              state: `读取失败（${error.message}）`,
              counts: '',
              missing: [],
              awaiting_human: [],
              next_step: '这个 run 目录读不动，先人工看一眼',
              unresolved: true,
            })
          }
        }

        // 未结清的排前面；组内保持采集顺序（run 目录 mtime 倒序，最近动过的在前）。
        runs.sort((a, b) => (a.unresolved === b.unresolved ? 0 : a.unresolved ? -1 : 1))

        const open = runs.filter((run) => run.unresolved)
        return {
          ok: true,
          summary:
            runs.length === 0
              ? '没有 run'
              : `${runs.length} 个 run，${runs.length - open.length} 个已准入，${open.length} 个未结清`,
          root,
          runs,
          next_step: open.length === 0 ? '' : open[0].next_step,
          markdown: renderMarkdown(root, runs),
          error: '',
        }
      },
    }),
  )
}
