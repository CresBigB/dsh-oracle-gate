// 第 2 步：回执绑定代码版本指纹、评审 evidence_refs 校验、评审存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeFingerprint, freshnessOf } from '../src/kernel/fingerprint.js'
import { makeRefChecker } from '../src/kernel/evidence.js'
import { appendReviews, readReviews, mergeReviews } from '../src/kernel/reviews.js'
import { evaluateGate } from '../src/kernel/gate.js'

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'og-step2-'))
  const git = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(root, 'a.js'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { root, git }
}

const doc = {
  oracles: [
    { id: 'L0-a', level: 'L0', manual: false },
    { id: 'L2-r', level: 'L2', manual: true },
  ],
}

test('指纹：改已跟踪文件、加新文件都会变；.protocol-kit 下的产物不影响', () => {
  const { root } = repo()
  try {
    const f0 = codeFingerprint(root)
    assert.equal(f0.kind, 'git')
    assert.equal(f0.dirty, false)
    mkdirSync(join(root, '.protocol-kit', 'r1'), { recursive: true })
    writeFileSync(join(root, '.protocol-kit', 'r1', 'x.json'), '{}')
    assert.equal(codeFingerprint(root).value, f0.value, '协议产物不能改变指纹')
    writeFileSync(join(root, 'a.js'), 'changed\n')
    const f1 = codeFingerprint(root)
    assert.notEqual(f1.value, f0.value)
    assert.equal(f1.dirty, true)
    writeFileSync(join(root, 'a.js'), 'one\ntwo\nthree\n')
    assert.equal(codeFingerprint(root).value, f0.value, '改回原样指纹应复原')
    writeFileSync(join(root, 'new.js'), 'x')
    assert.notEqual(codeFingerprint(root).value, f0.value)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('指纹：非 git 目录返回 none，新鲜度为 unchecked', () => {
  const root = mkdtempSync(join(tmpdir(), 'og-nogit-'))
  try {
    const f = codeFingerprint(root)
    assert.equal(f.kind, 'none')
    assert.equal(freshnessOf({ value: 'sha256:x' }, f), 'unchecked')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('freshnessOf：匹配执行前或执行后的指纹都算新鲜；旧回执无指纹为 unchecked', () => {
  const cur = { value: 'sha256:b' }
  assert.equal(freshnessOf({ value: 'sha256:a', after: 'sha256:b' }, cur), 'fresh')
  assert.equal(freshnessOf({ value: 'sha256:b' }, cur), 'fresh')
  assert.equal(freshnessOf({ value: 'sha256:a', after: 'sha256:c' }, cur), 'stale')
  assert.equal(freshnessOf(undefined, cur), 'unchecked')
})

test('gate：回执对应旧代码时按「未跑」处理，不再算通过', () => {
  const receipts = [{ oracle_id: 'L0-a', exit_code: 0, expected_exit_code: 0, timed_out: false, spawn_error: null, assertions: [], code_fingerprint: { value: 'sha256:old' } }]
  const reviews = [{ oracle_id: 'L2-r', verdict: 'pass', evidence_refs: ['x'] }]
  const fresh = evaluateGate({ doc, receipts, reviews, fingerprint: { value: 'sha256:old' } })
  assert.equal(fresh.verdict, 'pass')
  const stale = evaluateGate({ doc, receipts, reviews, fingerprint: { value: 'sha256:new' } })
  assert.equal(stale.verdict, 'insufficient-evidence')
  assert.deepEqual(stale.stale, ['L0-a'])
  const legacy = evaluateGate({ doc, receipts, reviews })
  assert.equal(legacy.verdict, 'pass', '不给指纹时与旧行为一致')
})

test('evidence_refs：文件、行号范围、回执 id 都要真实存在；URL 与自由文本无效', () => {
  const { root } = repo()
  try {
    const check = makeRefChecker(root, { receiptIds: new Set(['rcpt_3_L0-a']) })
    assert.equal(check('a.js').ok, true)
    assert.equal(check('a.js:2').ok, true)
    assert.equal(check('a.js:1-3').ok, true)
    assert.equal(check('a.js:4').ok, false, '只有 3 行')
    assert.equal(check('a.js:3-2').ok, false)
    assert.equal(check('nope.js').ok, false)
    assert.equal(check('../outside.js').ok, false)
    assert.equal(check(join(root, 'a.js') + ':1').ok, true, '绝对路径（含 Windows 盘符）也认')
    assert.equal(check('rcpt_3_L0-a').ok, true)
    assert.equal(check('rcpt_9_L0-a').ok, false)
    assert.equal(check('https://example.com/a').ok, false)
    assert.equal(check('看过了，没问题').ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gate：评审引用无效证据时判 bad-evidence-refs，不准入', () => {
  const { root } = repo()
  try {
    const checkRef = makeRefChecker(root)
    const receipts = [{ oracle_id: 'L0-a', exit_code: 0, expected_exit_code: 0, timed_out: false, spawn_error: null, assertions: [] }]
    const bad = evaluateGate({ doc, receipts, checkRef, reviews: [{ oracle_id: 'L2-r', verdict: 'pass', evidence_refs: ['a.js:1', 'ghost.ts:9'] }] })
    assert.equal(bad.verdict, 'rejected')
    assert.equal(bad.failed[0].reason, 'bad-evidence-refs')
    assert.equal(bad.bad_evidence_refs[0].refs[0].ref, 'ghost.ts:9')
    const good = evaluateGate({ doc, receipts, checkRef, reviews: [{ oracle_id: 'L2-r', verdict: 'pass', evidence_refs: ['a.js:1-2'] }] })
    assert.equal(good.verdict, 'pass')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('评审存档：追加落盘；合并时本次传入优先、存档沿用最新一条、旧代码的存档不采信', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'og-rev-'))
  try {
    await appendReviews(runDir, [{ oracle_id: 'L2-r', verdict: 'fail', evidence_refs: ['a'] }], { value: 'sha256:v1' })
    await appendReviews(runDir, [{ oracle_id: 'L2-r', verdict: 'pass', evidence_refs: ['b'] }], { value: 'sha256:v1' })
    const { reviews } = await readReviews(runDir)
    assert.equal(reviews.length, 2, '只追加不改写')
    const m1 = mergeReviews({ passed: [], archived: reviews, fingerprint: { value: 'sha256:v1' } })
    assert.equal(m1.reviews[0].verdict, 'pass')
    assert.deepEqual(m1.from_archive, ['L2-r'])
    const m2 = mergeReviews({ passed: [], archived: reviews, fingerprint: { value: 'sha256:v2' } })
    assert.equal(m2.reviews.length, 0)
    assert.deepEqual(m2.stale_reviews, ['L2-r'])
    const m3 = mergeReviews({ passed: [{ oracle_id: 'L2-r', verdict: 'fail' }], archived: reviews, fingerprint: { value: 'sha256:v1' } })
    assert.equal(m3.reviews[0].verdict, 'fail')
    assert.deepEqual(m3.from_archive, [])
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})
