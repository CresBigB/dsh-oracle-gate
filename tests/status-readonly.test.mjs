// 只读性：kit_status 的整个价值前提是「看一眼不会改变任何东西」。
// 一旦它偷偷 reserve 一次预算，观看行为就会消耗额度；一旦它写回执，
// 「跑了 N 次」就会被自己的查询次数污染。
//
// 这里不读源码证明「没有 fs 调用」，而是比对调用前后的字节级事实 —— 行为证据
// 比意图证据可靠。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

function snapshot() {
  const ledgerPath = join(RUN_DIR, 'ledger.jsonl')
  const ledgerBytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.from('')
  const receiptDir = join(RUN_DIR, 'receipts')
  const receiptFiles = existsSync(receiptDir)
    ? readdirSync(receiptDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({
          name,
          mtime: statSync(join(receiptDir, name)).mtimeMs,
          size: statSync(join(receiptDir, name)).size,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    : []
  return {
    ledgerSha256: createHash('sha256').update(ledgerBytes).digest('hex'),
    ledgerLines: ledgerBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length,
    oraclesSha256: createHash('sha256').update(readFileSync(join(RUN_DIR, 'oracles.json'))).digest('hex'),
    receiptFiles,
  }
}

async function callStatusOnce() {
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
    reviews: [{ oracle_id: 'L2-1', verdict: 'pass', veto: false, unknowns: [], evidence_refs: ['x:1'] }],
  })
  return { status, text: renderRunStatus(status) }
}

test('连查三次后：ledger 字节与行数不变、oracles.json 不变、回执文件数与 mtime 不变', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const before = snapshot()

  const results = []
  for (let i = 0; i < 3; i += 1) results.push(await callStatusOnce())

  const after = snapshot()

  assert.equal(after.ledgerSha256, before.ledgerSha256, 'ledger.jsonl 内容被改了')
  assert.equal(after.ledgerLines, before.ledgerLines, 'ledger.jsonl 行数变了（说明写了新条目）')
  assert.equal(after.oraclesSha256, before.oraclesSha256, 'oracles.json 被改了')
  assert.equal(after.receiptFiles.length, before.receiptFiles.length, '回执文件数变了（说明写了新回执）')
  for (let i = 0; i < before.receiptFiles.length; i += 1) {
    assert.equal(after.receiptFiles[i].mtime, before.receiptFiles[i].mtime, `${before.receiptFiles[i].name} 的 mtime 变了`)
    assert.equal(after.receiptFiles[i].size, before.receiptFiles[i].size, `${before.receiptFiles[i].name} 的大小变了`)
  }
})

test('重复查询得到相同结果（不含隐藏的时间戳或随机量）', { skip: !hasRun && '缺少 inventory-dir-001' }, async () => {
  const a = await callStatusOnce()
  const b = await callStatusOnce()
  assert.equal(a.text, b.text, '两次查询的输出应完全一致；不一致说明混进了时间或随机值')
  assert.equal(a.status.verdict, b.status.verdict)
  assert.deepEqual(a.status.budget, b.status.budget)
})
