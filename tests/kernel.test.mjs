// 期 4a 执行内核单测：全部用合成数据，不依赖任何真实项目，也不碰 某项目。
//
// 覆盖四件事：预算账本不退款、判据冻结不可改、回执记录真实退出码、裁决三态。
// 这些是内核的全部约定；只要它们成立，领域包可以随便换。
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUCKETS,
  DEFAULT_BUDGET,
  appendLedger,
  normalizeBudget,
  readLedger,
  remainingOf,
  reserve,
  usageOf,
} from '../src/kernel/ledger.js'
import { findOracle, freezeOracles, hashOf, loadOracles, splitCommand } from '../src/kernel/oracles.js'
import { executeOracle, receiptsDir, verdictOf, writeReceipt } from '../src/kernel/receipt.js'
import { evaluateGate, normalizeReviews } from '../src/kernel/gate.js'
import { FAILURE_CLASSES, RETRY_TARGET, recordFailure, searchFailures } from '../src/kernel/failures.js'
import { runDirOf } from '../src/kernel/run.js'
import { compileAcceptance } from '../src/kernel/compile.js'

let passCount = 0
let failCount = 0

async function check(name, fn) {
  try {
    await fn()
    passCount += 1
    console.log(`  OK   ${name}`)
  } catch (error) {
    failCount += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'kit-kernel-'))
const runDir = runDirOf(root, 'test-run')
const node = process.execPath

function oracle(over = {}) {
  const merged = {
    id: 'L0-a',
    level: 'L0',
    criterion: '合成判据',
    command: `"${node}" -e "process.exit(0)"`,
    cwd: '.',
    bucket: 'execution',
    timeout_ms: 30000,
    expect: { exit_code: 0 },
    ...over,
  }
  // executeOracle 直接吃 argv（freeze 时算好），这里绕过了 freeze，所以自己算一遍。
  merged.argv = merged.command === null ? null : splitCommand(merged.command)
  return merged
}

// ---------------------------------------------------------------- 账本
console.log('\n[1] 预算账本：预留即消耗，不退款')

await check('默认预算与 BUCKETS 一致', () => {
  for (const bucket of BUCKETS) assert.equal(DEFAULT_BUDGET[bucket] >= 0, true, bucket)
  assert.deepEqual(Object.keys(normalizeBudget(null)).sort(), [...BUCKETS].sort())
})

await check('空账本读出 0 条且不报错', async () => {
  const { entries, corrupted } = await readLedger(runDir)
  assert.equal(entries.length, 0)
  assert.equal(corrupted, 0)
})

await check('reserve 成功并扣减余额', async () => {
  const budget = normalizeBudget(null)
  const result = await reserve(runDir, { bucket: 'execution', amount: 1, budget })
  assert.equal(result.ok, true)
  assert.equal(result.remaining.execution, budget.execution - 1)
})

await check('反复 reserve 直到耗尽后返回 budget-exhausted', async () => {
  const budget = normalizeBudget({ execution: 2, evidence: 0, design: 0, impl: 0, infra: 0, review: 0, acceptance: 0 })
  const dir = runDirOf(root, 'budget-run')
  const first = await reserve(dir, { bucket: 'execution', budget })
  const second = await reserve(dir, { bucket: 'execution', budget })
  const third = await reserve(dir, { bucket: 'execution', budget })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(third.ok, false)
  assert.equal(third.error, 'budget-exhausted')
  assert.equal(third.remaining, 0)
})

await check('没有退款接口：再次 reserve 只会继续减少', async () => {
  const budget = normalizeBudget({ execution: 5 })
  const dir = runDirOf(root, 'no-refund')
  await reserve(dir, { bucket: 'execution', budget })
  await reserve(dir, { bucket: 'execution', budget })
  const { entries } = await readLedger(dir)
  assert.equal(usageOf(entries).execution, 2)
  assert.equal(remainingOf(budget, entries).execution, 3)
})

await check('未知桶被拒绝', async () => {
  const result = await reserve(runDir, { bucket: 'nope', budget: normalizeBudget(null) })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unknown-bucket')
})

await check('坏行只计数，不让整本账不可读', async () => {
  const dir = runDirOf(root, 'corrupt-ledger')
  await appendLedger(dir, { kind: 'reserve', bucket: 'execution', amount: 1 })
  const file = join(dir, 'ledger.jsonl')
  await writeFile(file, (await readFile(file, 'utf8')) + '{不是合法JSON}\n', 'utf8')
  const { entries, corrupted } = await readLedger(dir)
  assert.equal(entries.length, 1)
  assert.equal(corrupted, 1)
})

