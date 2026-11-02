/**
 * `kit_design` 工具注册。
 *
 * 它做两件事：先把 P0 资产盘点跑掉，再把 P1–P4 协议编译成可直接执行的
 * workflow 脚本文本连同 args 一起交出去。
 *
 * 为什么不在工具里直接跑 workflow：workflow 工具本身支持前台/后台两种模式、
 * 进度镜像与取消，在插件里再实现一套生命周期只会多一份超时风险。协议的价值
 * 在于「确定性的脚本」，而不在于「被谁执行」。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve, join } from 'node:path'
import { stat, mkdir, writeFile } from 'node:fs/promises'
import { inventory } from '../protocols/assets.js'
import {
  buildClarifyScript,
  buildDesignScript,
  compactInventory,
  DEFAULT_PERSPECTIVES,
} from '../protocols/design.js'
import { compactDomain, loadDomain } from '../adapters/index.js'

/**
 * 返回给模型的脚本上限。
 *
 * 期 3.6 把「术语落地 + 决策题 + 三态裁决 + 假设回填」都写进了同一份脚本，
 * 正文从 12 KB 涨到 26 KB。上限相应放宽，超出说明协议本身失控了。
 */
const MAX_SCRIPT_CHARS = 80000

const EMPTY_ARGS = Object.freeze({
  requirement: '',
  inventory: '',
  root: '',
  perspectives: [],
  domain: '',
  stage: 'clarify',
})

/**
 * 把调用方传回来的 spec 收敛成脚本认识的结构。
 *
 * 为什么要白名单式重建而不是直接透传：spec 通常由 Lead 从上一阶段结果里复制、
 * 再手工拼上用户答案，夹杂多余字段是常态；原样塞进 args 会让 workflow 的
 * schema 校验在很晚的阶段才失败，报错位置离真正的问题很远。
 *
 * @param {object} raw
 */
export function normalizeSpec(raw) {
  const acceptance = (Array.isArray(raw.acceptance) ? raw.acceptance : [])
    .filter((item) => item !== null && typeof item === 'object' && typeof item.criterion === 'string')
    .map((item) => ({
      criterion: item.criterion,
      level: typeof item.level === 'string' && item.level !== '' ? item.level : 'L2',
      ...(typeof item.check === 'string' && item.check.trim() !== '' ? { check: item.check } : {}),
    }))
  const readings = (Array.isArray(raw.readings) ? raw.readings : [])
    .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      summary: typeof item.summary === 'string' ? item.summary : '',
      target_files: Array.isArray(item.target_files)
        ? item.target_files.filter((file) => typeof file === 'string')
        : [],
    }))
  const assumptions = (Array.isArray(raw.assumptions) ? raw.assumptions : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `assumption-${index + 1}`,
      text: typeof item.text === 'string' ? item.text : '',
      choice: typeof item.choice === 'string' ? item.choice : '',
      source: typeof item.source === 'string' && item.source !== '' ? item.source : 'human',
    }))
  return {
    goal: raw.goal,
    acceptance,
    constraints: (Array.isArray(raw.constraints) ? raw.constraints : []).filter(
      (item) => typeof item === 'string',
    ),
    readings,
    assumptions,
  }
}

// 领域包与视角的解析规则只此一处：kit_design 与 kit_run 都必须走同一条路径，
// 否则「从哪个入口进去」会悄悄改变 agent 看到的东西。
export async function resolveDomainAndPerspectives(input = {}) {
  const domainName = typeof input.domain === 'string' ? input.domain.trim() : ''
  let domainText = ''
  let domainPerspectives = []
  if (domainName !== '') {
    const loaded = await loadDomain(domainName)
    if (!loaded.ok) {
      const detail = loaded.issues === undefined
        ? loaded.error
        : `${loaded.error}：${loaded.issues.map((issue) => `${issue.field} ${issue.message}`).join('；')}`
      return { ok: false, domainText: '', perspectives: DEFAULT_PERSPECTIVES, error: detail }
    }
    domainText = compactDomain(loaded.domain)
    domainPerspectives = loaded.domain.perspectives.map((item) => item.instruction)
  }

  // 视角少于 2 个就谈不上「发散」：退回领域包，领域包也没有才退回默认。
  const custom = Array.isArray(input.perspectives)
    ? input.perspectives.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  const perspectives = custom.length >= 2
    ? custom
    : (domainPerspectives.length >= 2 ? domainPerspectives : DEFAULT_PERSPECTIVES)
  return { ok: true, domainText, perspectives, error: '' }
}

