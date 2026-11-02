// 紧凑性度量：kit_status 的价值就是「别让人翻三个文件」，所以它的输出必须显著比
// 三个文件加起来短。否则它只是第四个要读的文件。
//
// 两个上界：
//   - 绝对上界 2500 字符（超过就不是「一眼看完」）；
//   - 相对上界：不超过三源总字符的 15%。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadOracles } from '../src/kernel/oracles.js'
import { readLedger } from '../src/kernel/ledger.js'
import { readReceipts } from '../src/kernel/receipt.js'
import { renderRunStatus, summarizeRunStatus } from '../src/kernel/status.js'

const ROOT = resolve('.')
const RUN_ID = 'inventory-dir-001'
const RUN_DIR = join(ROOT, '.protocol-kit', RUN_ID)
const hasRun = existsSync(join(RUN_DIR, 'oracles.json'))

const ABSOLUTE_LIMIT = 2500
const RELATIVE_LIMIT = 0.15

test('输出不超过 2500 字符，且不超过三源总字符的 15%', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const loaded = await loadOracles(RUN_DIR)
  assert.equal(loaded.ok, true)
  const ledger = await readLedger(RUN_DIR)
  const receipts = await readReceipts(RUN_DIR)

  const status = summarizeRunStatus({
    doc: loaded.doc,
    entries: ledger.entries,
    receipts: receipts.receipts,
    receiptsTotal: receipts.files,
    skippedReceipts: receipts.skipped,
  })
  const text = renderRunStatus(status)

  assert.ok(text.length <= ABSOLUTE_LIMIT, `输出 ${text.length} 字符，超过 ${ABSOLUTE_LIMIT}`)

  // 三源：oracles.json + ledger.jsonl + 每份回执，按实际字节读。
  const receiptDir = join(RUN_DIR, 'receipts')
  const receiptChars = existsSync(receiptDir)
    ? readdirSync(receiptDir)
        .filter((name) => name.endsWith('.json'))
        .reduce((acc, name) => acc + statSync(join(receiptDir, name)).size, 0)
    : 0
  const totalSources = statSync(join(RUN_DIR, 'oracles.json')).size
    + statSync(join(RUN_DIR, 'ledger.jsonl')).size
    + receiptChars

  const ratio = text.length / totalSources
  assert.ok(
    ratio <= RELATIVE_LIMIT,
    `输出 ${text.length} / 三源 ${totalSources} = ${(ratio * 100).toFixed(1)}%，超过 ${RELATIVE_LIMIT * 100}%`,
  )
})

test('超限时显式写「还有 N 条未显示」，不静默截断', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const loaded = await loadOracles(RUN_DIR)
  const ledger = await readLedger(RUN_DIR)
  const receipts = await readReceipts(RUN_DIR)
  const status = summarizeRunStatus({
    doc: loaded.doc,
    entries: ledger.entries,
    receipts: receipts.receipts,
    receiptsTotal: receipts.files,
    skippedReceipts: receipts.skipped,
  })

  const tiny = renderRunStatus(status, { limit: 1 })
  const interesting = status.items.filter((i) => i.state !== '通过' || i.attempts > 1 || i.manual)
  if (interesting.length > 1) {
    assert.ok(tiny.includes('还有'), '把 limit 压到 1 时必须显式说明被省略的条数')
  }
})

test('大 run 也不会爆：一千条判据的渲染仍在 2500 字符内', async () => {
  // 合成一个大 run，确认「只列异常项 + 上限」的策略在极端情况下成立。
  const doc = {
    budget: { execution: 100, evidence: 24, design: 8, impl: 8, infra: 8, review: 12, acceptance: 1 },
    oracles: Array.from({ length: 1000 }, (_, i) => ({
      id: `L0-${i}`,
      level: 'L0',
      criterion: `第 ${i} 条`,
      command: 'node -e 0',
      argv: ['node', '-e', '0'],
      cwd: '.',
      manual: false,
      bucket: 'execution',
    })),
  }
  const receipts = doc.oracles.slice(0, 400).map((o) => ({
    oracle_id: o.id,
    exit_code: 0,
    expected_exit_code: 0,
    timed_out: false,
    spawn_error: null,
  }))
  const status = summarizeRunStatus({ doc, entries: [], receipts, receiptsTotal: receipts.length })
  const text = renderRunStatus(status)
  assert.ok(text.length <= ABSOLUTE_LIMIT, `1000 条判据时输出 ${text.length} 字符，超过 ${ABSOLUTE_LIMIT}`)
  assert.ok(text.includes('还有'), '应显式说明被省略的条数')
})
