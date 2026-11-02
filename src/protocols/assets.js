/**
 * P0 资产盘点协议。
 *
 * 只做一件事：把「项目里已经存在什么」变成带 `路径:行号` 的硬证据清单。
 * 不做「哪个更适合复用」的判断 —— 判断是语义任务，交给上层的 agent，
 * 本协议只负责让它有据可依、无法凭空编造。
 *
 * 三层产出：
 *   1. assets      候选可复用资产（组件/函数/类/接口的定义点）
 *   2. conventions 既有约定（CSS 变量、SCSS 变量、design token）
 *   3. similar     与 focus 相关的既有文件与其命中位置
 */

import { readTextFile, walkFiles, SOURCE_EXTS, STYLE_EXTS } from '../kernel/scan.js'

/** 常见 UI 词的中英对照。中文需求 → 英文标识符的必要桥梁，但属启发式，不保证覆盖。 */
const UI_ALIASES = {
  按钮: ['button', 'btn'],
  输入: ['input', 'textfield', 'textbox'],
  输入框: ['input', 'textfield', 'textbox'],
  下拉: ['select', 'dropdown', 'combobox'],
  弹窗: ['modal', 'dialog', 'popup', 'overlay'],
  对话框: ['modal', 'dialog'],
  提示: ['tooltip', 'toast', 'notification', 'alert', 'tip'],
  表格: ['table', 'grid', 'datagrid'],
  列表: ['list', 'table'],
  菜单: ['menu', 'nav', 'navigation'],
  标签: ['tab', 'label', 'badge', 'tag'],
  图标: ['icon', 'svg'],
  卡片: ['card', 'panel', 'tile'],
  面板: ['panel', 'pane'],
  分页: ['pagination', 'pager'],
  加载: ['loading', 'spinner', 'skeleton', 'progress'],
  上传: ['upload', 'file'],
  表单: ['form', 'field'],
  开关: ['switch', 'toggle'],
  滑块: ['slider', 'range'],
  树: ['tree'],
  折叠: ['accordion', 'collapse', 'expand'],
  面包屑: ['breadcrumb'],
  侧边栏: ['sidebar', 'drawer', 'aside'],
  导航: ['nav', 'navigation', 'menu'],
  主题: ['theme', 'palette', 'color', 'token'],
  配色: ['color', 'palette', 'theme', 'token'],
  字体: ['font', 'typography'],
  间距: ['spacing', 'gap', 'margin', 'padding'],
  圆角: ['radius', 'rounded', 'border-radius'],
  动画: ['animation', 'transition', 'motion'],
  图表: ['chart', 'graph', 'plot'],
}

