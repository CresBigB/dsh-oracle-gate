/**
 * P1–P4 设计决策协议的入口。
 *
 * 为什么是「生成脚本」而不是「在插件里直接驱动子代理」：
 * workflow 引擎已经提供并行屏障、失败隔离、结构化 schema 校验与生命周期管理，
 * 插件里重写一遍只会得到更少的保证。插件的职责是把协议固化成确定性文本，
 * 执行交给引擎 —— 这也让协议本身可审阅、可版本化、可移植到别的宿主。
 *
 * 脚本正文放在同目录的 `design-workflow.txt`：它是完整的、可被 `new Function`
 * 解析的 JS 源码，而不是拼接出来的字符串。这样做的好处是脚本能被独立的语法
 * 检查覆盖，也不会陷入「模板字符串里再套模板字符串」的转义泥潭。
 */

import { readFileSync, statSync } from 'node:fs'

const SCRIPT_URL = new URL('./design-workflow.txt', import.meta.url)

/** 缓存脚本正文：只要文件本身没变就不必重复读盘；变了则自动重读，改协议文本无需重启宿主。 */
let cachedScript
let cachedMtimeMs = -1

function loadScript() {
  const { mtimeMs } = statSync(SCRIPT_URL)
  if (cachedScript === undefined || mtimeMs !== cachedMtimeMs) {
    cachedScript = readFileSync(SCRIPT_URL, 'utf8')
    cachedMtimeMs = mtimeMs
  }
  return cachedScript
}

/**
 * 返回 P1–P4 的 workflow 脚本文本。
 *
 * 同一份脚本文本同时服务 clarify 与 design 两个阶段：脚本读 `args.stage` 自行分流。
 * 之所以不拆成两个文件，是因为澄清阶段与设计阶段共用 schema、路径索引和
 * 准入纪律；拆开会让两边慢慢长歪，而它们必须始终对同一套判据负责。
 *
 * @returns {string} 可直接作为 dsh `workflow` 工具 script 参数执行的 JavaScript。
 */
export function buildDesignScript() {
  return loadScript()
}

/**
 * 返回澄清阶段（P0 盘点 + P1 术语落地）的脚本文本。
 *
 * 与 buildDesignScript() 返回同一份文本，分开导出只是为了在调用处表达意图：
 * 调用方传 `args.stage = 'clarify'` 时，脚本会在 P1 结束后返回 questions 与 draft_spec。
 *
 * @returns {string}
 */
export function buildClarifyScript() {
  return loadScript()
}

/** 同一目录下最多展开多少条资产；超出的折叠成一行说明，避免同类文件刷屏。 */
const PER_DIR_ASSET_LIMIT = 6
/** 折叠说明最多列多少组目录。 */
const MAX_FOLDED_GROUPS = 6

function dirnameOf(relPath) {
  const index = relPath.lastIndexOf('/')
  return index === -1 ? '.' : relPath.slice(0, index)
}

/**
 * 按目录折叠资产。
 *
 * 动机：某项目 里 某一级目录下就有
 * 二十多个 `*CatalogTable.vue`，名字只差前缀，全列出来会把真正相关的几条挤到视线外。
 *
 * @param {Array} assets 已按 relevance 排序的资产
 * @param {number} maxTotal 最多展开多少条
 */
function foldAssetsByDirectory(assets, maxTotal) {
  const perDir = new Map()
  const kept = []
  const folded = new Map()

  const noteFolded = (asset) => {
    const dir = dirnameOf(asset.path)
    const entry = folded.get(dir) ?? { count: 0, names: [] }
    entry.count += 1
    if (entry.names.length < 3) entry.names.push(asset.name)
    folded.set(dir, entry)
  }

  for (const asset of assets) {
    const dir = dirnameOf(asset.path)
    const usedInDir = perDir.get(dir) ?? 0
    if (kept.length < maxTotal && usedInDir < PER_DIR_ASSET_LIMIT) {
      perDir.set(dir, usedInDir + 1)
      kept.push(asset)
      continue
    }
    noteFolded(asset)
  }

  return {
    kept,
    folded: [...folded.entries()].map(([dir, entry]) => ({ dir, ...entry })),
  }
}

/**
 * 把 P0 盘点结果压成适合塞进 workflow args 的紧凑文本。
 *
 * workflow 脚本运行在沙箱里、没有文件系统访问，所以清单只能经由 args 传入。
 * 这里必须控制长度：传太少 agent 无从复用，传太多会撑爆参数并且淹没重点。
 *
 * @param {object} result kit_inventory 的 inventory() 结果
 * @param {{maxAssets?: number, maxConventions?: number, maxSimilar?: number}} limits
 * @returns {string}
 */
export function compactInventory(result, limits = {}) {
  const maxAssets = limits.maxAssets ?? 30
  const maxConventions = limits.maxConventions ?? 15
  const maxSimilar = limits.maxSimilar ?? 20
  const lines = []

  lines.push(`根目录：${result.root}`)
  if (result.focus) lines.push(`盘点关注点：${result.focus}`)

  if (result.assets.length > 0) {
    lines.push('')
    lines.push('可复用资产（路径:行号 — 类型 — 名称）：')
    const { kept, folded } = foldAssetsByDirectory(result.assets, maxAssets)
    for (const asset of kept) {
      lines.push(`- ${asset.path}:${asset.line} — ${asset.kind} — ${asset.name}`)
    }
    for (const group of folded.slice(0, MAX_FOLDED_GROUPS)) {
      lines.push(
        `- ${group.dir}/ 下另有 ${group.count} 条同类（如 ${group.names.join('、')}），未逐条展开`,
      )
    }
    if (folded.length > MAX_FOLDED_GROUPS) {
      lines.push(`- …另有 ${folded.length - MAX_FOLDED_GROUPS} 个目录的资产未展开`)
    }
  }

  if (result.conventions.length > 0) {
    lines.push('')
    lines.push('既有样式约定：')
    for (const item of result.conventions.slice(0, maxConventions)) {
      lines.push(`- ${item.path}:${item.line} — ${item.name}: ${item.value}`)
    }
    if (result.conventions.length > maxConventions) {
      lines.push(`- …另有 ${result.conventions.length - maxConventions} 条`)
    }
  }

  if (result.similar.length > 0) {
    lines.push('')
    lines.push('与关注点相关的既有文件：')
    for (const item of result.similar.slice(0, maxSimilar)) {
      lines.push(`- ${item.path}（命中 ${item.hits.length} 处）`)
    }
    if (result.similar.length > maxSimilar) {
      lines.push(`- …另有 ${result.similar.length - maxSimilar} 个文件`)
    }
  }

  return lines.join('\n')
}

/** 默认展开的发散视角；调用方可以覆盖，但至少要两个才叫「发散」。 */
export const DEFAULT_PERSPECTIVES = [
  '最小改动：能复用现有实现就不新增，优先沿用项目既有模式',
  '一致性优先：优先贴合现有命名、样式约定与交互习惯，宁可多写几行',
  '性能与长期维护：优先可扩展、可测试的抽象，接受更多前期成本',
]