// ---------------------------------------------------------------- 判据冻结
console.log('\n[2] 判据冻结：写一次，之后不可改')

await check('冻结成功并记录 hash', async () => {
  const dir = runDirOf(root, 'freeze-run')
  const result = await freezeOracles(dir, {
    root,
    run_id: 'freeze-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ id: 'L0-a' }), oracle({ id: 'L1-b', level: 'L1', bucket: 'evidence' })],
  })
  assert.equal(result.ok, true)
  assert.match(result.doc.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.doc.oracles.length, 2)
})

await check('重复冻结被拒绝，不覆盖原判据', async () => {
  const dir = runDirOf(root, 'freeze-run')
  const again = await freezeOracles(dir, {
    root,
    run_id: 'freeze-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ id: 'L0-changed' })],
  })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'already-frozen')
  const loaded = await loadOracles(dir)
  assert.equal(loaded.doc.oracles[0].id, 'L0-a')
})

await check('oracles.json 被改一个字节就 hash-mismatch', async () => {
  const dir = runDirOf(root, 'freeze-run')
  const file = join(dir, 'oracles.json')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('合成判据', '合成判据X'), 'utf8')
  const loaded = await loadOracles(dir)
  assert.equal(loaded.ok, false)
  assert.equal(loaded.error, 'hash-mismatch')
})

await check('带 shell 元字符的命令被拒绝', async () => {
  const dir = runDirOf(root, 'meta-run')
  const result = await freezeOracles(dir, {
    root,
    run_id: 'meta-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ command: 'npm test && echo done' })],
  })
  assert.equal(result.ok, false)
  assert.equal(result.detail.error, 'shell-meta-not-allowed')
})

await check('cwd 越界被拒绝', async () => {
  const dir = runDirOf(root, 'cwd-run')
  const result = await freezeOracles(dir, {
    root,
    run_id: 'cwd-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ cwd: '../../..' })],
  })
  assert.equal(result.ok, false)
  assert.equal(result.detail.error, 'cwd-outside-root')
})

await check('L0 缺 command 被拒绝，L2 缺 command 视为人工判据', async () => {
  const dir = runDirOf(root, 'manual-run')
  const noCmd = await freezeOracles(dir, {
    root,
    run_id: 'manual-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ command: null })],
  })
  assert.equal(noCmd.ok, false)
  assert.equal(noCmd.detail.error, 'missing-command')

  const dir2 = runDirOf(root, 'manual-run-2')
  const manual = await freezeOracles(dir2, {
    root,
    run_id: 'manual-run-2',
    budget: normalizeBudget(null),
    oracles: [{ id: 'L2-review', level: 'L2', criterion: '人工评审', command: null }],
  })
  assert.equal(manual.ok, true)
  assert.equal(manual.doc.oracles[0].manual, true)
})

await check('重复 id 被拒绝', async () => {
  const dir = runDirOf(root, 'dup-run')
  const result = await freezeOracles(dir, {
    root,
    run_id: 'dup-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ id: 'same' }), oracle({ id: 'same' })],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'duplicate-id')
})

await check('hash 与键顺序无关', () => {
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }))
})

await check('splitCommand 支持引号且不展开变量', () => {
  assert.deepEqual(splitCommand('"C:/Program Files/node.exe" -e "x"'), [
    'C:/Program Files/node.exe',
    '-e',
    'x',
  ])
  assert.deepEqual(splitCommand('echo $HOME'), ['echo', '$HOME'])
})

await check('findOracle 命中与未命中', async () => {
  const dir = runDirOf(root, 'find-run')
  await freezeOracles(dir, {
    root,
    run_id: 'find-run',
    budget: normalizeBudget(null),
    oracles: [oracle({ id: 'L0-x' })],
  })
  const loaded = await loadOracles(dir)
  assert.equal(findOracle(loaded.doc, 'L0-x').id, 'L0-x')
  assert.equal(findOracle(loaded.doc, 'nope'), null)
})

// ---------------------------------------------------------------- 回执
console.log('\n[3] 回执：真实退出码、超时、落盘')

