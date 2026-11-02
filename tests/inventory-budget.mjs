#!/usr/bin/env node
/**
 * 预算与覆盖率测试：结构视图必须真的把 6000 字符预算收进 3000 以内，
 * 且不能靠「丢掉一部分条目」来变短。
 *
 * 样本按三个上限构造：资产 200、约定 300、相关文件 60 —— 这是
 * `src/protocols/assets.js` 里 MAX_ASSETS / MAX_CONVENTIONS / MAX_SIMILAR 的值。
 * 实测 某项目 在这种规模下逐条渲染是 35652 字符，被 6000 截断，模型只看到前 1/5。
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

const MAX_ASSETS = 200
const MAX_CONVENTIONS = 300
const MAX_SIMILAR = 60
const INLINE_BUDGET = 3000
const MIN_RATIO = 5

console.log('[1] 构造最坏样本（资产 200 / 约定 300 / 相关文件 60）')
const assets = []
for (let i = 0; i < MAX_ASSETS - 2; i += 1) {
  const dir = `electron/module${i % 78}`
  assets.push({
    path: `${dir}/Item${i}.vue`,
    line: i + 1,
    name: `Item${i}`,
    kind: ['component', 'function', 'type'][i % 3],
    relevance: 0,
  })
}
// 根目录资产：路径里没有 `/`，必须仍然被汇总行覆盖
assets.push({ path: 'RootA.vue', line: 1, name: 'RootA', kind: 'component', relevance: 0 })
assets.push({ path: 'RootB.ts', line: 9, name: 'RootB', kind: 'function', relevance: 0 })

const conventions = []
for (let i = 0; i < MAX_CONVENTIONS; i += 1) {
  conventions.push({
    path: `frontend/src/styles/file${i % 12}.scss`,
    line: i + 1,
    kind: 'css-var',
    name: `--color-${i}`,
    value: '#2a68c8',
  })
}

const similar = []
for (let i = 0; i < MAX_SIMILAR; i += 1) {
  similar.push({
    path: `frontend/src/views/v${i % 9}/Page${i}.vue`,
    hits: [{ line: i + 1, text: 'const keyword = 1' }],
    pathHit: null,
  })
}

const sample = {
  root: 'E:/sample',
  focus: '按钮',
  tokens: ['按钮'],
  aliases: ['button'],
  assets,
  conventions,
  similar,
  stats: {
    filesRead: MAX_ASSETS,
    skippedBinary: 0,
    skippedLarge: 0,
    assets: assets.length,
    conventions: conventions.length,
    similar: similar.length,
  },
  notes: [],
}
check('样本规模符合上限', assets.length === MAX_ASSETS && conventions.length === MAX_CONVENTIONS && similar.length === MAX_SIMILAR)

console.log('')
console.log('[2] 结构视图压进 3000 字符')
const compact = renderInventoryMarkdown(sample)
const baseline = renderInventoryMarkdown(sample, { expand: 'all' })
console.log(`  结构视图 ${compact.length} 字符 / 逐条视图 ${baseline.length} 字符`)
check(`结构视图 <= ${INLINE_BUDGET} 字符`, compact.length <= INLINE_BUDGET)
check(`压缩比 >= ${MIN_RATIO}×（实测 ${(baseline.length / compact.length).toFixed(1)}×）`,
  baseline.length / compact.length >= MIN_RATIO)

console.log('')
console.log('[3] 覆盖率：没有任何资产被悄悄丢掉')
const SUMMARY_RE = /^- `([^`]+)`（(\d+) 条/
const OTHERS_RE = /^- …另有 (\d+) 个目录（共 (\d+) 条）$/
/** 只取资产段：约定段的行结构相似，一起统计会把条数算重。 */
function assetSection(text) {
  const marker = '## 候选可复用资产'
  const start = text.indexOf(marker)
  if (start === -1) return ''
  const rest = text.slice(start + marker.length)
  const end = rest.indexOf('\n## ')
  return end === -1 ? rest : rest.slice(0, end)
}
function coveredAssets(text) {
  let total = 0
  for (const line of text.split('\n')) {
    const summary = SUMMARY_RE.exec(line)
    if (summary !== null) total += Number(summary[2])
    const others = OTHERS_RE.exec(line)
    if (others !== null) total += Number(others[2])
  }
  return total
}
const covered = coveredAssets(assetSection(compact))
check(`被目录行覆盖的资产数 == 资产总数（${covered} / ${assets.length}）`, covered === assets.length)

console.log('')
console.log('[4] 根目录资产单独成组，不进「另有」黑洞')
check('存在 ./ 汇总行且条数为 2',
  assetSection(compact).split('\n').some((line) => /^- `\.\/`（2 条/.test(line)))

console.log('')
console.log('[5] 约定段也收敛（否则单这一段就能吃满预算）')
const conventionSection = compact.split('## 既有约定')[1]?.split('##')[0] ?? ''
const conventionLines = conventionSection.split('\n').filter((line) => line.trim().startsWith('- '))
check(`约定段行数 <= 16（实测 ${conventionLines.length}）`, conventionLines.length <= 16)

console.log('')
console.log('[6] 逐条视图仍完整（结构视图变短不能靠削掉证据能力）')
const ITEM_RE = /^\s*- `[^`]+:\d+` /
check('逐条视图资产行数 == 资产总数',
  assetSection(baseline).split('\n').filter((line) => ITEM_RE.test(line)).length === assets.length)

console.log('')
if (failed > 0) {
  console.log(`失败 ${failed} 项，通过 ${passed} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
