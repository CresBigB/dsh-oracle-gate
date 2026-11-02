#!/usr/bin/env node
/**
 * renderInventoryMarkdown 的目录汇总视图测试。
 *
 * 钉住三件事：同一目录只出一行汇总、所有汇总行的条数之和等于资产总数、
 * 每行带类型直方图。第三条是「结构视图」是否真的好读的关键 —— 只有条数
 * 没有构成，人还是得一条条问回去，等于没解决「太长」。
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

/** 汇总行：`- \`src/a/\`（4 条：component 3 / function 1）` */
const SUMMARY_RE = /^- `([^`]+)`（(\d+) 条：(.+)）$/
/** 被合并的目录：`- …另有 5 个目录（共 5 条）` */
const OTHERS_RE = /^- …另有 (\d+) 个目录（共 (\d+) 条）$/
/** 逐条资产行：`- \`src/a/One.vue:1\` One` */
const ITEM_RE = /^\s*- `[^`]+:\d+` /

function asset(path, line, name, kind) {
  return { path, line, name, kind, relevance: 0 }
}

function makeResult(assets, extra = {}) {
  return {
    root: 'E:/demo',
    focus: '按钮',
    tokens: ['按钮'],
    aliases: ['button'],
    assets,
    conventions: [],
    similar: [],
    stats: {
      filesRead: assets.length,
      skippedBinary: 0,
      skippedLarge: 0,
      assets: assets.length,
      conventions: 0,
      similar: 0,
    },
    notes: [],
    ...extra,
  }
}

function sumCovered(lines) {
  let total = 0
  for (const line of lines) {
    const summary = SUMMARY_RE.exec(line)
    if (summary !== null) total += Number(summary[2])
    const others = OTHERS_RE.exec(line)
    if (others !== null) total += Number(others[2])
  }
  return total
}

console.log('[1] 同一目录只出一行汇总')
{
  const group = makeResult([
    asset('src/components/a/One.vue', 1, 'One', 'component'),
    asset('src/components/a/Two.vue', 1, 'Two', 'component'),
    asset('src/components/a/Three.vue', 1, 'Three', 'component'),
    asset('src/components/a/four.ts', 12, 'four', 'function'),
    asset('src/components/b/Five.vue', 1, 'Five', 'component'),
  ])
  const lines = renderInventoryMarkdown(group).split('\n')
  const summaries = lines.filter((line) => SUMMARY_RE.test(line))

  check('两个目录 → 两行汇总', summaries.length === 2)
  check('src/components/a/ 的 4 条资产只占 1 行', summaries.filter((line) => line.includes('src/components/a/')).length === 1)
  check('汇总行条数之和 == 资产总数 5', sumCovered(lines) === group.assets.length)
  check('结构视图不含逐条资产行', lines.filter((line) => ITEM_RE.test(line)).length === 0)

  const lineA = summaries.find((line) => line.includes('src/components/a/'))
  check('汇总行带类型直方图（包含 component 3 与 function 1）',
    lineA !== undefined && lineA.includes('component 3') && lineA.includes('function 1'))
}

console.log('')
console.log('[2] 目录过多时合并成一行计数')
{
  const many = makeResult(
    Array.from({ length: 20 }, (_, i) => asset(`src/d${i}/C${i}.vue`, 1, `C${i}`, 'component')),
  )
  const lines = renderInventoryMarkdown(many).split('\n')
  check('20 个目录只显示 15 行明细', lines.filter((line) => SUMMARY_RE.test(line)).length === 15)
  check('被合并的 5 个目录各占一行汇总', lines.filter((line) => OTHERS_RE.test(line)).length === 1)
  check('合并行的条数也计入，覆盖总和仍是 20', sumCovered(lines) === 20)
}

console.log('')
console.log('[3] 根目录资产不被丢弃')
{
  const rooty = makeResult([
    asset('Root.vue', 1, 'Root', 'component'),
    asset('src/a/Child.vue', 1, 'Child', 'component'),
  ])
  const text = renderInventoryMarkdown(rooty)
  check('根目录资产归到 ./ 汇总行', text.split('\n').some((line) => /^- `\.\/`（1 条/.test(line)))
  check('两个目录的条数之和 == 2', sumCovered(text.split('\n')) === 2)
}

console.log('')
console.log('[4] 约定与相关文件同样按目录聚合')
{
  const mixed = makeResult(
    [asset('src/a/One.vue', 1, 'One', 'component')],
    {
      conventions: [
        { path: 'src/styles/a.scss', line: 1, kind: 'css-var', name: '--x', value: '#fff' },
        { path: 'src/styles/a.scss', line: 2, kind: 'css-var', name: '--y', value: '#000' },
      ],
      similar: [{ path: 'src/views/home/index.vue', hits: [], pathHit: null }],
      stats: { filesRead: 4, skippedBinary: 0, skippedLarge: 0, assets: 1, conventions: 2, similar: 1 },
    },
  )
  const text = renderInventoryMarkdown(mixed)
  check('约定段按文件聚合成 1 行', /- `src\/styles\/`（2 条：css-var 2）/.test(text))
  check('相关文件段单条目录直接出文件名而不是目录名', /- `src\/views\/home\/index\.vue`（命中 0 处）/.test(text))
  check('结构视图末尾提示如何拿逐条证据', text.includes('expand'))

  const multi = renderInventoryMarkdown(makeResult([], {
    similar: [
      { path: 'src/views/home/index.vue', hits: [], pathHit: null },
      { path: 'src/views/home/Detail.vue', hits: [], pathHit: null },
    ],
  }))
  check('相关文件段同目录多条时仍聚合', /- `src\/views\/home\/`（2 个文件）/.test(multi))
}

console.log('')
if (failed > 0) {
  console.log(`失败 ${failed} 项，通过 ${passed} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
