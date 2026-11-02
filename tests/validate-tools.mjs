// 本地校验：把所有 kit_* 工具注册一遍，确认 defineTool 阶段的 schema 校验不抛异常。
// 依赖 node_modules/@deepseek-ai 的 junction 指向宿主包目录（仅开发期使用，勿提交）。
// 用法：node tests/validate-tools.mjs

const captured = []

const ctx = {
  tools: {
    register(tool) {
      captured.push(tool)
      return tool
    },
  },
  get() {
    return undefined
  },
  logger: {
    warn: (message) => console.warn('[warn]', message),
  },
}

const { assertObjectJsonSchema } = await import('@deepseek-ai/dsh-tools')
const { registerInventoryTool } = await import('../src/tools/inventory.js')
const { registerDesignTool } = await import('../src/tools/design.js')
const { registerRunTool } = await import('../src/tools/run.js')
const { registerFreezeTool } = await import('../src/tools/freeze.js')
const { registerExecTool } = await import('../src/tools/exec.js')
const { registerGateTool } = await import('../src/tools/gate.js')
const { registerFailuresTool } = await import('../src/tools/failures.js')
const { registerDomainTool } = await import('../src/tools/domain.js')
const { registerNumericTool } = await import('../src/tools/numeric.js')
const { registerStatusTool } = await import('../src/tools/status.js')

registerInventoryTool(ctx)
registerDesignTool(ctx)
registerRunTool(ctx)
registerFreezeTool(ctx)
registerExecTool(ctx)
registerGateTool(ctx)
registerFailuresTool(ctx)
registerDomainTool(ctx)
registerNumericTool(ctx)
registerStatusTool(ctx)

function fakeValue(schema, only) {
  const out = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (only !== undefined && !only.includes(key)) continue
    const type = prop.type
    if (type === 'boolean') out[key] = false
    else if (type === 'integer' || type === 'number') out[key] = 0
    else if (type === 'string') out[key] = ''
    else if (type === 'array') out[key] = []
    else if (type === 'object') out[key] = {}
    else out[key] = null
  }
  return out
}

for (const tool of captured) {
  // 漏掉 defineTool 包装时，parameters 还是原始的属性映射（顶层没有 type: "object"），
  // 会被原样发给模型 API，导致整轮请求失败。2026-11-01 的 kit_numeric 就是这么炸的：
  // Invalid schema for function 'kit_numeric': schema must be a JSON Schema of 'type: "object"'
  if (tool.parameters !== undefined && tool.parameters.type !== 'object') {
    console.error(
      `工具 ${tool.name} 的 parameters 顶层不是 type:"object" —— 是不是漏了 defineTool(...) 包装？`,
    )
    process.exit(1)
  }
  assertObjectJsonSchema(tool.output.schema)
  if (typeof tool.output.render !== 'function') {
    console.error(`工具 ${tool.name} 的 output.render 不是函数`)
    process.exit(1)
  }
  for (const variant of ['full', 'failure']) {
    const value = variant === 'full'
      ? fakeValue(tool.output.schema)
      : fakeValue(tool.output.schema, ['ok', 'summary', 'error'])
    try {
      const blocks = tool.output.render({}, value)
      if (!Array.isArray(blocks) || blocks.length === 0) {
        console.error(`工具 ${tool.name} 的 render（${variant}）没有返回内容块`)
        process.exit(1)
      }
    } catch (error) {
      console.error(`工具 ${tool.name} 的 render（${variant}）抛错：${error.message}`)
      process.exit(1)
    }
  }
}

console.log(`已注册 ${captured.length} 个工具：`)
for (const tool of captured) {
  const params = tool.parameters === undefined ? '(无)' : Object.keys(tool.parameters).join(', ')
  console.log(`  - ${tool.name}  参数: ${params}`)
}

if (captured.length !== 10) {
  console.error(`期望注册 10 个工具，实际 ${captured.length}`)
  process.exit(1)
}

console.log('defineTool 校验通过')
