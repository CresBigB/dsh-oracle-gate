/**
 * dsh-oracle-gate — 期 1 通路已验证，期 2 起逐步接入真实协议。
 *
 * 已注册：
 *   - kit_ping       通路自检
 *   - kit_inventory  P0 资产盘点（只读或显式落盘）
 *   - kit_design     P1–P4 协议编译器（返回脚本 + args，交给调用方执行）
 *   - kit_run        直接执行 P1–P4 协议（脚本不出插件，省掉上下文搬运）
 *
 * 后续期次在 src/protocols/ 下逐步落地 v4 执行协议与领域包。
 *
 * 插件运行在宿主进程内，拥有完整 Node 权限、没有沙箱；任何写文件逻辑必须
 * 自带路径围栏，且只允许写在目标根目录的 `.protocol-kit/` 下。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerInventoryTool } from './tools/inventory.js'
import { registerDesignTool } from './tools/design.js'
import { registerRunTool } from './tools/run.js'
import { registerFreezeTool } from './tools/freeze.js'
import { registerExecTool } from './tools/exec.js'
import { registerGateTool } from './tools/gate.js'
import { registerFailuresTool } from './tools/failures.js'
import { registerDomainTool } from './tools/domain.js'
import { registerNumericTool } from './tools/numeric.js'
import { registerStatusTool } from './tools/status.js'

export const name = 'oracle-gate'

/**
 * 依赖的工具注册表与 workflow 引擎。
 *
 * inject 只声明 tools。
 *
 * 期 3.6 的 kit_run 需要 workflowEngine，但**不能**把它写进 inject：宿主里
 * workflowEngine 由 @deepseek-ai/dsh-workflow-ptc 提供，profile bundle 的加载
 * 作用域等不到这个服务，声明后会直接 `pending (waiting for service:
 * workflowEngine)`，把整个插件——包括本来好好的 kit_ping / kit_inventory /
 * kit_design——一起拖死（2026-11-01 实测）。
 * 改为在 kit_run 里用 ctx.get('workflowEngine') 惰性获取，拿不到就返回明确
 * 错误，保证其余工具始终可用。
 */
export const inject = ['tools']

const VERSION = '0.0.1'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ stateDir?: string }} config 来自 cordis.patch.yml 的 config 段
 */
export function apply(ctx, config) {
  const stateDir = config?.stateDir ?? '.protocol-kit'

  /**
   * 诊断用：列出当前 ctx 能看到哪些服务、以及 root store 里到底注册了什么。
   * 只在 kit_ping 里调用，没有副作用。
   */
  const probeServices = () => {
    const interesting = [
      'tools', 'subagents', 'workflowEngine', 'ptcRuntime', 'sandboxPolicy',
      'workingDirectory', 'llm', 'jobs', 'loader', 'profileContext', 'systemPrompt', 'agents',
    ]
    const visible = {}
    for (const key of interesting) {
      try {
        const value = ctx.get(key)
        visible[key] = value === undefined ? 'undefined' : typeof value
      } catch (error) {
        visible[key] = `error: ${error.message}`
      }
    }
    const store = ctx.reflect?.store
    // store 的键是 Symbol，Object.values() 读不到，必须用 Reflect.ownKeys。
    const provided = store === undefined || store === null
      ? []
      : Reflect.ownKeys(store).map((key) => store[key]?.name).filter((item) => typeof item === 'string')
    const isolateTable = Object.getOwnPropertySymbols(ctx)
      .filter((symbol) => String(symbol.description ?? '').includes('isolate'))
      .map((symbol) => ctx[symbol])
      .find((table) => table !== undefined && table !== null)
    return {
      visible,
      root_is_self: ctx.root === ctx,
      fiber_name: ctx.fiber?.name ?? 'unknown',
      fiber_state: ctx.fiber?.state,
      isolate_names: isolateTable === undefined ? '(看不到 isolate 表)' : Object.keys(isolateTable).sort().join(','),
      store_size: provided.length,
      store_has_workflow_engine: provided.includes('workflowEngine'),
      store_names: provided.slice().sort().join(','),
    }
  }

  const skipped = []

  /**
   * 逐个注册工具组，单个失败不影响其余。
   * 注意：漏写 defineTool(...) 这类错误在注册期不会抛（parameters 被原样透传），
   * 要等宿主把工具列表发给模型时才在对面报错 —— 那种只能靠 tests/validate-tools.mjs
   * 在开发期拦住。这里兜的是注册期直接抛异常的情况（例如 defineTool 的 schema 校验失败）。
   */
  const safe = (label, register) => {
    try {
      register(ctx)
    } catch (error) {
      skipped.push(label)
      try {
        ctx.logger?.warn?.(`oracle-gate: 跳过 ${label}（${error.message}）`)
      } catch {
        // 记日志本身出错也必须吞掉，否则一次注册失败会升级成插件整体失败
      }
    }
  }

  safe('kit_ping', () => ctx.tools.register(defineTool({
    name: 'kit_ping',
    description: 'Protocol-kit 通路自检。返回插件版本、挂载配置与最小运行期事实，用于验证插件是否被宿主正确加载。没有副作用，不读写任何文件。',
    parameters: {
      echo: {
        type: 'string',
        description: '可选回显文本，用于确认参数能从模型透传到插件执行层。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          plugin: { type: 'string', required: true },
          version: { type: 'string', required: true },
          state_dir: { type: 'string', required: true },
          node_version: { type: 'string', required: true },
          echo: { type: 'string' },
          services: { type: 'json' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `kit_ping ok=${value.ok}`,
          `plugin=${value.plugin}@${value.version}`,
          `state_dir=${value.state_dir}`,
          `node=${value.node_version}`,
          ...(value.services === undefined
            ? []
            : [
              `workflowEngine=${value.services.visible?.workflowEngine}`,
              `store=${value.services.store_size}${value.services.store_has_workflow_engine ? '(含 workflowEngine)' : '(无 workflowEngine)'}`,
            ]),
          ...(value.echo === undefined ? [] : [`echo=${value.echo}`]),
        ].join(' · '),
      }],
    },
    async execute(args) {
      return {
        ok: true,
        plugin: name,
        version: VERSION,
        state_dir: stateDir,
        node_version: process.version,
        services: probeServices(),
        ...(args.echo === undefined ? {} : { echo: args.echo }),
      }
    },
  })))

  // 期 2：P0 资产盘点
  safe('kit_inventory', registerInventoryTool)

  // 期 3：P1–P4 设计决策协议（盘点 + 编译成 workflow 脚本）
  safe('kit_design', registerDesignTool)

  // 期 3.6：直接执行，脚本不必经上下文搬运
  safe('kit_run', registerRunTool)

  // 期 4a：执行内核（冻结判据 → 按 id 执行 → 准入裁决 → 失败归因）
  safe('kit_freeze', registerFreezeTool)
  safe('kit_exec', registerExecTool)
  safe('kit_gate', registerGateTool)
  safe('kit_failures', registerFailuresTool)

  // 期 4b：领域包（给 design 阶段的验收维度 / 发散视角 / 评审角色）
  safe('kit_domain', registerDomainTool)

  // 期 4c：数值内核（比两条曲线，给出可复算的误差指标）
  safe('kit_numeric', registerNumericTool)
  safe('kit_status', registerStatusTool)

  if (skipped.length > 0) {
    try {
      ctx.logger?.warn?.(`oracle-gate: ${skipped.length} 个工具注册失败被跳过：${skipped.join(', ')}`)
    } catch {
      // 同上，日志失败不改结果
    }
  }
}
