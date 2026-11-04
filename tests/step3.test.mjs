// 第 3 步：HMAC 签名（回执 / 账本链 / 评审存档）与 lock_paths。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signRecord, verifyRecord, loadKey } from '../src/kernel/signing.js'
import { lockedFiles } from '../src/kernel/oracles.js'

const KEY_DIR = mkdtempSync(join(tmpdir(), 'og-key3-'))
process.env.ORACLE_GATE_KEY_FILE = join(KEY_DIR, 'hmac.key')

const { registerFreezeTool } = await import('../src/tools/freeze.js')
const { registerExecTool } = await import('../src/tools/exec.js')
const { registerGateTool } = await import('../src/tools/gate.js')
const { registerStatusTool } = await import('../src/tools/status.js')

function host() {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  registerFreezeTool(ctx); registerExecTool(ctx); registerGateTool(ctx); registerStatusTool(ctx)
  return (name, args) => tools.get(name).execute(args)
}

const PASS = { argv: [process.execPath, '-e', 'process.exit(0)'] }

test('签名：改任一字段即验不过；密钥自动生成且 key_id 稳定', () => {
  const a = loadKey({ file: process.env.ORACLE_GATE_KEY_FILE })
  const b = loadKey({ file: process.env.ORACLE_GATE_KEY_FILE })
  assert.equal(a.key_id, b.key_id)
  const rec = signRecord(a.key, { x: 1, y: 'z' })
  assert.equal(verifyRecord(a.key, rec), true)
  assert.equal(verifyRecord(a.key, { ...rec, x: 2 }), false)
  assert.equal(verifyRecord(a.key, { x: 1, y: 'z' }), false)
})

