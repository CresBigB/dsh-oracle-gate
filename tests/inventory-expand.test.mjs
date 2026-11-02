#!/usr/bin/env node
/**
 * expand 参数的行为测试。
 *
 * 默认视图必须短（不逐条），expand='all' 必须真的把每一条 `路径:行号` 都给出来。
 * 这两条是一个硬币的两面：如果默认就逐条，长度问题没解决；如果 all 也压缩了，
 * 模型就永远拿不到证据 —— 工具的核心能力被换掉了。
 */
import { renderInventoryMarkdown } from '../src/protocols/assets.js'

let passed = 0
let failed = 0

function check(label, ok) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}

/** 逐条资产行：`- \`src/a/One.vue:1\` One` */
const ITEM_RE = /^\s*- `[^`]+:\d+` /
/** 目录汇总行：`- \`src/a/\`（3 条：component 3）` */
const SUMMARY_RE = /^- `([^`]+)`（(\d+) 条/

/** 只取「候选可复用资产」这一段 —— 约定段的行同样形如 `- \`路径:行号\``，混在一起会算错。 */
function assetSection(text) {
  const marker = '## 候选可复用资产'
  const start = text.indexOf(marker)
  if (start === -1) return ''
  const rest = text.slice(start + marker.length)
  const end = rest.indexOf('\n## ')
  return end === -1 ? rest : rest.slice(0, end)
}

function asset(path, line, name, kind) {
  return { path, line, name, kind, relevance: 0 }
}

const assets = [
  asset('src/components/a/One.vue', 1, 'One', 'component'),
  asset('src/components/a/Two.vue', 1, 'Two', 'component'),
  asset('src/components/a/three.ts', 12, 'three', 'function'),
  asset('src/components/b/Four.vue', 1, 'Four', 'component'),
  asset('src/utils/five.ts', 30, 'five', 'function'),
  asset('Root.vue', 1, 'Root', 'component'),
]

function makeResult() {
  return {
    root: 'E:/demo',
    focus: '按钮',
    tokens: ['按钮'],
    aliases: ['button'],
    assets,
    conventions: [{ path: 'src/styles/a.scss', line: 1, kind: 'css-var', name: '--x', value: '#fff' }],
    similar: [{ path: 'src/views/home/index.vue', hits: [], pathHit: null }],
    stats: { filesRead: 6, skippedBinary: 0, skippedLarge: 0, assets: assets.length, conventions: 1, similar: 1 },
    notes: [],
  }
}

console.log('[1] 默认视图（expand 未传）')
{
  const lines = renderInventoryMarkdown(makeResult()).split('\n')
  check('有目录汇总行', lines.filter((line) => SUMMARY_RE.test(line)).length >= 1)
  check('逐条资产行数为 0', lines.filter((line) => ITEM_RE.test(line)).length === 0)
}

console.log('')
console.log("[2] expand='none' 与不传等价")
{
  const implicit = renderInventoryMarkdown(makeResult())
  const explicit = renderInventoryMarkdown(makeResult(), { expand: 'none' })
  check('两种写法的输出完全一致', implicit === explicit)
}

console.log('')
console.log("[3] expand='all' 逐条输出")
{
  const text = renderInventoryMarkdown(makeResult(), { expand: 'all' })
  const lines = text.split('\n')
  const items = assetSection(text).split('\n').filter((line) => ITEM_RE.test(line))
  check('逐条行数 == 资产数 6', items.length === assets.length)
  check('每条资产都能在输出里找到其 路径:行号',
    assets.every((item) => lines.some((line) => line.includes(`\`${item.path}:${item.line}\``))))
  check('不再出现目录汇总行', lines.filter((line) => SUMMARY_RE.test(line)).length === 0)
}

console.log('')
console.log('[4] 未知 expand 值退化为默认视图')
{
  const lines = renderInventoryMarkdown(makeResult(), { expand: 'whatever' }).split('\n')
  check('未知取值不逐条', lines.filter((line) => ITEM_RE.test(line)).length === 0)
  check('未知取值仍有汇总行', lines.filter((line) => SUMMARY_RE.test(line)).length >= 1)
}

console.log('')
console.log('[5] 两种视图的资产总数一致')
{
  function totalFromSummary(text) {
    let total = 0
    for (const line of text.split('\n')) {
      const summary = SUMMARY_RE.exec(line)
      if (summary !== null) total += Number(summary[2])
      const others = /^- …另有 (\d+) 个目录（共 (\d+) 条）$/.exec(line)
      if (others !== null) total += Number(others[2])
    }
    return total
  }
  const summaryTotal = totalFromSummary(assetSection(renderInventoryMarkdown(makeResult())))
  const detailTotal = assetSection(renderInventoryMarkdown(makeResult(), { expand: 'all' }))
    .split('\n').filter((line) => ITEM_RE.test(line)).length
  check('汇总视图与逐条视图覆盖的资产数相同', summaryTotal === detailTotal)
}

console.log('')
if (failed > 0) {
  console.log(`失败 ${failed} 项，通过 ${passed} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