await check('执行成功时 verdict=passed', async () => {
  const receipt = await executeOracle({ root, oracle: oracle() })
  assert.equal(receipt.exit_code, 0)
  assert.equal(verdictOf(receipt), 'passed')
  assert.equal(receipt.timed_out, false)
})

await check('非零退出码判 failed 且记录真实码', async () => {
  const receipt = await executeOracle({
    root,
    oracle: oracle({ command: `"${node}" -e "process.exit(3)"` }),
  })
  assert.equal(receipt.exit_code, 3)
  assert.equal(verdictOf(receipt), 'failed')
})

await check('超时被杀并标记 timed_out', async () => {
  const receipt = await executeOracle({
    root,
    oracle: oracle({ command: `"${node}" -e "setTimeout(()=>{},5000)"`, timeout_ms: 1000 }),
  })
  assert.equal(receipt.timed_out, true)
  assert.equal(verdictOf(receipt), 'timed-out')
})

await check('回执落盘含输出哈希', async () => {
  const receipt = await executeOracle({
    root,
    oracle: oracle({ command: `"${node}" -e "console.log('hello')"` }),
  })
  const written = await writeReceipt(runDir, receipt, 1)
  const text = await readFile(written.file, 'utf8')
  const parsed = JSON.parse(text)
  assert.match(parsed.stdout_sha256, /^sha256:/)
  assert.equal(parsed.stdout_head.includes('hello'), true)
  assert.equal(written.file.startsWith(receiptsDir(runDir)), true)
})

// ---------------------------------------------------------------- 裁决
console.log('\n[4] 准入裁决：四态')

const gateDir = runDirOf(root, 'gate-run')
await freezeOracles(gateDir, {
  root,
  run_id: 'gate-run',
  budget: normalizeBudget(null),
  oracles: [
    oracle({ id: 'L0-a', level: 'L0' }),
    oracle({ id: 'L1-b', level: 'L1', bucket: 'evidence' }),
    { id: 'L2-c', level: 'L2', criterion: '人工评审', command: null },
  ],
})
const gateDoc = (await loadOracles(gateDir)).doc

function receiptFor(id, exitCode) {
  return {
    oracle_id: id,
    exit_code: exitCode,
    expected_exit_code: 0,
    timed_out: false,
    spawn_error: null,
    duration_ms: 1,
    stdout_head: '',
    stderr_head: '',
  }
}

await check('缺回执判 insufficient-evidence（没跑不等于过）', () => {
  const result = evaluateGate({ doc: gateDoc, receipts: [], reviews: [] })
  assert.equal(result.verdict, 'insufficient-evidence')
  assert.equal(result.missing.length, 2)
})

await check('L0 失败直接 rejected，且不会被后续补齐覆盖', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 1), receiptFor('L1-b', 0)],
    reviews: [{ oracle_id: 'L2-c', verdict: 'pass', evidence_refs: ['a.ts:1'] }],
  })
  assert.equal(result.verdict, 'rejected')
  assert.equal(result.failed.length, 1)
  assert.equal(result.missing.length, 0)
})

await check('只剩人工判据时判 blocked-on-human', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 0), receiptFor('L1-b', 0)],
    reviews: [],
  })
  assert.equal(result.verdict, 'blocked-on-human')
  assert.deepEqual(result.awaiting_human, ['L2-c'])
})

await check('全部齐活且无 veto 时 pass', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 0), receiptFor('L1-b', 0)],
    reviews: [{ oracle_id: 'L2-c', verdict: 'pass', evidence_refs: ['a.ts:1'] }],
  })
  assert.equal(result.verdict, 'pass')
})

await check('评审 veto 一律 rejected', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 0), receiptFor('L1-b', 0)],
    reviews: [{ oracle_id: 'L2-c', verdict: 'pass', veto: true, evidence_refs: ['a.ts:1'] }],
  })
  assert.equal(result.verdict, 'rejected')
  assert.deepEqual(result.vetoed, ['L2-c'])
})

await check('评审 unknowns 非空不准入', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 0), receiptFor('L1-b', 0)],
    reviews: [
      { oracle_id: 'L2-c', verdict: 'pass', unknowns: [{ kind: 'evidence', text: '没测' }], evidence_refs: ['a.ts:1'] },
    ],
  })
  assert.equal(result.verdict, 'rejected')
})

