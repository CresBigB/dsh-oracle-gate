// kit_status 的语义测试：跑在真实的 run 目录上（.protocol-kit/inventory-dir-001），
// 覆盖三件事：
//   1. 人工判据的状态随 reviews 变化 —— 这是唯一有「真变量」的断言，不是恒真式。
//   2. 七桶预算内部自洽，且用 oracles.json 的 doc.budget 而不是 DEFAULT_BUDGET。
//   3. attempts 计数与回执文件数一致（重跑不是从账本推的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadOracles } from '../src/kernel/oracles.js'
import { readLedger } from '../src/kernel/ledger.js'
import { readReceipts } from '../src/kernel/receipt.js'
import { summarizeRunStatus, renderRunStatus } from '../src/kernel/status.js'

const ROOT = resolve('.')
const RUN_ID = 'inventory-dir-001'
const RUN_DIR = join(ROOT, '.protocol-kit', RUN_ID)

async function loadRun() {
  const loaded = await loadOracles(RUN_DIR)
  assert.equal(loaded.ok, true, `oracles.json 应可加载，实际 ${loaded.error}`)
  const ledger = await readLedger(RUN_DIR)
  const receipts = await readReceipts(RUN_DIR)
  return { doc: loaded.doc, entries: ledger.entries, receiptRead: receipts }
}

const hasRun = existsSync(join(RUN_DIR, 'oracles.json'))

test('人工判据：不传 reviews 时进 awaiting_human，传了之后不在', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const { doc, entries, receiptRead } = await loadRun()

  const without = summarizeRunStatus({
    doc,
    entries,
    receipts: receiptRead.receipts,
    receiptsTotal: receiptRead.files,
    skippedReceipts: receiptRead.skipped,
    reviews: [],
  })
  const manualIds = doc.oracles.filter((o) => o.manual === true).map((o) => o.id)
  assert.ok(manualIds.length > 0, '这个 run 应当有人工判据')
  for (const id of manualIds) {
    assert.equal(without.awaiting_human.includes(id), true, `不传 reviews 时 ${id} 应在待人工里`)
    assert.equal(without.passed.includes(id), false, `不传 reviews 时 ${id} 不该被算通过`)
  }

  // 只对第一条人工判据给结论，其余仍然「没传」—— 这个差值就是 reviews 的作用。
  const target = manualIds[0]
  const reviews = [{ oracle_id: target, verdict: 'pass', veto: false, unknowns: [], evidence_refs: ['src/kernel/status.js:1'] }]
  const withReview = summarizeRunStatus({
    doc,
    entries,
    receipts: receiptRead.receipts,
    receiptsTotal: receiptRead.files,
    skippedReceipts: receiptRead.skipped,
    reviews,
  })
  assert.equal(withReview.awaiting_human.includes(target), false, `传了 pass 之后 ${target} 不该还在等`)
  assert.equal(withReview.passed.includes(target), true, `传了 pass 之后 ${target} 应算通过`)
  assert.equal(withReview.reviews_given, 1)

  // 渲染层要能把「未传入评审」和「待评审」区分开，否则读者会以为有人在评。
  const text = renderRunStatus(without)
  assert.ok(text.includes('未传入评审'), '不传 reviews 时应明说未传入，而不是声称正在等人')
})

test('七桶预算内部自洽，且取自 doc.budget 而非默认值', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const { doc, entries, receiptRead } = await loadRun()
  const status = summarizeRunStatus({
    doc,
    entries,
    receipts: receiptRead.receipts,
    receiptsTotal: receiptRead.files,
    skippedReceipts: receiptRead.skipped,
  })

  const buckets = Object.keys(status.budget.limit).sort()
  assert.deepEqual(buckets, ['acceptance', 'design', 'evidence', 'execution', 'impl', 'infra', 'review'])
  for (const bucket of buckets) {
    const { limit, used, remaining } = status.budget
    assert.equal(limit[bucket], doc.budget[bucket], `${bucket} 的上限应等于 oracles.json 里的 doc.budget`)
    assert.equal(
      used[bucket] + remaining[bucket],
      limit[bucket],
      `${bucket}: used ${used[bucket]} + remaining ${remaining[bucket]} 应等于 ${limit[bucket]}`,
    )
    assert.ok(remaining[bucket] >= 0, `${bucket} 的剩余不该为负`)
  }
})