/** 定义点识别规则。按顺序匹配，先命中先用；每条给出 kind 便于上层按类别过滤。 */
const DEF_RULES = [
  { kind: 'component', re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/ },
  { kind: 'component', re: /^\s*export\s+(?:default\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
  { kind: 'component', re: /^\s*export\s+(?:default\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/ },
  { kind: 'component', re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\(|async\s*\(|React\.forwardRef|forwardRef|memo\()/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-z_$][A-Za-z0-9_$]*)\s*\(/ },
  { kind: 'class', re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'type', re: /^\s*export\s+(?:type|interface)\s+([A-Z][A-Za-z0-9_]*)/ },
  // Python / Rust / Go / Java / C#
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'type', re: /^\s*(?:pub\s+)?(?:struct|enum|trait|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  { kind: 'method', re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:final\s+)?[A-Za-z_<>\[\],.\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
]

/** 约定识别规则：设计 token、主题变量。 */
const CONVENTION_RULES = [
  { kind: 'css-var', re: /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/ },
  { kind: 'scss-var', re: /^\s*(\$[a-zA-Z0-9-_]+)\s*:\s*([^;]+);/ },
  { kind: 'less-var', re: /^\s*(@[a-zA-Z0-9-_]+)\s*:\s*([^;]+);/ },
  { kind: 'tailwind-token', re: /^\s*['"]?([a-z][a-zA-Z0-9-]*)['"]?\s*:\s*['"]([^'"]+)['"]/ },
]

const MAX_ASSETS = 200
const MAX_CONVENTIONS = 300
const MAX_SIMILAR = 60
const MAX_HITS_PER_FILE = 5

// 收集阶段的上限必须远大于展示上限：否则遍历顺序会决定谁被看见，
// 真正相关的条目可能在排序之前就被截掉了（实测在 1881 文件的仓库里踩到）。
const COLLECT_ASSETS = 20000
const COLLECT_CONVENTIONS = 20000

/** 只有这些扩展名里的大写命名才按「组件」对待。 */
const JSX_EXTS = new Set(['.tsx', '.jsx', '.vue', '.svelte'])

/** 同相关度时的展示优先级：可复用组件排最前，常量排最后。 */
const KIND_ORDER = { component: 0, function: 1, class: 2, type: 3, symbol: 4, constant: 5 }

/**
 * 每种类型的展示配额。单纯「排序后取前 N」会让数量最多的一类吃满全部名额
 * （例如 128 个 .vue 组件把 type/class 全部挤出清单），反而丢失信息。
 * focus 直接命中的条目不受配额限制。
 */
const KIND_QUOTA = { component: 110, function: 40, class: 20, type: 20, symbol: 20, constant: 10 }

/**
 * 把自然语言 focus 拆成可匹配的关键词。
 * 中文需求会额外展开成英文别名（启发式，覆盖常见 UI 词）。
 */
export function tokenizeFocus(focus) {
  const text = String(focus ?? '').trim()
  const tokens = new Set()
  const aliases = new Set()

  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) {
    tokens.add(match[0].toLowerCase())
  }

  for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const word = match[0]
    tokens.add(word)
    // 中文片段可能是一个短语，逐个已知词也展开一次。
    for (const [cn, en] of Object.entries(UI_ALIASES)) {
      if (word.includes(cn)) {
        for (const alias of en) aliases.add(alias)
      }
    }
  }

  for (const word of tokens) {
    for (const [cn, en] of Object.entries(UI_ALIASES)) {
      if (word.includes(cn)) {
        for (const alias of en) aliases.add(alias)
      }
    }
  }

  return {
    tokens: [...tokens],
    aliases: [...aliases].filter((alias) => !tokens.has(alias)),
  }
}

/**
 * 把 kebab-case / snake_case 目录名转成 PascalCase 组件名。
 * `app-dialog` → `AppDialog`，`ElectronTitleBar` 保持不变。
 */
function pascalCase(name) {
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** 判断一行是否命中任一关键词（大小写不敏感）。 */
function hitIn(line, needles) {
  if (needles.length === 0) return null
  const lower = line.toLowerCase()
  for (const needle of needles) {
    if (needle === '') continue
    if (lower.includes(needle.toLowerCase())) return needle
  }
  return null
}

/**
 * 主入口：扫描一个项目根，产出资产盘点结果。
 *
 * @param {object} params
 * @param {string} params.root 绝对路径
 * @param {string} [params.focus] 关注点，如「按钮组件」「配色」「图表」
 * @param {number} [params.maxFiles]
 * @returns {Promise<object>}
 */
export async function inventory({ root, focus, maxFiles }) {
  const { tokens, aliases } = tokenizeFocus(focus)
  const needles = [...tokens, ...aliases]

  const walked = await walkFiles(root, { maxFiles })
  const { files, stats } = walked

  const assets = []
  const conventions = []
  const similar = []
  const notes = []

  let filesRead = 0
  let skippedBinary = 0
  let skippedLarge = 0

  for (const file of files) {
    if (file.kind !== 'source' && file.kind !== 'style') continue

    const { text, skipped } = await readTextFile(file.abs)
    if (skipped === 'binary') { skippedBinary += 1; continue }
    if (skipped === 'too-large') { skippedLarge += 1; continue }
    if (text === null) continue
    filesRead += 1

    const lines = text.split(/\r?\n/)
    const isJsxFile = JSX_EXTS.has(file.ext)

    // SFC 文件本身就是组件：文件名即组件名，且通常没有 `export function Xxx` 形式的
    // 定义（Vue 的 `<script setup>` 尤其如此），只看定义规则会整类漏掉。
    if (file.ext === '.vue' || file.ext === '.svelte') {
      let base = file.name.replace(/\.(vue|svelte)$/i, '')
      // index.vue 自身不含名字信息（项目里往往有几十个同名 index），
      // 按 Vue 惯例用父目录名指代：components/app-dialog/index.vue → AppDialog。
      if (/^index$/i.test(base)) {
        const segments = file.path.split('/')
        const parent = segments.length >= 2 ? segments[segments.length - 2] : ''
        const guessed = pascalCase(parent)
        if (guessed !== '') base = guessed
      }
      assets.push({
        kind: 'component',
        name: base,
        path: file.path,
        line: 1,
        evidence: `单文件组件 <${base}>`,
        relevance: scoreName(base, needles) + (hitIn(file.path, needles) !== null ? 3 : 0),
      })
    }

    // 1) 定义点提取
    if (SOURCE_EXTS.has(file.ext)) {
      for (let i = 0; i < lines.length; i += 1) {
        if (assets.length >= COLLECT_ASSETS) break
        const line = lines[i]
        if (line.length > 400) continue
        for (const rule of DEF_RULES) {
          const match = rule.re.exec(line)
          if (match === null) continue
          // 全大写标识符是常量；大写命名只有在 JSX/Vue/Svelte 文件里才可能是
          // 组件，在 .ts 里多半是实体类或工具类，应归为 symbol 而不是 component。
          const kind = /^[A-Z0-9_]+$/.test(match[1])
            ? 'constant'
            : (rule.kind === 'component' && !isJsxFile) ? 'symbol' : rule.kind
          assets.push({
            kind,
            name: match[1],
            path: file.path,
            line: i + 1,
            evidence: line.trim().slice(0, 160),
            relevance: scoreName(match[1], needles) + (hitIn(file.path, needles) !== null ? 3 : 0),
          })
          break
        }
      }
    }

    // 2) 约定提取
    if (STYLE_EXTS.has(file.ext) || file.ext === '.json') {
      for (let i = 0; i < lines.length; i += 1) {
        if (conventions.length >= COLLECT_CONVENTIONS) break
        const line = lines[i]
        if (line.length > 300) continue
        for (const rule of CONVENTION_RULES) {
          const match = rule.re.exec(line)
          if (match === null) continue
          conventions.push({
            kind: rule.kind,
            name: match[1],
            value: (match[2] ?? '').trim().slice(0, 80),
            path: file.path,
            line: i + 1,
          })
          break
        }
      }
    }

    // 3) focus 相关命中
    if (needles.length > 0) {
      const pathHit = hitIn(file.path, needles)
      const lineHits = []
      for (let i = 0; i < lines.length && lineHits.length < MAX_HITS_PER_FILE; i += 1) {
        const needle = hitIn(lines[i], needles)
        if (needle !== null) {
          lineHits.push({ line: i + 1, needle, text: lines[i].trim().slice(0, 140) })
        }
      }
      if (pathHit !== null || lineHits.length > 0) {
        similar.push({
          path: file.path,
          kind: file.kind,
          pathHit,
          hits: lineHits,
          score: (pathHit !== null ? 3 : 0) + lineHits.length,
        })
      }
    }
  }

  // 排序：先按 focus 相关度，再按类型权重。
  // 只按相关度排是不够的：相关度普遍为 0 时会退化成纯路径序，某类路径（如 electron/）
  // 会占满全部名额，把 frontend/ 的组件整类挤掉。用户最想看的是可复用组件，所以
  // 同分时 component 优先。
  assets.sort(
    (a, b) =>
      (b.relevance - a.relevance) ||
      ((KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)) ||
      (a.path < b.path ? -1 : 1),
  )
  similar.sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : 1))

  if (stats.truncated) {
    notes.push(`文件数达到上限 ${maxFiles ?? 20000}，扫描被截断，清单可能不完整。`)
  }
  if (needles.length === 0) {
    notes.push('未提供 focus，只做全量资产与约定提取，未做相关性匹配。')
  } else if (!assets.some((a) => a.relevance > 0)) {
    notes.push('资产清单里没有名字或路径命中 focus 的条目，已按类型权重给出全貌；哪些文件真的相关，看「与 focus 相关的既有文件」那一段。')
  }
  if (assets.length >= MAX_ASSETS) notes.push(`资产条目达到上限 ${MAX_ASSETS}，已截断。`)
  if (conventions.length >= MAX_CONVENTIONS) notes.push(`约定条目达到上限 ${MAX_CONVENTIONS}，已截断。`)

  const pickedAssets = pickByQuota(assets, MAX_ASSETS)
  return {
    root,
    focus: focus ?? '',
    tokens,
    aliases,
    assets: pickedAssets,
    conventions: conventions.slice(0, MAX_CONVENTIONS),
    similar: similar.slice(0, MAX_SIMILAR),
    stats: {
      ...stats,
      filesRead,
      skippedBinary,
      skippedLarge,
      assets: pickedAssets.length,
      conventions: Math.min(conventions.length, MAX_CONVENTIONS),
      similar: Math.min(similar.length, MAX_SIMILAR),
    },
    notes,
  }
}

/**
 * 按类型配额挑选要展示的条目，并保持传入顺序（传入前已排好序）。
 * focus 命中（relevance > 0）的条目不受配额限制，避免真相关的东西被挤掉。
 */
function pickByQuota(sorted, total) {
  const keep = new Set()
  for (const item of sorted) if (item.relevance > 0) keep.add(item)
  const used = {}
  for (const item of keep) used[item.kind] = (used[item.kind] ?? 0) + 1
  for (const item of sorted) {
    if (keep.size >= total) break
    if (keep.has(item)) continue
    if ((used[item.kind] ?? 0) >= (KIND_QUOTA[item.kind] ?? 10)) continue
    keep.add(item)
    used[item.kind] = (used[item.kind] ?? 0) + 1
  }
  return sorted.filter((item) => keep.has(item))
}

/** 名字与关键词的相关度打分，用于排序而不是过滤。 */
function scoreName(name, needles) {
  if (needles.length === 0) return 0
  const lower = name.toLowerCase()
  let score = 0
  for (const needle of needles) {
    const n = needle.toLowerCase()
    if (n.length < 2) continue
    if (lower === n) score += 10
    else if (lower.startsWith(n)) score += 6
    else if (lower.includes(n)) score += 4
  }
  return score
}

/**
 * 把盘点结果渲染成人/模型可读的 Markdown。
 *
 * 默认是结构视图（按目录聚合）；`expand: 'all'` 才逐条列出 `路径:行号`。
 * 这个默认值是对实测的回应：某项目 那种规模下逐条清单有 35652 字符，
 * 是 6000 预算的 5.2 倍，模型实际只读到前 1/5。
 */
export function renderInventoryMarkdown(result, options = {}) {
  if (options.expand !== 'all') return renderSummaryMarkdown(result)

  const out = []
  out.push(`# 资产盘点：${result.focus || '（全量）'}`)
  out.push('')
  out.push(`根目录：\`${result.root}\``)
  out.push('')
  out.push(`- 扫描文件：${result.stats.filesRead}（跳过二进制 ${result.stats.skippedBinary}、超大 ${result.stats.skippedLarge}）`)
  out.push(`- 资产条目：${result.stats.assets} · 约定条目：${result.stats.conventions} · 相关文件：${result.stats.similar}`)
  if (result.aliases.length > 0) {
    out.push(`- 关键词：${result.tokens.join('、') || '（无）'} → 英文别名：${result.aliases.join(', ')}`)
  }
  out.push('')

  if (result.assets.length > 0) {
    out.push('## 候选可复用资产')
    out.push('')
    // 按类型分组：平铺 200 条会让 110 个 component 淹没少数但关键的类型定义。
    const groups = new Map()
    for (const asset of result.assets) {
      if (!groups.has(asset.kind)) groups.set(asset.kind, [])
      groups.get(asset.kind).push(asset)
    }
    for (const [kind, items] of groups) {
      out.push(`### ${kind}（${items.length}）`)
      out.push('')
      for (const asset of items) {
        out.push(`- \`${asset.path}:${asset.line}\` ${asset.name}`)
      }
      out.push('')
    }
  }

  if (result.conventions.length > 0) {
    out.push('## 既有约定（样式变量 / design token）')
    out.push('')
    for (const item of result.conventions) {
      out.push(`- \`${item.path}:${item.line}\` [${item.kind}] ${item.name}: ${item.value}`)
    }
    out.push('')
  }

  if (result.similar.length > 0) {
    out.push('## 与 focus 相关的既有文件')
    out.push('')
    for (const item of result.similar) {
      out.push(`- \`${item.path}\`（命中 ${item.hits.length} 处${item.pathHit ? `，路径命中「${item.pathHit}」` : ''}）`)
      for (const hit of item.hits) {
        out.push(`  - \`:${hit.line}\` ${hit.text}`)
      }
    }
    out.push('')
  }

  if (result.notes.length > 0) {
    out.push('## 注意')
    out.push('')
    for (const note of result.notes) out.push(`- ${note}`)
    out.push('')
  }

  return out.join('\n')
}

/** 每个段落最多显示多少个目录分组，超出合并成一行计数。 */
const MAX_DIR_LINES = 15

/** 取条目所在目录（含尾部斜杠）；根目录的条目归到 `./`。 */
function dirOf(relPath) {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? './' : relPath.slice(0, idx + 1)
}

/** 把计数表渲染成 `component 80 / function 7`，最多列三种。 */
function histogramOf(counts) {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const shown = entries.slice(0, 3).map(([key, n]) => `${key} ${n}`)
  if (entries.length > 3) shown.push('…')
  return shown.join(' / ')
}

/**
 * 按目录聚合，并按条数降序截断。
 *
 * 汇总行与被合并的「另有 N 个目录」行都带条数，调用方可以把它们全部相加，
 * 结果必须等于输入条目数 —— 这是「没有条目被悄悄丢掉」的唯一可校验信号。
 */
function groupByDirectory(items, keyOf, kindOf, maxLines) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, { key, count: 0, kinds: new Map(), items: [] })
    const group = groups.get(key)
    group.count += 1
    group.items.push(item)
    const kind = kindOf(item)
    group.kinds.set(kind, (group.kinds.get(kind) ?? 0) + 1)
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
  // 根目录单独钉住显示：它条数通常最少，按条数排序会被挤进「另有 N 个目录」，
  // 但恰好是「项目根下那几个文件」最常被人找。占掉一个名额，不做例外逻辑。
  const pinned = sorted.filter((group) => group.key === './')
  const restSorted = sorted.filter((group) => group.key !== './')
  const slots = Math.max(0, maxLines - pinned.length)
  const rest = restSorted.slice(slots)
  return {
    shown: [...pinned, ...restSorted.slice(0, slots)],
    restDirs: rest.length,
    restCount: rest.reduce((sum, group) => sum + group.count, 0),
  }
}

/**
 * 「先看结构」视图：三段都按目录聚合，逐条明细需要 expand='all'。
 *
 * 为什么默认是这个视图：逐条 `路径:行号` 是硬证据，但 200 条资产 + 300 条约定
 * 会把 6000 字符预算吃满 5 倍，模型实际只读到前 1/5 —— 既看不到结构，也拿不全证据。
 * 汇总视图保证「结构一定看得全」，代价是行号要显式展开，这个取舍写在工具描述里。
 */
export function renderSummaryMarkdown(result) {
  const out = []
  out.push(`# 资产盘点：${result.focus || '（全量）'}`)
  out.push('')
  out.push(`根目录：\`${result.root}\``)
  out.push('')
  out.push(`- 扫描文件：${result.stats.filesRead}（跳过二进制 ${result.stats.skippedBinary}、超大 ${result.stats.skippedLarge}）`)
  out.push(`- 资产条目：${result.stats.assets} · 约定条目：${result.stats.conventions} · 相关文件：${result.stats.similar}`)
  if (result.aliases.length > 0) {
    out.push(`- 关键词：${result.tokens.join('、') || '（无）'} → 英文别名：${result.aliases.join(', ')}`)
  }
  out.push('')

  if (result.assets.length > 0) {
    const grouped = groupByDirectory(result.assets, (asset) => dirOf(asset.path), (asset) => asset.kind, MAX_DIR_LINES)
    out.push(`## 候选可复用资产（按目录，共 ${result.assets.length} 条）`)
    out.push('')
    for (const group of grouped.shown) {
      out.push(`- \`${group.key}\`（${group.count} 条：${histogramOf(group.kinds)}）`)
    }
    if (grouped.restDirs > 0) {
      out.push(`- …另有 ${grouped.restDirs} 个目录（共 ${grouped.restCount} 条）`)
    }
    out.push('')
  }

  if (result.conventions.length > 0) {
    const grouped = groupByDirectory(result.conventions, (item) => dirOf(item.path), (item) => item.kind, MAX_DIR_LINES)
    out.push(`## 既有约定（样式变量 / design token，共 ${result.conventions.length} 条）`)
    out.push('')
    for (const group of grouped.shown) {
      out.push(`- \`${group.key}\`（${group.count} 条：${histogramOf(group.kinds)}）`)
    }
    if (grouped.restDirs > 0) {
      out.push(`- …另有 ${grouped.restDirs} 个目录（共 ${grouped.restCount} 条）`)
    }
    out.push('')
  }

  if (result.similar.length > 0) {
    const grouped = groupByDirectory(result.similar, (item) => dirOf(item.path), () => '文件', MAX_DIR_LINES)
    out.push(`## 与 focus 相关的既有文件（共 ${result.similar.length} 个）`)
    out.push('')
    for (const group of grouped.shown) {
      if (group.count === 1) {
        // 目录下只有 1 个文件时，「按目录聚合」等于把文件名换成目录名：行数没省，
        // 反而把最该看的文件路径藏了（某项目 实测 24 个文件散在 24 个目录，退化成 16 行「1 个文件」）。
        const item = group.items[0]
        out.push(`- \`${item.path}\`（命中 ${item.hits === undefined ? 0 : item.hits.length} 处）`)
      } else {
        out.push(`- \`${group.key}\`（${group.count} 个文件）`)
      }
    }
    if (grouped.restDirs > 0) {
      // 相关文件段里每个目录往往只有 1 个文件，说「另有 9 个目录」会让人以为是 9 组，
      // 其实是 9 个文件 —— 直接用文件的计数单位。
      out.push(`- …另有 ${grouped.restCount} 个文件（分布在 ${grouped.restDirs} 个目录）`)
    }
    out.push('')
  }

  if (result.notes.length > 0) {
    out.push('## 注意')
    out.push('')
    for (const note of result.notes) out.push(`- ${note}`)
    out.push('')
  }

  out.push('> 这是结构视图。需要逐条 `路径:行号` 硬证据时，把 `expand` 设为 `all` 再调一次。')

  return out.join('\n')
}
