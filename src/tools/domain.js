/**
 * `oracle_gate_domain`：列出与查看领域包。
 *
 * 领域包回答的是「这个领域通常该验哪些维度」。它不进内核，只影响 design 阶段：
 * P1 拿它当验收维度清单，P2 拿它的视角做发散，P3 拿它的角色做评审。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compactDomain, listDomains, loadDomain } from '../adapters/index.js'

const OUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    action: { type: 'string' },
    domains: { type: 'array', items: { type: 'object', additionalProperties: true } },
    domain: { type: 'object', additionalProperties: true },
    markdown: { type: 'string' },
    next_step: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
}

export function registerDomainTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'oracle_gate_domain',
      title: '领域包（oracle_gate_domain）',
      description:
        '只在冻结之前想不好该验哪些维度时用它（它给的是「这类需求通常该验什么」的模板，不是必须步骤）。'
        + '列出或查看领域包。领域包提供该领域的验收维度模板、发散视角、评审角色与失败归因提示；把它传给 oracle_gate_design 的 domain 参数即可注入到 P1–P3。领域包不影响 oracle_gate_freeze / oracle_gate_exec / oracle_gate_gate —— 内核保持领域无关。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'list 列出全部领域包；show 查看某一个的完整定义。',
        },
        name: { type: 'string', description: 'show 时必填，领域目录名（如 backend）。' },
      },
      output: {
        schema: OUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? [
              `## ${value.summary}`,
              value.domains === undefined || value.domains.length === 0
                ? ''
                : ['', ...value.domains.map((item) => item.ok
                  ? `- **${item.name}**（${item.title}）— 视角 ${item.perspectives} / 评审 ${item.reviewers} / 判据模板 ${item.oracles_template}`
                  : `- ${item.name} — 加载失败：${item.error}`)].join('\n'),
              value.markdown === undefined || value.markdown === '' ? '' : ['', value.markdown].join('\n'),
              '',
              value.next_step,
            ].filter((line) => line !== '').join('\n')
            : `oracle_gate_domain 失败：${value.summary || value.error}`,
        }],
      },
      async execute(args) {
        const action = typeof args.action === 'string' ? args.action : ''
        if (action !== 'list' && action !== 'show') {
          return { ok: false, summary: 'action 只能是 list 或 show', action, error: 'invalid-action' }
        }

        if (action === 'list') {
          const domains = await listDomains()
          const usable = domains.filter((item) => item.ok).length
          return {
            ok: true,
            action,
            summary: `共 ${domains.length} 个领域包（可用 ${usable} 个）`,
            domains,
            next_step: usable === 0
              ? '还没有可用的领域包。可以在 src/adapters/<name>/domain.json 里新增一个，格式参考 src/adapters/backend/domain.json。'
              : '用 show 查看某一个的完整定义，或直接把名字传给 oracle_gate_design 的 domain 参数。',
          }
        }

        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (name === '') {
          return { ok: false, summary: 'show 需要提供 name', action, error: 'missing-name' }
        }
        const loaded = await loadDomain(name)
        if (!loaded.ok) {
          const detail = loaded.issues === undefined
            ? loaded.error
            : `${loaded.error}：${loaded.issues.map((issue) => `${issue.field} ${issue.message}`).join('；')}`
          return {
            ok: false,
            action,
            summary: `领域包 ${name} 不可用`,
            error: detail,
            next_step: '修好 domain.json 后重试。校验规则见 src/adapters/index.js 的 validateDomain。',
          }
        }
        return {
          ok: true,
          action,
          summary: `${loaded.domain.name}｜${loaded.domain.title}`,
          domain: loaded.domain,
          markdown: compactDomain(loaded.domain),
          next_step: `把这个领域包传给 oracle_gate_design：domain="${loaded.domain.name}"。它不会改变 oracle_gate_freeze / oracle_gate_exec / oracle_gate_gate 的行为。`,
        }
      },
    }),
  )
}
