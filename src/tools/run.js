/**
 * `kit_run` 工具注册。
 *
 * 与 `kit_design` 的分工：
 *   - kit_design 只「编译」：把 P0 清单和协议脚本交给调用方，适合需要审阅、
 *     存档或移植到别处的场景；
 *   - kit_run 直接「执行」：在插件内部调用 workflow 引擎跑完，只把结果返回。
 *
 * 为什么值得直接在插件里跑：协议脚本有 26 KB，如果每次都经模型上下文搬运
 * （工具返回 → 模型原样写进 workflow 的 script 参数），一趟就白烧一两万 token，
 * 而且手工复制长文本本身就容易出错。脚本始终留在磁盘上，执行时由插件读取。
 *
 * 超时风险：一次 clarify 只有 1 个 agent，通常 1–3 分钟；design 阶段会起
 * 7–10 个 agent，可能十几分钟。工具会跟随调用方的 abort 信号取消 run，
 * 所以被中断时不会留下孤儿运行。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve, join } from 'node:path'
import { stat, mkdir, writeFile } from 'node:fs/promises'
import { inventory } from '../protocols/assets.js'
import {
  buildClarifyScript,
  buildDesignScript,
  compactInventory,
} from '../protocols/design.js'
import { normalizeSpec, resolveDomainAndPerspectives } from './design.js'

/** 脚本正文上限，与 kit_design 保持一致。 */
const MAX_SCRIPT_CHARS = 80000
/** 结果里允许回传给模型的字符数：超出的部分提示落盘查看。 */
const MAX_INLINE_RESULT = 24000

const META_BY_STAGE = {
  clarify: { name: 'design-clarify', description: 'P0 盘点 + P1 术语落地，产出决策题与草稿 spec' },
  design: { name: 'design-build', description: 'P2 发散 → P3 对抗评审 → P4 三态裁决' },
  all: { name: 'design-decision', description: 'P1 → P4 一次跑完（不带假设）' },
}

/**
 * 找到 workflow 引擎。
 *
 * `ctx.get(name)` 不是按名字找对象，而是先拿 `ctx[isolate][name]` 算出一个
 * Symbol，再拿它去共享 store 里取。如果本作用域从没有人用这个名字
 * provide 过，连查找都发生不了，直接 undefined —— 这正是之前三条通路
 * 全返回 undefined 的原因：workflow-ptc 在另一个 isolate 下注册，
 * 我们这条 ctx 链上看不到它的 Symbol 键。
 *
 * 所以最后一招是绕开 isolate 语义：直接遍历 root store，按服务的注册名
 * 找实例。只读取，不改注册，也不影响其它插件。
 */
function resolveWorkflowEngine(ctx) {
  for (const get of [
    () => ctx.get?.('workflowEngine'),
    () => ctx.root?.get?.('workflowEngine'),
    () => ctx.reflect?.get?.('workflowEngine'),
  ]) {
    try {
      const engine = get()
      if (engine !== undefined && engine !== null) return engine
    } catch {
      // 作用域不对时会抛，继续试下一条
    }
  }

  const store = ctx.reflect?.store ?? ctx.root?.reflect?.store
  if (store === undefined || store === null) return undefined
  // store 的键是 Symbol，Object.values() 读不到，必须用 Reflect.ownKeys。
  for (const key of Reflect.ownKeys(store)) {
    const impl = store[key]
    if (impl?.name === 'workflowEngine') return impl.value
  }
  return undefined
}