export function registerDesignTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'kit_design',
    title: '设计决策协议 P1–P4',
    description:
      '当用户提出模糊需求、没给技术栈和实现细节时使用：先盘点项目里已有的可复用资产（P0），再把「需求澄清 → 多视角发散 → 对抗评审 → 收敛裁决」编译成一段确定性的 workflow 脚本。返回脚本与 args，交给 workflow 工具执行。用于避免重复造轮子、风格割裂、以及只想到一种常见做法就动手。',
    parameters: {
      root: {
        type: 'string',
        required: true,
        description: '项目根目录绝对路径，例如 E:\\\\Vibe Codeing Project\\\\SomeProject。',
      },
      requirement: {
        type: 'string',
        required: true,
        description: '用户的原始需求，可以是模糊的自然语言，例如「给这个页面加个能筛选的表格」。',
      },
      focus: {
        type: 'string',
        description: '资产盘点的关注点；留空则用 requirement 原文去匹配。',
      },
      domain: {
        type: 'string',
        description:
          '领域包名（如 backend），用 kit_domain list 查看可用项。给了领域包，就用它的发散视角与验收维度模板；'
          + '显式传的 perspectives 优先于领域包。领域包不影响 kit_freeze / kit_exec / kit_gate。',
      },
      perspectives: {
        type: 'array',
        items: { type: 'string' },
        description: '自定义发散视角列表，至少 2 个。留空使用默认的三个视角（最小改动 / 一致性优先 / 性能与长期维护）。',
      },
      stage: {
        type: 'string',
        description:
          'clarify（默认）：只跑 P0 盘点 + P1 术语落地，产出待用户拍板的决策题与草稿 spec；'
          + 'design：带着已决议的 spec 跑 P2→P3→P4；'
          + 'all：一次跑完，不给 spec 时不带假设直接出方案（旧行为，不确定需求时不要用）。',
      },
      spec: {
        type: 'json',
        description:
          'stage=design 时必填：把 clarify 阶段返回的 draft_spec 复制过来，'
          + '再把用户对每道决策题的选择写进 assumptions（没选就写 recommended 作为默认假设）。',
      },
      save: {
        type: 'boolean',
        description: '为 true 时把脚本和 args 写到 <root>/.protocol-kit/<时间戳>/design-<stage>/。默认 false。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          script: { type: 'string', required: true },
          args: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requirement: { type: 'string', required: true },
              inventory: { type: 'string', required: true },
              root: { type: 'string', required: true },
              perspectives: { type: 'array', items: { type: 'string' }, required: true },
              stage: { type: 'string', required: true },
              domain: { type: 'string', required: true },
              spec: { type: 'object', additionalProperties: true },
            },
          },
          next_step: { type: 'string', required: true },
          out_dir: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `kit_design 失败：${value.error}` }]
        const blocks = [
          `## ${value.summary}`,
          '',
          value.next_step,
          '',
          '### script（原样传给 workflow 工具的 script 参数）',
          '```js',
          value.script,
          '```',
          '',
          '### args（原样传给 workflow 工具的 args 参数）',
          '```json',
          JSON.stringify(value.args, null, 2),
          '```',
        ]
        if (value.out_dir !== undefined) {
          blocks.push('', `已存档：\`${value.out_dir}\``)
        }
        return [{ type: 'text', text: blocks.join('\n') }]
      },
    },
    async execute(args) {
      const invalid = (error, summary) => ({
        ok: false,
        summary,
        script: '',
        args: { ...EMPTY_ARGS },
        next_step: '',
        error,
      })

      if (typeof args.root !== 'string' || args.root.trim() === '') {
        return invalid('root is required', 'root 不能为空')
      }
      if (!isAbsolute(args.root)) {
        return invalid('root must be absolute', 'root 必须是绝对路径')
      }
      if (typeof args.requirement !== 'string' || args.requirement.trim() === '') {
        return invalid('requirement is required', 'requirement 不能为空')
      }

      const root = resolve(args.root)
      try {
        const rootStat = await stat(root)
        if (!rootStat.isDirectory()) return invalid('root is not a directory', `不是目录：${root}`)
      } catch {
        return invalid('root not found', `目录不存在：${root}`)
      }

      // 领域包提供该领域通常该验的维度；它只影响 design 阶段，不进内核。
      const resolved = await resolveDomainAndPerspectives({
        domain: args.domain,
        perspectives: args.perspectives,
      })
      if (!resolved.ok) {
        return invalid(`domain unavailable: ${resolved.error}`, `领域包 ${args.domain} 不可用，先用 kit_domain list 确认名字`)
      }
      const domainText = resolved.domainText
      const perspectives = resolved.perspectives

      const requirement = args.requirement.trim()
      const focus = typeof args.focus === 'string' && args.focus.trim() !== '' ? args.focus.trim() : requirement

      // ---- P0：盘点 ----
      let inv
      try {
        inv = await inventory({ root, focus })
      } catch (error) {
        return invalid(
          error instanceof Error ? error.message : String(error),
          'P0 资产盘点失败',
        )
      }

      const inventoryText = compactInventory(inv)

      // stage 决定跑哪一段：clarify 只问不做；design 带着已决议的 spec 直接出方案。
      const rawStage = typeof args.stage === 'string' ? args.stage.trim().toLowerCase() : ''
      const stage = rawStage === 'design' || rawStage === 'all' ? rawStage : 'clarify'

      let spec
      if (stage === 'design') {
        const provided = args.spec
        const usable =
          provided !== null
          && typeof provided === 'object'
          && !Array.isArray(provided)
          && typeof provided.goal === 'string'
          && Array.isArray(provided.acceptance)
          && provided.acceptance.length > 0
        if (!usable) {
          return invalid(
            'spec is required when stage=design',
            'stage=design 需要传入 clarify 阶段产出的 spec（至少含 goal 与一条 acceptance）',
          )
        }
        spec = normalizeSpec(provided)
      }

      const script = stage === 'clarify' ? buildClarifyScript() : buildDesignScript()

      if (script.length > MAX_SCRIPT_CHARS) {
        return invalid(`script too long: ${script.length}`, '协议脚本超出上限')
      }

      const scriptArgs =
        spec === undefined
          ? { requirement, inventory: inventoryText, root, perspectives, stage, domain: domainText }
          : { requirement, inventory: inventoryText, root, perspectives, stage, domain: domainText, spec }

      // ---- 可选存档：唯一写路径，只允许写在 root 下 ----
      let outDir
      if (args.save === true) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const dir = join(root, '.protocol-kit', stamp, `design-${stage}`)
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'workflow.js'), script, 'utf8')
          await writeFile(
            join(dir, 'request.json'),
            JSON.stringify({ ...scriptArgs }, null, 2),
            'utf8',
          )
          outDir = dir
        } catch (error) {
          outDir = undefined
          ctx.logger?.warn?.(`kit_design: 存档失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 必须用函数而不是对象字面量：字面量的每个值都会立即求值，
      // 而 design 分支要读 spec.readings —— clarify 阶段 spec 是 undefined，会直接崩。
      const summaryFor = (currentStage) => {
        const base = `P0 盘点完成：${inv.stats.assets} 条资产 / ${inv.stats.conventions} 条约定 / ${inv.stats.similar} 个相关文件；`
        if (currentStage === 'clarify') {
          return base + `已编译澄清阶段（P0 + P1 术语落地，${perspectives.length} 个发散视角待用）`
        }
        if (currentStage === 'design') {
          const readings = Array.isArray(spec.readings) ? spec.readings.length : 0
          return base + `已编译设计阶段（P2→P3→P4，${perspectives.length} 个视角${readings > 0 ? ` × ${readings} 种解读` : ''}）`
        }
        return base + `已编译完整协议（P1→P4，${perspectives.length} 个视角；没有 spec，不带任何假设）`
      }
      const nextStepByStage = {
        clarify:
          '调用 workflow 工具执行：script 传上面的脚本，meta 建议 {"name":"design-clarify","description":"P1 术语落地"}，args 传上面的 args。'
          + '执行完会拿到 questions[]（最多 3 道决策题，每题带选项/影响/推荐值）与 draft_spec。'
          + '用 ask_user_question 一次问完；用户不答就直接采用 recommended 当默认假设。'
          + '然后把 draft_spec 与用户选择（或默认值）整理成 spec，把 stage 改成 "design" 再调一次 kit_design，args 里的 spec 一并替换。',
        design:
          '调用 workflow 工具执行：script 传上面的脚本，meta 建议 {"name":"design-build","description":"P2 P4 出方案与裁决"}，args 传上面的 args。'
          + 'P2 会按 spec.readings 分别出方案，P3 并行评审，P4 给三态裁决（admitted / blocked-on-human / rejected）。'
          + '若 verdict 是 blocked-on-human，把 next_round_questions 拿去问用户，别直接重跑。',
        all:
          '调用 workflow 工具执行：script 传上面的脚本，meta 建议 {"name":"design-decision","description":"P1 P4 一次跑完"}，args 传上面的 args。'
          + '这一档不带任何假设：需求只要有歧义就会判 blocked-on-human。需求已明确时才用。',
      }

      return {
        ok: true,
        summary: summaryFor(stage),
        script,
        args: scriptArgs,
        next_step: nextStepByStage[stage],
        ...(outDir === undefined ? {} : { out_dir: outDir }),
      }
    },
  }))
}
