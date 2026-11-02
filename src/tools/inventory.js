/**
 * `kit_inventory` 工具注册。
 *
 * P0 资产盘点的对外入口。刻意做成「只读 + 可选落盘」：
 * 扫描一个项目不应该产生任何副作用，落盘必须显式要求，且只能落在
 * root 自己的 `.protocol-kit/` 下 —— 这是插件唯一的写路径，围栏必须在这里做死。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { inventory, renderInventoryMarkdown } from '../protocols/assets.js'
import { isAbsolute, resolve, join } from 'node:path'
import { stat, mkdir, writeFile } from 'node:fs/promises'

/** 返回给模型的 Markdown 上限，超出即截断并提示落盘。 */
const MAX_INLINE_CHARS = 6000

export function registerInventoryTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'kit_inventory',
    description:
      '扫描一个项目根目录，产出「已有资产」的证据清单：可复用组件/函数/类的定义点、既有样式约定（CSS 变量/design token）、以及与关注点相关的既有文件。**默认按目录汇总**（结构视图，每个目录一行，带条数与类型直方图）；需要逐条 `路径:行号` 硬证据时传 `expand: "all"`。用于在动手前确认项目里已经存在什么，避免重复实现或风格割裂。只读，除非显式 save=true。',
    parameters: {
      root: {
        type: 'string',
        required: true,
        description: '要扫描的项目根目录绝对路径，例如 E:\\Vibe Codeing Project\\SomeProject。',
      },
      focus: {
        type: 'string',
        description: '关注点，用自然语言描述，例如「按钮组件」「弹窗和配色」「图表相关的实现」。留空则只做全量资产与约定提取。',
      },
      max_files: {
        type: 'number',
        description: '扫描文件数上限，默认 20000。大项目可调低以加速。',
      },
      save: {
        type: 'boolean',
        description: '为 true 时把完整 Markdown 写到 <root>/.protocol-kit/<时间戳>/inventory.md。默认 false，不写任何文件。',
      },
      expand: {
        type: 'string',
        description: "输出粒度，默认 'none'：按目录给出汇总行（每行带条数与类型直方图），只看结构、足够短。传 'all' 时逐条列出每条资产的 `路径:行号` 硬证据（长，可能被截断），想引用具体位置时用这个。",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          markdown: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assets: { type: 'number', required: true },
              conventions: { type: 'number', required: true },
              similar: { type: 'number', required: true },
              files_read: { type: 'number', required: true },
            },
          },
          out_path: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.markdown : `kit_inventory 失败：${value.error}`,
      }],
    },
    async execute(args) {
      // ---- 路径围栏 ----
      if (typeof args.root !== 'string' || args.root.trim() === '') {
        return { ok: false, summary: 'root 不能为空', markdown: '', truncated: false, counts: { assets: 0, conventions: 0, similar: 0, files_read: 0 }, error: 'root is required' }
      }
      if (!isAbsolute(args.root)) {
        return { ok: false, summary: 'root 必须是绝对路径', markdown: '', truncated: false, counts: { assets: 0, conventions: 0, similar: 0, files_read: 0 }, error: 'root must be absolute' }
      }

      const root = resolve(args.root)
      let rootStat
      try {
        rootStat = await stat(root)
      } catch {
        return { ok: false, summary: `目录不存在：${root}`, markdown: '', truncated: false, counts: { assets: 0, conventions: 0, similar: 0, files_read: 0 }, error: 'root not found' }
      }
      if (!rootStat.isDirectory()) {
        return { ok: false, summary: `不是目录：${root}`, markdown: '', truncated: false, counts: { assets: 0, conventions: 0, similar: 0, files_read: 0 }, error: 'root is not a directory' }
      }

      let result
      try {
        result = await inventory({
          root,
          focus: typeof args.focus === 'string' ? args.focus : '',
          maxFiles: typeof args.max_files === 'number' && args.max_files > 0 ? Math.floor(args.max_files) : undefined,
        })
      } catch (error) {
        return {
          ok: false,
          summary: `扫描失败：${error instanceof Error ? error.message : String(error)}`,
          markdown: '',
          truncated: false,
          counts: { assets: 0, conventions: 0, similar: 0, files_read: 0 },
          error: error instanceof Error ? error.message : String(error),
        }
      }

      const expand = args.expand === 'all' ? 'all' : 'none'
      const markdown = renderInventoryMarkdown(result, { expand })
      const counts = {
        assets: result.stats.assets,
        conventions: result.stats.conventions,
        similar: result.stats.similar,
        files_read: result.stats.filesRead,
      }

      // ---- 可选落盘：唯一写路径，只允许写在 root 下 ----
      let outPath
      if (args.save === true) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const dir = join(root, '.protocol-kit', stamp)
        try {
          await mkdir(dir, { recursive: true })
          outPath = join(dir, 'inventory.md')
          await writeFile(outPath, markdown, 'utf8')
        } catch (error) {
          outPath = undefined
          result.notes.push(`落盘失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const truncated = markdown.length > MAX_INLINE_CHARS
      const summary = `扫描 ${counts.files_read} 个文件：资产 ${counts.assets} 条、约定 ${counts.conventions} 条、相关文件 ${counts.similar} 个${expand === 'all' ? '（逐条视图）' : '（结构视图）'}`

      return {
        ok: true,
        summary,
        markdown: truncated
          ? `${markdown.slice(0, MAX_INLINE_CHARS)}\n\n…（完整内容 ${markdown.length} 字符，已截断。${outPath ? `完整版：${outPath}` : '可加 save=true 落盘查看完整版'}）`
          : markdown,
        truncated,
        counts,
        ...(outPath === undefined ? {} : { out_path: outPath }),
      }
    },
  }))
}