test('签名 run：伪造回执不采信、删账本行被发现、塞存档 pass 不算数', async () => {
  const root = mkdtempSync(join(tmpdir(), 'og-s3-'))
  try {
    const call = host()
    const run_id = 's3'
    const frozen = await call('oracle_gate_freeze', { root, run_id, oracles: [
      { id: 'L0-a', level: 'L0', criterion: 'a', ...PASS },
      { id: 'L0-b', level: 'L0', criterion: 'b', argv: [process.execPath, '-e', 'process.exit(1)'] },
      { id: 'L2-r', level: 'L2', criterion: '评审' },
    ] })
    assert.equal(frozen.ok, true, frozen.summary)
    const runDir = frozen.run_dir
    const doc = JSON.parse(readFileSync(join(runDir, 'oracles.json'), 'utf8'))
    assert.match(doc.signing.key_id, /^kid:/)

    assert.equal((await call('oracle_gate_exec', { root, run_id, oracle_id: 'L0-a' })).verdict, 'passed')
    const exB = await call('oracle_gate_exec', { root, run_id, oracle_id: 'L0-b' })
    assert.equal(exB.verdict, 'failed')

    // 1) 把 L0-b 的失败回执改成退出码 0：签名不符 → 不采信 → 按未跑
    const file = exB.receipt_file
    const forged = JSON.parse(readFileSync(file, 'utf8'))
    forged.exit_code = 0
    writeFileSync(file, JSON.stringify(forged))
    // 2) 往评审存档里手写一条 pass
    writeFileSync(join(runDir, 'reviews.jsonl'), JSON.stringify({ oracle_id: 'L2-r', verdict: 'pass', veto: false, unknowns: [], evidence_refs: [] }) + '\n')

    const g = await call('oracle_gate_gate', { root, run_id })
    assert.equal(g.tampered.receipts, 1)
    assert.equal(g.tampered.reviews, 1)
    assert.ok(g.missing.includes('L0-b'), JSON.stringify(g.missing))
    assert.notEqual(g.verdict, 'pass')

    // 3) 删掉账本第一行：链断 → exec 拒绝、gate 判 rejected
    const ledgerFile = join(runDir, 'ledger.jsonl')
    const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean)
    writeFileSync(ledgerFile, lines.slice(1).join('\n') + '\n')
    const ex2 = await call('oracle_gate_exec', { root, run_id, oracle_id: 'L0-a' })
    assert.equal(ex2.ok, false)
    assert.match(ex2.summary, /账本/)
    const g2 = await call('oracle_gate_gate', { root, run_id })
    assert.equal(g2.verdict, 'rejected')
    assert.ok(g2.tampered.ledger > 0)
    const st = await call('oracle_gate_status', { root, run_id })
    assert.equal(st.verdict, 'rejected')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('签名 run：换了密钥 → 拒绝执行（signing-key-mismatch）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'og-s3k-'))
  const saved = process.env.ORACLE_GATE_KEY_FILE
  try {
    const call = host()
    const frozen = await call('oracle_gate_freeze', { root, run_id: 'k', oracles: [{ id: 'L0-a', level: 'L0', criterion: 'a', ...PASS }] })
    assert.equal(frozen.ok, true)
    process.env.ORACLE_GATE_KEY_FILE = join(KEY_DIR, 'other.key')
    loadKey({ file: process.env.ORACLE_GATE_KEY_FILE })
    const ex = await call('oracle_gate_exec', { root, run_id: 'k', oracle_id: 'L0-a' })
    assert.equal(ex.ok, false)
    assert.match(ex.summary, /不是同一把/)
  } finally {
    process.env.ORACLE_GATE_KEY_FILE = saved
    rmSync(root, { recursive: true, force: true })
  }
})

test('lock_paths：目录递归锁定，改被 import 的模块后拒绝执行；越界/不存在在冻结时报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'og-lock-'))
  try {
    mkdirSync(join(root, 'lib', 'sub'), { recursive: true })
    mkdirSync(join(root, 'lib', 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'lib', 'a.js'), 'export const a = 1\n')
    writeFileSync(join(root, 'lib', 'sub', 'b.js'), 'export const b = 2\n')
    writeFileSync(join(root, 'lib', 'node_modules', 'x.js'), '')
    const locked = lockedFiles(root, ['lib'])
    assert.equal(locked.ok, true)
    assert.deepEqual(locked.files.map((f) => f.path).sort(), ['lib/a.js', 'lib/sub/b.js'])
    assert.equal(lockedFiles(root, ['..']).error, 'lock-path-outside-root')
    assert.equal(lockedFiles(root, ['nope']).error, 'lock-path-not-found')
    assert.equal(lockedFiles(root, 'lib').error, 'bad-lock-paths')

    const call = host()
    const dry = await call('oracle_gate_freeze', { root, run_id: 'l0', dry_run: true, oracles: [{ id: 'L0-a', level: 'L0', criterion: 'a', ...PASS, lock_paths: ['missing-dir'] }] })
    assert.ok(dry.issues.some((issue) => JSON.stringify(issue).includes('lock-path-not-found')), JSON.stringify(dry.issues))

    const frozen = await call('oracle_gate_freeze', { root, run_id: 'l1', oracles: [{ id: 'L0-a', level: 'L0', criterion: 'a', ...PASS, lock_paths: ['lib'] }] })
    assert.equal(frozen.ok, true, frozen.summary)
    assert.deepEqual(frozen.oracles[0].lock_paths, ['lib'])
    assert.equal((await call('oracle_gate_exec', { root, run_id: 'l1', oracle_id: 'L0-a' })).verdict, 'passed')
    writeFileSync(join(root, 'lib', 'sub', 'b.js'), 'export const b = 3\n')
    const ex = await call('oracle_gate_exec', { root, run_id: 'l1', oracle_id: 'L0-a' })
    assert.equal(ex.ok, false)
    assert.match(ex.summary, /lib\/sub\/b\.js/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('旧 run（oracles.json 无 signing）照旧可用，不验签', async () => {
  const { freezeOracles } = await import('../src/kernel/oracles.js')
  const root = mkdtempSync(join(tmpdir(), 'og-old-'))
  try {
    const runDir = join(root, '.protocol-kit', 'old')
    const fr = await freezeOracles(runDir, { root, run_id: 'old', budget: { execution: 5 }, oracles: [{ id: 'L0-a', level: 'L0', criterion: 'a', ...PASS }] })
    assert.equal(fr.ok, true)
    assert.equal(fr.doc.signing, undefined)
    const call = host()
    assert.equal((await call('oracle_gate_exec', { root, run_id: 'old', oracle_id: 'L0-a' })).verdict, 'passed')
    const g = await call('oracle_gate_gate', { root, run_id: 'old' })
    assert.equal(g.verdict, 'pass', JSON.stringify(g))
    const receiptDir = join(runDir, 'receipts')
    const rec = JSON.parse(readFileSync(join(receiptDir, readdirSync(receiptDir)[0]), 'utf8'))
    assert.equal(rec.sig, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.ok(existsSync(process.env.ORACLE_GATE_KEY_FILE))
})
