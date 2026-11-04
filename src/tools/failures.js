/**
 * `oracle_gate_failures`：记录与检索失败。
 *
 * 它存在的理由不是「留个日志」，而是让失败有归因：每一类失败都绑定了该回到哪一段。
 * 没有这个绑定，所有失败都会退化成「再实现一遍」，而判据定错的那些会永远修不好。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import {
  FAILURE_CLASSES,
  RETRY_TARGET,
  recordFailure,
  searchFailures,
  summarizeFailures,
} from '../kernel/failures.js'
import { runDirOf } from '../kernel/run.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    action: { type: 'string' },
    total: { type: 'integer' },
    matched: { type: 'integer' },
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    record: { type: 'object', additionalProperties: true },
    next_step: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

export function registerFailuresTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_failures',
      title: '失败归因库（oracle_gate_failures）',
      description:
        `记录或检索失败。每类失败绑定固定的回退目标，避免「所有失败都当成 bug 再实现一遍」。可选类别与回退目标：${
          Object.entries(RETRY_TARGET).map(([kind, target]) => `${kind}→${target}`).join('、')
        }。P2 出方案前应先 search 一次，避免重复踩坑。`,
      parameters: {
        root: { type: 'string', required: true, description: '项目根目录绝对路径。' },
        run_id: { type: 'string', required: true, description: '运行标识，失败记在 <root>/.protocol-kit/<run_id>/failures.jsonl。' },
        action: {
          type: 'string',
          required: true,
          description: 'record 记录一条失败；search 检索已有的失败。',
        },
        class: {
          type: 'string',
          description: `失败类别，record 时必填，取值：${FAILURE_CLASSES.join(' / ')}。search 时作为过滤条件。`,
        },
        summary: { type: 'string', description: 'record 时必填：一句话说清这次失败到底是什么。' },
        evidence: {
          type: 'json',
          description: 'record 时的证据数组，例如 ["src/a.ts:12","回执 rcpt_7_L0"]。',
        },
        query: { type: 'string', description: 'search 时的关键词，匹配 summary、类别与证据。' },
        limit: { type: 'number', description: 'search 返回条数上限，默认 10。' },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? [
            `## ${value.summary}`,
            // search 分支返回 record: {}，所以不能只判 undefined/null，
            // 否则检索成功也会打出「已记录：undefined → 回退到 undefined」。
            value.record !== undefined && value.record !== null && typeof value.record.class === 'string'
              ? `已记录：${value.record.class} → 回退到 ${value.record.retry_target}`
              : '',
            value.items === undefined || value.items.length === 0
              ? ''
              : ['', '```json', JSON.stringify(value.items, null, 2), '```'].join('\n'),
            '',
            value.next_step,
          ].filter((line) => line !== '').join('\n')
          : `oracle_gate_failures 失败：${value.summary || value.error}`,
        }],
      },
      async execute(args) {
        const bad = (summary, error) => ({
          ok: false,
          summary,
          action: typeof args.action === 'string' ? args.action : '',
          total: 0,
          matched: 0,
          items: [],
          record: {},
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

        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''

        if (action === 'record') {
          const kind = typeof args.class === 'string' ? args.class.trim() : ''
          const recorded = await recordFailure(runDir, {
            class: kind,
            summary: typeof args.summary === 'string' ? args.summary : '',
            // evidence 常被写成单个字符串（如回执路径），此时应包成数组，
            // 否则会被静默丢成 []，失败记录里就再也找不到对应证据。
            evidence: Array.isArray(args.evidence)
              ? args.evidence
              : typeof args.evidence === 'string' && args.evidence.trim() !== ''
                ? [args.evidence.trim()]
                : [],
          })
          if (!recorded.ok) {
            return bad(
              recorded.error === 'unknown-class'
                ? `未知失败类别「${recorded.got}」，可用：${FAILURE_CLASSES.join(' / ')}`
                : `记录失败：${recorded.error}`,
              JSON.stringify(recorded),
            )
          }
          const record = recorded.record
          return {
            ok: true,
            summary: `已记录失败（${record.class}），回退目标：${record.retry_target}`,
            action,
            total: 0,
            matched: 0,
            items: [],
            record,
            next_step:
              record.retry_target === 'no-replay'
                ? '基础设施问题不重放：先修环境（构建链、磁盘、权限），再重新冻结判据开新 run。'
                : `按 retry_target「${record.retry_target}」回退重来，不要原地重试同一方案。`,
            error: '',
          }
        }

        if (action === 'search') {
          const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 10
          const found = await searchFailures(runDir, {
            query: typeof args.query === 'string' ? args.query : '',
            limit,
            class: typeof args.class === 'string' && args.class.trim() !== '' ? args.class.trim() : null,
          })
          const byClass = summarizeFailures(found.items)
          const distribution = Object.entries(byClass)
            .map(([kind, count]) => `${kind}×${count}`)
            .join('、')
          return {
            ok: true,
            summary:
              found.total === 0
                ? '失败库为空：这一轮没有历史失败可参考。'
                : `失败库共 ${found.total} 条，命中 ${found.matched} 条${distribution === '' ? '' : `（命中分布：${distribution}）`}`,
            action,
            total: found.total,
            matched: found.matched,
            items: found.items,
            record: {},
            next_step:
              found.matched === 0
                ? '没有同类失败记录，可以按常规推进。'
                : '出方案前逐条确认这次不会重犯同样的错；若某条失败的原因是判据本身定错，先在方案里说明并准备开新 run 重新冻结。',
            error: '',
          }
        }

        return bad(
          `action 只能是 record 或 search，收到「${action}」`,
          'bad action',
        )
      },
    }),
  )
}
