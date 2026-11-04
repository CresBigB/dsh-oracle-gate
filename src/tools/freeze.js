/**
 * `oracle_gate_freeze`：把验收判据一次性冻结。
 *
 * 这是整套执行内核的锚点。冻结之后判据不可修改，`oracle_gate_exec` 只能按 id 跑它们 ——
 * 于是「跑什么」这个决定在开始执行前就定死了，执行过程中的任何人（包括 agent 自己）
 * 都没法把门槛调低来让结果通过。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { normalizeBudget, DEFAULT_BUDGET, BUCKETS } from '../kernel/ledger.js'
import { freezeOracles } from '../kernel/oracles.js'
import { compileAcceptance } from '../kernel/compile.js'
import { runDirOf } from '../kernel/run.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    run_dir: { type: 'string' },
    hash: { type: 'string' },
    budget: { type: 'object', additionalProperties: true },
    oracles: { type: 'array', items: { type: 'object', additionalProperties: true } },
    issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
    source: { type: 'string' },
    dry_run: { type: 'boolean' },
    next_step: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

export function registerFreezeTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_freeze',
      title: '冻结验收判据（oracle_gate_freeze）',
      description:
        '动手前先冻结验收判据。'
        + '当用户要求「实现 / 修复 / 重构 / 优化」一个有客观验收标准的东西（测试通过、性能数字、构建产物、对比基准、可复算的结果）时，先调我把分层判据（L0 编译/类型检查/单测、L1 量化指标、L2 结构化评审、L3 人类品味）固化成 oracles.json 并记哈希；'
        + '之后只有 oracle_gate_exec 能按这些 id 跑，谁都没法在跑到一半时调低门槛。'
        + '不要用于：纯问答、单行 typo、探索性调研、只是读代码看看。'
        + '代价：一个 run_id 只能冻一次，要改判据就得换 run_id 重来；命令里禁止 && / 管道 / 重定向 / 通配符，要跑多个进程就拆成多条判据。先用 dry_run 看一遍再正式冻结。',
      parameters: {
        root: {
          type: 'string',
          required: true,
          description: '项目根目录绝对路径。判据的 cwd 必须落在它之内，落盘也写在它下面。',
        },
        run_id: {
          type: 'string',
          required: true,
          description:
            '本次运行的标识，只允许字母数字点横线，例如 thermal-2026-11-01。产物落在 <root>/.protocol-kit/<run_id>/。一个 run_id 只能冻结一次。',
        },
        oracles: {
          type: 'json',
          description:
            '判据数组（与 acceptance 二选一，给了就优先用它）。每项形如 {"id":"L0-typecheck","level":"L0","criterion":"类型检查通过","command":"npx tsc --noEmit","cwd":".","bucket":"execution","timeout_ms":120000,"expect":{"exit_code":0}}。L2/L3 是人工判据，可以不写 command。命令里禁止出现管道、重定向、通配符、&& 等 shell 元字符——要跑多个进程就拆成多条判据。',
        },
        acceptance: {
          type: 'json',
          description:
            '直接喂 oracle_gate_design 产出的 spec.acceptance（[{criterion, level, check}]），由工具编译成 oracles：L0/L1 从 check 里提命令并自动拆 &&/; 链，L2/L3 转人工判据。L0/L1 提不出命令时不会自动降级成人工判据（那等于拆掉硬门），而是报 issue 让你补。建议先 dry_run 看一眼再冻结。',
        },
        dry_run: {
          type: 'boolean',
          description:
            '只编译不落盘，返回编译出的 oracles 与 issues 供人工复核。冻结不可逆，先用它确认命令真的能跑再正式冻结。',
        },
        budget: {
          type: 'json',
          description: `分桶预算，缺省为 v4 的拆分：${JSON.stringify(DEFAULT_BUDGET)}。可用桶：${BUCKETS.join(' / ')}。预留即消耗，不退款。`,
        },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => {
          const lines = value.ok
            ? [
              `## ${value.summary}`,
              ...(value.dry_run === true ? [] : [`判据哈希：\`${value.hash}\``]),
              `产物目录：\`${value.run_dir}\``,
              `来源：${value.source === 'compiled' ? '由 acceptance 编译' : '显式传入'}`,
              '',
              '```json',
              JSON.stringify(value.oracles, null, 2),
              '```',
            ]
            : [`oracle_gate_freeze 失败：${value.summary || value.error}`]

          const issues = Array.isArray(value.issues) ? value.issues : []
          if (issues.length > 0) {
            lines.push('', '### 编译提示')
            for (const issue of issues) {
              lines.push(
                `- [${issue.severity ?? 'info'}] ${issue.reason} · ${issue.criterion || '(无 criterion)'} —— ${issue.detail ?? ''}`,
              )
            }
          }
          // 编译失败时也要把已经过编译的判据列出来：否则人只看到「有 1 条没过」，
          // 不知道剩下几条其实已经能用了，得重新猜一遍。
          if (!value.ok && Array.isArray(value.oracles) && value.oracles.length > 0) {
            lines.push(
              '',
              `### 已成功编译的判据（${value.oracles.length} 条，本次未冻结）`,
              '```json',
              JSON.stringify(value.oracles, null, 2),
              '```',
            )
          }
          if (value.ok && value.next_step) lines.push('', value.next_step)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const invalid = (summary, error) => ({
          ok: false,
          summary,
          error,
          run_dir: '',
          hash: '',
          budget: DEFAULT_BUDGET,
          oracles: [],
          next_step: '',
        })

        const rawRoot = typeof args.root === 'string' ? args.root.trim() : ''
        if (rawRoot === '' || !isAbsolute(rawRoot)) {
          return invalid('root 必须是绝对路径', 'root is not absolute')
        }
        const root = resolve(rawRoot)
        try {
          const info = await stat(root)
          if (!info.isDirectory()) return invalid('root 不是目录', `not a directory: ${root}`)
        } catch {
          return invalid('root 不存在', `not found: ${root}`)
        }

        const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
        if (runId === '') return invalid('run_id 不能为空', 'run_id is empty')

        let runDir
        try {
          runDir = runDirOf(root, runId)
        } catch (error) {
          return invalid(error instanceof Error ? error.message : String(error), 'bad run_id')
        }

        const budget = normalizeBudget(args.budget)

        const explicit = Array.isArray(args.oracles) && args.oracles.length > 0
        const hasAcceptance = Array.isArray(args.acceptance) && args.acceptance.length > 0
        if (!explicit && !hasAcceptance) {
          return invalid(
            '必须给 oracles 或 acceptance 之一：前者是手写判据，后者直接喂 oracle_gate_design 的 spec.acceptance 由工具编译',
            'no-oracles',
          )
        }

        const compiled = hasAcceptance
          ? compileAcceptance(args.acceptance)
          : { oracles: [], issues: [], blocking_count: 0 }
        const oracleList = explicit ? args.oracles : compiled.oracles
        const source = explicit ? 'explicit' : 'compiled'

        // 编译不出来的 L0/L1 绝不放行：少一条硬门等于把门拆了
        if (!explicit && compiled.blocking_count > 0) {
          return {
            ...invalid(
              `有 ${compiled.blocking_count} 条判据没能编译成功，先补命令或改写 check 再冻结（详见 issues）`,
              'compile-blocked',
            ),
            run_dir: runDir,
            issues: compiled.issues,
            source,
            oracles: compiled.oracles,
          }
        }

        if (args.dry_run === true) {
          const executable = oracleList.filter((oracle) => oracle.manual !== true).length
          return {
            ok: compiled.blocking_count === 0,
            summary: `dry-run：编译出 ${oracleList.length} 条判据（可执行 ${executable} / 人工 ${oracleList.length - executable}），未落盘`,
            run_dir: runDir,
            hash: '',
            budget,
            oracles: oracleList,
            issues: compiled.issues,
            source,
            dry_run: true,
            next_step:
              '复核上面的命令是否真的能跑：路径存在、退出码符合预期、不含 shell 元字符。'
              + '确认后把这些 oracles 原样传给 oracle_gate_freeze（不带 dry_run）正式冻结，冻结后不可改。',
            error: '',
          }
        }

        const frozen = await freezeOracles(runDir, {
          root,
          run_id: runId,
          budget,
          oracles: oracleList,
        })

        if (!frozen.ok) {
          const reason =
            frozen.error === 'already-frozen'
              ? `run_id「${runId}」的判据已经冻结过（${frozen.frozen_at}），不能覆盖。要改判据请换一个新的 run_id。`
              : frozen.error === 'invalid-oracle'
                ? `判据校验失败：${frozen.detail?.error}${frozen.detail?.id ? `（${frozen.detail.id}）` : ''}${frozen.detail?.hint ? ` —— ${frozen.detail.hint}` : ''}`
                : `冻结失败：${frozen.error}`
          return { ...invalid(reason, JSON.stringify(frozen)), run_dir: runDir, issues: compiled.issues, source }
        }

        const doc = frozen.doc
        const executable = doc.oracles.filter((oracle) => !oracle.manual).length
        const manual = doc.oracles.length - executable
        return {
          ok: true,
          summary: `已冻结 ${doc.oracles.length} 条判据（可执行 ${executable} / 人工 ${manual}），hash ${doc.hash.slice(0, 20)}…`,
          run_dir: runDir,
          hash: doc.hash,
          budget,
          oracles: doc.oracles,
          issues: compiled.issues,
          source,
          dry_run: false,
          next_step:
            `逐条调用 oracle_gate_exec（root 同上，run_id="${runId}"，oracle_id 取自上面清单）执行可执行判据；`
            + `${manual > 0 ? '人工判据（L2/L3）由评审产出结构化结论后，用 oracle_gate_gate 的 reviews 传入；' : ''}`
            + '全部跑完后调用 oracle_gate_gate 得到 verdict。注意账本预留即消耗，失败不退款。',
          error: '',
        }
      },
    }),
  )
}
