// 第 2 步端到端：经真实工具入口走 freeze → exec → gate → 改代码 → gate → 重跑 → gate。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerFreezeTool } from '../src/tools/freeze.js'
import { registerExecTool } from '../src/tools/exec.js'
import { registerGateTool } from '../src/tools/gate.js'
import { registerStatusTool } from '../src/tools/status.js'

// 测试不碰真实的 ~/.dsh/oracle-gate/hmac.key
process.env.ORACLE_GATE_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'og-key-')), 'hmac.key')

function host() {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  registerFreezeTool(ctx); registerExecTool(ctx); registerGateTool(ctx); registerStatusTool(ctx)
  return (name, args) => tools.get(name).execute(args)
}

test('改代码后旧回执失效、评审存档沿用、坏引用被拒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'og-e2e-'))
  const git = (...a) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  try {
    git('init', '-q')
    writeFileSync(join(root, '.gitignore'), '.protocol-kit/\n')
    writeFileSync(join(root, 'lib.js'), 'export const n = 1\n')
    git('add', '-A'); git('commit', '-qm', 'init')
    const call = host()
    const run_id = 'e2e-1'
    const frozen = await call('oracle_gate_freeze', { root, run_id, oracles: [
      { id: 'L0-a', level: 'L0', criterion: 'lib 可加载', argv: [process.execPath, '-e', "import('./lib.js').then(m=>console.log(JSON.stringify({n:m.n})))"], expect: { stdout_json: [{ path: 'n', op: '>=', value: 1 }] } },
      { id: 'L2-r', level: 'L2', criterion: '代码评审' },
    ] })
    assert.equal(frozen.ok, true, frozen.summary)

    const ex = await call('oracle_gate_exec', { root, run_id, oracle_id: 'L0-a' })
    assert.equal(ex.verdict, 'passed', ex.summary)
    const receipt = JSON.parse(readFileSync(ex.receipt_file, 'utf8'))
    assert.equal(receipt.code_fingerprint.kind, 'git')

    const bad = await call('oracle_gate_gate', { root, run_id, reviews: [{ oracle_id: 'L2-r', verdict: 'pass', evidence_refs: ['ghost.js:3'] }] })
    assert.equal(bad.verdict, 'rejected')
    assert.equal(bad.failed[0].reason, 'bad-evidence-refs')

    const good = await call('oracle_gate_gate', { root, run_id, reviews: [{ oracle_id: 'L2-r', verdict: 'pass', evidence_refs: ['lib.js:1', receipt.receipt_id] }] })
    assert.equal(good.verdict, 'pass', good.summary)

    const again = await call('oracle_gate_gate', { root, run_id })
    assert.equal(again.verdict, 'pass', '不传 reviews 时沿用存档')
    assert.deepEqual(again.reviews_from_archive, ['L2-r'])
    const st = await call('oracle_gate_status', { root, run_id })
    assert.equal(st.verdict, 'pass', 'status 与 gate 同口径')

    writeFileSync(join(root, 'lib.js'), 'export const n = 0\n')
    const after = await call('oracle_gate_gate', { root, run_id })
    assert.equal(after.verdict, 'insufficient-evidence', after.summary)
    assert.deepEqual(after.stale, ['L0-a'])
    assert.deepEqual(after.stale_reviews, ['L2-r'])

    const rerun = await call('oracle_gate_exec', { root, run_id, oracle_id: 'L0-a' })
    assert.equal(rerun.verdict, 'assertion-failed', '新代码 n=0 不满足 >=1')
    const final = await call('oracle_gate_gate', { root, run_id })
    assert.equal(final.verdict, 'rejected')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