await check('评审没给 evidence_refs 不准入', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 0), receiptFor('L1-b', 0)],
    reviews: [{ oracle_id: 'L2-c', verdict: 'pass', evidence_refs: [] }],
  })
  assert.equal(result.verdict, 'rejected')
  assert.deepEqual(result.without_evidence_refs, ['L2-c'])
})

await check('后写入的回执覆盖先写入的（重跑取最新）', () => {
  const result = evaluateGate({
    doc: gateDoc,
    receipts: [receiptFor('L0-a', 1), receiptFor('L0-a', 0), receiptFor('L1-b', 0)],
    reviews: [{ oracle_id: 'L2-c', verdict: 'pass', evidence_refs: ['a.ts:1'] }],
  })
  assert.equal(result.verdict, 'pass')
})

// ---------------------------------------------------------------- 失败归因
console.log('\n[5] 失败归因：类别绑定回退目标')

await check('已知类别绑定正确的 retry_target', () => {
  assert.equal(RETRY_TARGET['implementation'], 'implement')
  assert.equal(RETRY_TARGET['design'], 'design')
  assert.equal(RETRY_TARGET['evidence-gap'], 'evidence')
  assert.equal(RETRY_TARGET['infrastructure'], 'no-replay')
  assert.equal(RETRY_TARGET['requirement-misread'], 'clarify')
  assert.equal(RETRY_TARGET['oracle-gamed'], 'freeze')
  assert.equal(FAILURE_CLASSES.length, 6)
})

await check('记录失败并带上回退目标', async () => {
  const dir = runDirOf(root, 'fail-run')
  const recorded = await recordFailure(dir, {
    class: 'design',
    summary: '方案假设了不存在的虚拟滚动组件',
    evidence: ['src/a.vue:12'],
  })
  assert.equal(recorded.ok, true)
  assert.equal(recorded.record.retry_target, 'design')
})