export function registerRunTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'kit_run',
    title: '执行 P1–P4 协议',
    description:
      '直接执行设计决策协议，不用手工搬运脚本。'
      + 'stage="clarify"（默认）：跑 P0 盘点 + P1 术语落地，返回 questions[]（最多 3 道带选项和推荐值的决策题）与 draft_spec。'
      + '拿到后先问用户，再用 stage="design" 带上 spec 出方案。'
      + 'stage="design" 需要 spec；stage="all" 是旧的一次跑完模式，需求必须有歧义才会被挡下。',
    parameters: {
      root: {
        type: 'string',
        required: true,
        description: '项目根目录绝对路径。',
      },
      requirement: {
        type: 'string',
        required: true,
        description: '用户的原始需求，可以是模糊的自然语言。',
      },
      focus: {
        type: 'string',
        description: '资产盘点的关注点；留空则用 requirement 原文。',
      },
      stage: {
        type: 'string',
        description: 'clarify（默认）| design | all。',
      },
      perspectives: {
        type: 'array',
        items: { type: 'string' },
        description: '发散视角，至少 2 个；留空用领域包的三条，领域包也没有才用默认三视角。',
      },
      domain: {
        type: 'string',
        description: '领域包名（如 backend、numeric），用 kit_domain list 查看可用项。给了就注入该领域的发散视角与验收维度模板。',
      },
      spec: {
        type: 'json',
        description: 'stage=design 时必填：clarify 返回的 draft_spec 加上用户选择后的 assumptions。',
      },
      save: {
        type: 'boolean',
        description: '为 true 时把本次请求与结果写到 <root>/.protocol-kit/<时间戳>/run-<stage>/。默认 false。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          stage: { type: 'string', required: true },
          mode: { type: 'string' },
          run_id: { type: 'string' },
          agents_started: { type: 'number' },
          result: { type: 'json' },
          out_dir: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `kit_run 失败：${value.error}` }]
        const rendered = JSON.stringify(value.result, null, 2) ?? 'null'
        const text = rendered.length > MAX_INLINE_RESULT
          ? `${rendered.slice(0, MAX_INLINE_RESULT)}\n… [结果过长，已截断，共 ${rendered.length} 字符]`
          : rendered
        return [{
          type: 'text',
          text: [`## ${value.summary}`, '', '```json', text, '```', ...(value.out_dir === undefined ? [] : ['', `已存档：${value.out_dir}`])].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const parent = exec?.agent
      if (parent === undefined) {
        return { ok: false, summary: '', stage: '', error: 'kit_run 需要一个发起调用的 agent（exec.agent 为空）' }
      }

      const invalid = (error, summary, stage = '') => ({ ok: false, summary, stage, error })

      if (typeof args.root !== 'string' || args.root.trim() === '') {
        return invalid('root is required', 'root 不能为空')
      }
      if (!isAbsolute(args.root)) return invalid('root must be absolute', 'root 必须是绝对路径')
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
            'stage=design 需要传入 clarify 产出的 spec（至少含 goal 与一条 acceptance）',
            stage,
          )
        }
        spec = normalizeSpec(provided)
      }

      // 领域包与视角的解析和 kit_design 走同一条路径，避免两个入口给出不同的 prompt。
      const resolved = await resolveDomainAndPerspectives({
        domain: args.domain,
        perspectives: args.perspectives,
      })
      if (!resolved.ok) {
        return invalid(`domain unavailable: ${resolved.error}`, `领域包 ${args.domain} 不可用，先用 kit_domain list 确认名字`, stage)
      }
      const perspectives = resolved.perspectives
      const domainText = resolved.domainText
      const requirement = args.requirement.trim()
      const focus = typeof args.focus === 'string' && args.focus.trim() !== '' ? args.focus.trim() : requirement

      let inv
      try {
        inv = await inventory({ root, focus })
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error), 'P0 资产盘点失败', stage)
      }
      const inventoryText = compactInventory(inv)

      const script = stage === 'clarify' ? buildClarifyScript() : buildDesignScript()
      if (script.length > MAX_SCRIPT_CHARS) {
        return invalid(`script too long: ${script.length}`, '协议脚本超出上限', stage)
      }

      const scriptArgs =
        spec === undefined
          ? { requirement, inventory: inventoryText, root, perspectives, stage, domain: domainText }
          : { requirement, inventory: inventoryText, root, perspectives, stage, spec, domain: domainText }

      const meta = META_BY_STAGE[stage]

      // 惰性获取：不能靠 inject 声明，否则插件会在宿主启动期卡在 pending。
      // 三条通路都试 —— profile bundle 的作用域与 dsh-base 不同，服务未必挂在当前
      // ctx 上（2026-11-01 实测 ctx.get('workflowEngine') 返回 undefined）。
      const engine = resolveWorkflowEngine(ctx)
      if (engine === undefined || engine === null) {
        return {
          ok: true,
          summary: `workflowEngine 不可用，已降级为手动模式（${stage}）：返回脚本与 args，交给 workflow 工具执行`,
          stage,
          mode: 'manual',
          result: {
            next_step:
              '调用 workflow 工具执行下面的 script，args 原样传入，meta 用 {"name":"design-'
              + stage
              + '"}。手动模式与 kit_run 自动模式跑的是同一份脚本。',
            script,
            args: scriptArgs,
          },
        }
      }

      let run
      try {
        run = engine.start({
          script,
          meta,
          args: scriptArgs,
          parent,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
      } catch (error) {
        return invalid(
          error instanceof Error ? error.message : String(error),
          '启动 workflow 引擎失败（宿主是否加载了 @deepseek-ai/dsh-workflow？）',
          stage,
        )
      }

      const onAbort = () => run.cancel('parent step aborted')
      exec.signal?.addEventListener('abort', onAbort, { once: true })

      let result
      let value
      try {
        result = await run.result
        value = result?.value
        if (value === undefined || value === null) {
          return invalid(
            `workflow settled without a return value (stopReason=${String(result?.stopReason)})`,
            '协议没有返回结果',
            stage,
          )
        }
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error), '协议执行失败', stage)
      } finally {
        exec.signal?.removeEventListener('abort', onAbort)
        try {
          await run.dispose()
        } catch (error) {
          ctx.logger?.warn?.(`kit_run: dispose 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // ---- 可选存档：只允许写在 root 下 ----
      let outDir
      if (args.save === true) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const dir = join(root, '.protocol-kit', stamp, `run-${stage}`)
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'request.json'), JSON.stringify(scriptArgs, null, 2), 'utf8')
          await writeFile(join(dir, 'workflow.js'), script, 'utf8')
          await writeFile(join(dir, 'result.json'), JSON.stringify(value, null, 2), 'utf8')
          outDir = dir
        } catch (error) {
          outDir = undefined
          ctx.logger?.warn?.(`kit_run: 存档失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const summaryByStage = {
        clarify: `澄清阶段完成：${String(value.questions?.length ?? 0)} 道决策题 · ${String(value.terms?.length ?? 0)} 个术语已落地 · 共 ${String(result.agentsStarted ?? 0)} 个 agent`,
        design: `设计阶段完成：裁决 ${String(value.verdict ?? 'unknown')} · 准入 ${String(value.gate?.designs_admitted ?? 0)}/${String(value.gate?.designs_produced ?? 0)} 个方案 · 共 ${String(result.agentsStarted ?? 0)} 个 agent`,
        all: `完整协议完成：裁决 ${String(value.verdict ?? 'unknown')} · 准入 ${String(value.gate?.designs_admitted ?? 0)}/${String(value.gate?.designs_produced ?? 0)} 个方案 · 共 ${String(result.agentsStarted ?? 0)} 个 agent`,
      }

      return {
        ok: true,
        summary: summaryByStage[stage],
        stage,
        run_id: run.id,
        agents_started: result.agentsStarted ?? 0,
        result: value,
        ...(outDir === undefined ? {} : { out_dir: outDir }),
      }
    },
  }))
}
