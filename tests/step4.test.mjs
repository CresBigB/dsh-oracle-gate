// 第 4 步：轻量模式 oracle_gate_check、自动推荐判据、预算简写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { suggestOracles } from '../src/kernel/suggest.js'
import { normalizeBudget, DEFAULT_BUDGET } from '../src/kernel/ledger.js'

process.env.ORACLE_GATE_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'og-key4-')), 'hmac.key')
const { registerCheckTool } = await import('../src/tools/check.js')
const { registerStatusTool } = await import('../src/tools/status.js')

function host() {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  registerCheckTool(ctx); registerStatusTool(ctx)
  return (name, args) => tools.get(name).execute(args)
}

// 让推荐出来的 npm 命令指向一个可控的假 npm（PATH 里只放它），避免依赖真实 npm。
function fakeNpmEnv(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "%~dp0npm.mjs" %*\r\n`)
  } else {
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/npm.mjs" "$@"\n`, { mode: 0o755 })
  }
  // 假 npm：run test 成功，run build 失败
  writeFileSync(join(bin, 'npm.mjs'), "const s = process.argv[3]; console.log('fake npm run ' + s); process.exit(s === 'build' ? 3 : 0)\n")
  return bin
}

test('suggestOracles：只推荐项目已声明的检查，跳过 npm 占位 test', () => {
  const root = mkdtempSync(join(tmpdir(), 'og-sg-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .', typecheck: 'tsc -p .', start: 'node .' } }))
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'go.mod'), 'module x\n')
    const ids = suggestOracles(root).map((item) => item.id)
    assert.deepEqual(ids, ['L0-typecheck', 'L0-lint', 'L0-go-test'])
    const tc = suggestOracles(root)[0]
    assert.deepEqual(tc.argv, ['npm', 'run', 'typecheck'])
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    assert.equal(suggestOracles(root)[0].argv[0], 'pnpm')
    const missing = suggestOracles(root, { env: { PATH: '' } })
    assert.ok(missing.every((item) => item.available === false))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeBudget：数字简写 = execution 上限', () => {
  assert.deepEqual(normalizeBudget(5), { ...DEFAULT_BUDGET, execution: 5 })
  assert.deepEqual(normalizeBudget('7'), { ...DEFAULT_BUDGET, execution: 7 })
  assert.deepEqual(normalizeBudget(undefined), DEFAULT_BUDGET)
})

test('oracle_gate_check：自动推荐 → 冻结 → 执行 → 裁决一次完成', async () => {
  const root = mkdtempSync(join(tmpdir(), 'og-ck-'))
  const savedPath = process.env.PATH
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y' } }))
    process.env.PATH = fakeNpmEnv(mkdtempSync(join(tmpdir(), 'og-npm-'))) + (process.platform === 'win32' ? ';' : ':') + dirname(process.execPath) + (process.platform === 'win32' ? ';C:\\Windows\\System32' : '')
    const call = host()
    const out = await call('oracle_gate_check', { root, run_id: 'ck1' })
    assert.equal(out.ok, true, out.summary)
    assert.equal(out.suggested, true)
    assert.deepEqual(out.results.map((r) => [r.oracle_id, r.verdict]), [['L0-test', 'passed'], ['L0-build', 'failed']])
    assert.equal(out.verdict, 'rejected')
    const st = await call('oracle_gate_status', { root, run_id: 'ck1' })
    assert.equal(st.verdict, 'rejected')
    // 同一 run_id 不能再冻结
    const again = await call('oracle_gate_check', { root, run_id: 'ck1' })
    assert.equal(again.ok, false)
  } finally {
    process.env.PATH = savedPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('oracle_gate_check：手写判据 + 人工评审 + 预算简写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'og-ck2-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'hello\n')
    const call = host()
    const oracles = [
      { id: 'L0-ok', level: 'L0', criterion: 'ok', argv: [process.execPath, '-e', 'console.log(JSON.stringify({n:3}))'], expect: { exit_code: 0, stdout_json: [{ path: 'n', op: '>=', value: 3 }] } },
      { id: 'L2-r', level: 'L2', criterion: '评审' },
    ]
    const pending = await call('oracle_gate_check', { root, run_id: 'm1', oracles, budget: 3 })
    assert.equal(pending.ok, true, pending.summary)
    assert.equal(pending.verdict, 'blocked-on-human')
    const done = await call('oracle_gate_check', {
      root, run_id: 'm2', oracles, budget: 3,
      reviews: [{ oracle_id: 'L2-r', verdict: 'pass', veto: false, unknowns: [], evidence_refs: ['a.txt:1'] }],
    })
    assert.equal(done.verdict, 'pass', JSON.stringify(done.gate))
    const none = await call('oracle_gate_check', { root, run_id: 'm3' })
    assert.equal(none.ok, false)
    assert.equal(none.error, 'no-suggestions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