await check('未知类别被拒绝', async () => {
  const dir = runDirOf(root, 'fail-run')
  const bad = await recordFailure(dir, { class: 'whatever', summary: 'x' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'unknown-class')
})

await check('检索能命中关键词，且按类别过滤', async () => {
  const dir = runDirOf(root, 'fail-run')
  await recordFailure(dir, { class: 'implementation', summary: '空指针未处理', evidence: ['b.ts:3'] })
  const byKeyword = await searchFailures(dir, { query: '虚拟滚动' })
  assert.equal(byKeyword.total, 2)
  assert.equal(byKeyword.matched, 1)
  const byClass = await searchFailures(dir, { class: 'implementation' })
  assert.equal(byClass.matched, 1)
  assert.equal(byClass.items[0].class, 'implementation')
})

await check('reviews 两种写法都归一：数组与按 id 索引的对象', async () => {
  const asArray = normalizeReviews([
    { oracle_id: 'L2-ui', veto: false, unknowns: [], evidence_refs: ['a.vue:1'] },
  ])
  assert.equal(asArray.length, 1)
  assert.equal(asArray[0].oracle_id, 'L2-ui')

  // 模型很容易写成对象形式；旧实现只认数组，会静默当成「没人评」。
  const asObject = normalizeReviews({
    'L2-ui': { veto: false, unknowns: [], evidence_refs: ['a.vue:1'] },
  })
  assert.equal(asObject.length, 1)
  assert.equal(asObject[0].oracle_id, 'L2-ui')

  // 显式 oracle_id 优先于键名，避免调用方给了更准确的信息却被覆盖。
  const explicit = normalizeReviews({
    alias: { oracle_id: 'L2-real', veto: false, unknowns: [], evidence_refs: ['a.vue:1'] },
  })
  assert.equal(explicit[0].oracle_id, 'L2-real')

  assert.equal(normalizeReviews(null).length, 0)
  assert.equal(normalizeReviews('oops').length, 0)
})

await check('对象形式 reviews 能被裁决真正用上（不再误判 blocked-on-human）', async () => {
  const dir = runDirOf(root, 'gate-object-reviews')
  const frozen = await freezeOracles(dir, {
    run_id: 'gate-object-reviews',
    root,
    oracles: [{ id: 'L2-ui', level: 'L2', criterion: '人工确认', manual: true }],
  })
  assert.equal(frozen.ok, true)

  const reviews = normalizeReviews({
    'L2-ui': { veto: false, unknowns: [], evidence_refs: ['a.vue:2491'] },
  })
  const result = evaluateGate({ doc: frozen.doc, receipts: [], reviews })
  assert.equal(result.verdict, 'pass')
  assert.deepEqual(result.passed, ['L2-ui'])
})

console.log('\n[6] 验收条件编译：acceptance → oracles')

await check('&& 链接的命令被拆成多条判据，id 带 a/b 后缀', async () => {
  const result = compileAcceptance([
    { criterion: '既有用例不回归', level: 'L0', check: 'node tests/design-protocol.test.mjs && node tests/kernel.test.mjs 均退出码 0' },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.oracles.length, 2)
  assert.deepEqual(result.oracles.map((oracle) => oracle.id), ['L0-1a', 'L0-1b'])
  assert.equal(result.oracles[0].command, 'node tests/design-protocol.test.mjs')
  // 尾巴上的中文说明被剥掉，不会混进命令里去被 spawn
  assert.equal(result.oracles[1].command, 'node tests/kernel.test.mjs')
})

await check('check 里的中文说明不会混进命令', async () => {
  const result = compileAcceptance([
    { criterion: '工具注册未被破坏', level: 'L0', check: 'node tests/validate-tools.mjs 退出码 0（校验点在 tests/validate-tools.mjs:56-71）' },
  ])
  assert.equal(result.oracles.length, 1)
  assert.equal(result.oracles[0].command, 'node tests/validate-tools.mjs')
})

await check('内联脚本连同引号内的分号一起保留', async () => {
  const inline = 'node --input-type=module -e "import {inventory} from \'./src/x.js\'; console.log(1)" 输出首列 ≤ 6000'
  const result = compileAcceptance([{ criterion: '输出压进上限', level: 'L1', check: inline }])
  assert.equal(result.oracles.length, 1)
  assert.equal(
    result.oracles[0].command,
    'node --input-type=module -e "import {inventory} from \'./src/x.js\'; console.log(1)"',
  )
  assert.equal(result.oracles[0].bucket, 'evidence')
})

await check('L0 提不出命令时报 blocking，且不降级成人工判据', async () => {
  const result = compileAcceptance([{ criterion: '人工看看', level: 'L0', check: '人工判断即可' }])
  assert.equal(result.ok, false)
  assert.equal(result.oracles.length, 0, '绝不能生成一条 manual 的 L0 判据来让门失效')
  assert.equal(result.issues[0].reason, 'needs-command')
  assert.equal(result.issues[0].severity, 'blocking')
})

await check('管道等 shell 元字符被拒绝而不是静默跑错', async () => {
  const result = compileAcceptance([{ criterion: '查一下', level: 'L0', check: 'node a.mjs | grep foo' }])
  assert.equal(result.ok, false)
  assert.equal(result.issues[0].reason, 'shell-meta')
  assert.deepEqual(result.oracles, [])
})

await check('L2/L3 转为人工判据并落在正确的桶里', async () => {
  const result = compileAcceptance([
    { criterion: '汇总行可回溯', level: 'L2', check: '人工判断' },
    { criterion: '骨架一眼看清', level: 'L3', check: '人工判断' },
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(result.oracles.map((oracle) => oracle.id), ['L2-1', 'L3-1'])
  assert.deepEqual(result.oracles.map((oracle) => oracle.bucket), ['review', 'acceptance'])
  assert.equal(result.oracles.every((oracle) => oracle.manual === true), true)
})

await check('编译结果能直接冻结，无需人工搬运', async () => {
  const compiled = compileAcceptance([
    { criterion: '工具注册未被破坏', level: 'L0', check: 'node tests/validate-tools.mjs 退出码 0' },
    { criterion: '汇总行可回溯', level: 'L2', check: '人工判断' },
  ])
  assert.equal(compiled.ok, true)

  const dir = runDirOf(root, 'compile-e2e')
  const frozen = await freezeOracles(dir, {
    run_id: 'compile-e2e',
    root,
    oracles: compiled.oracles,
  })
  assert.equal(frozen.ok, true, `冻结失败：${JSON.stringify(frozen)}`)
  assert.equal(frozen.doc.oracles.length, 2)
  assert.equal(frozen.doc.oracles[0].argv[0], 'node')
  assert.equal(frozen.doc.oracles[1].manual, true)
})

await rm(root, { recursive: true, force: true })

console.log(`\n通过 ${passCount} 项，失败 ${failCount} 项`)
if (failCount > 0) process.exit(1)
console.log('执行内核单测全部通过')