test('attempts 与回执一致：总和等于回执数，重跑计数大于 1 的判据真的有多份回执', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const { doc, entries, receiptRead } = await loadRun()
  const status = summarizeRunStatus({
    doc,
    entries,
    receipts: receiptRead.receipts,
    receiptsTotal: receiptRead.files,
    skippedReceipts: receiptRead.skipped,
  })

  const sum = status.items.reduce((acc, item) => acc + item.attempts, 0)
  assert.equal(sum, receiptRead.receipts.length, '每条回执都该被算进某条判据的 attempts')

  const retried = status.items.filter((item) => item.attempts > 1)
  for (const item of retried) {
    const n = receiptRead.receipts.filter((r) => r.oracle_id === item.id).length
    assert.equal(item.attempts, n, `${item.id}: attempts ${item.attempts} 应等于回执数 ${n}`)
  }

  // 每条判据都要出现，不能漏掉没跑过的。
  assert.equal(status.items.length, doc.oracles.length)
})

test('未冻结 / 被篡改时如实报错，不降级成「大概对」', async () => {
  const notFrozen = await loadOracles(join(ROOT, '.protocol-kit', '__does-not-exist__'))
  assert.equal(notFrozen.ok, false)
  assert.equal(notFrozen.error, 'not-frozen')
})

// ---- 渲染层：评审 L3-1 的三条 findings（2026-11-01）----
// 这几条不依赖真实 run，构造最小数据直接钉渲染文本。

function makeDoc() {
  const oracle = (id, level, bucket, extra = {}) => ({
    id,
    level,
    bucket,
    command: `node ${id}.js`,
    argv: ['node', `${id}.js`],
    expect: { exit_code: 0 },
    ...extra,
  })
  return {
    budget: { execution: 5, evidence: 1, design: 1, impl: 1, infra: 1, review: 1, acceptance: 1 },
    oracles: [
      oracle('A-pass', 'L0', 'execution'),
      oracle('B-fail', 'L0', 'execution'),
      oracle('C-timeout', 'L1', 'evidence'),
      { id: 'D-manual', level: 'L2', bucket: 'review', command: null, manual: true, expect: {} },
    ],
  }
}

function renderWith({ reviews = [], receipts } = {}) {
  const doc = makeDoc()
  const status = summarizeRunStatus({
    doc,
    entries: [],
    receipts: receipts ?? [
      { oracle_id: 'A-pass', exit_code: 0, expected_exit_code: 0, timed_out: false, duration_ms: 1 },
      { oracle_id: 'B-fail', exit_code: 1, expected_exit_code: 0, timed_out: false, duration_ms: 1 },
      { oracle_id: 'C-timeout', exit_code: null, expected_exit_code: 0, timed_out: true, duration_ms: 1 },
    ],
    receiptsTotal: 3,
    skippedReceipts: 0,
    reviews,
  })
  return { status, text: renderRunStatus(status) }
}

test('L3-1-F1：通过判据的 id 必须出现在文本里（只给计数等于没答「哪些过了」）', () => {
  const { text } = renderWith()
  assert.match(text, /已通过：.*A-pass/, '「已通过」行要列出通过的判据 id')
  // 一条通过、其余全异常时，也要能看到是哪一条过了。
  const { text: onlyOne } = renderWith({ receipts: [
    { oracle_id: 'A-pass', exit_code: 0, expected_exit_code: 0, timed_out: false, duration_ms: 1 },
  ] })
  assert.match(onlyOne, /已通过：A-pass/)
})

test('L3-1-F2：失败项要能分辨「超时」与「退出码不对」', () => {
  const { text } = renderWith()
  assert.match(text, /B-fail L0 失败（退出码 1）/, '退出码不符要写出真实退出码')
  assert.match(text, /C-timeout L1 失败（超时）/, '超时不能和退出码不符渲染成同一行')
})

test('L3-1-F3：note 不能说「没人评」，只能说「没有评审结论传入」', () => {
  const { text } = renderWith()
  assert.doesNotMatch(text, /没人评：/, 'reviews 不落盘，gate 无从知道历史上有没有人评过')
  assert.match(text, /没有评审结论传入/)
  assert.match(text, /未传入不等于没人评过/)
})
