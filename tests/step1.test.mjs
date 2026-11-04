// 第 1 步改进的回归测试：Windows .cmd 执行、argv 数组、输出断言、冻结预检。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateOracle, freezeOracles } from '../src/kernel/oracles.js'
import { executeOracle, verdictOf } from '../src/kernel/receipt.js'
import { buildSpawnPlan, resolveExecutable } from '../src/kernel/command.js'
import { validateExpect, evaluateExpect } from '../src/kernel/expect.js'

const node = process.execPath
const base = { level: 'L0', criterion: 'c', timeout_ms: 20000 }

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'og-step1-'))
}

async function run(root, raw) {
  const check = validateOracle(raw, root)
  assert.equal(check.ok, true, JSON.stringify(check))
  const oracle = { ...raw, argv: check.argv, expect: check.expect, cwd: '.', timeout_ms: raw.timeout_ms }
  const receipt = await executeOracle({ root, oracle })
  return { receipt, verdict: verdictOf(receipt) }
}

test('argv 数组：参数里的 & 和空格原样传给进程，不被注入或拆开', async () => {
  const root = sandbox()
  try {
    const raw = { ...base, id: 'a', argv: [node, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a & b', 'x"y'] }
    const { receipt, verdict } = await run(root, raw)
    assert.equal(verdict, 'passed')
    assert.deepEqual(JSON.parse(receipt.stdout_head.trim()), ['a & b', 'x"y'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('argv 里单独出现 && 被拒绝；command 文本含 & 仍被拒绝', () => {
  assert.equal(validateOracle({ ...base, id: 'a', argv: [node, 'x', '&&', 'y'] }, process.cwd()).error, 'shell-meta-not-allowed')
  assert.equal(validateOracle({ ...base, id: 'a', command: 'node a & b' }, process.cwd()).error, 'shell-meta-not-allowed')
  assert.equal(validateOracle({ ...base, id: 'a', argv: 'node x' }, process.cwd()).error, 'bad-argv')
})

test('冻结预检：找不到命令、未知 expect 字段、坏正则都直接拒绝', () => {
  const cwd = process.cwd()
  assert.equal(validateOracle({ ...base, id: 'a', command: 'no-such-cmd-xyz123 run' }, cwd).error, 'command-not-found')
  assert.equal(validateOracle({ ...base, id: 'a', command: 'node -v', expect: { exit: 0 } }, cwd).error, 'unknown-expect-key')
  assert.equal(validateOracle({ ...base, id: 'a', command: 'node -v', expect: { stdout_matches: '(' } }, cwd).error, 'bad-regex')
  assert.equal(validateOracle({ ...base, id: 'a', command: 'no-such-cmd-xyz123' }, cwd, { preflight: false }).ok, true)
})

test('freezeOracles 冻结完整 expect，并从 argv 生成可读 command', async () => {
  const root = sandbox()
  try {
    const expect = { exit_code: 0, stdout_includes: ['ok'], stdout_json: [{ path: 'n', op: '>=', value: 1 }] }
    const frozen = await freezeOracles(join(root, '.run'), { root, run_id: 'r', budget: {}, oracles: [{ ...base, id: 'a', argv: [node, '-v'], expect }] })
    assert.equal(frozen.ok, true, JSON.stringify(frozen))
    const o = frozen.doc.oracles[0]
    assert.deepEqual(o.expect.stdout_includes, ['ok'])
    assert.equal(o.expect.stdout_json.length, 1)
    assert.ok(o.command.includes('-v'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('输出断言：退出码 0 但输出不符时判 assertion-failed', async () => {
  const root = sandbox()
  try {
    const script = 'console.log(JSON.stringify({summary:{failed:2,passed:5}}))'
    const ok = await run(root, { ...base, id: 'a', argv: [node, '-e', script], expect: { stdout_json: [{ path: 'summary.passed', op: '>=', value: 5 }], stdout_includes: 'passed' } })
    assert.equal(ok.verdict, 'passed')
    const bad = await run(root, { ...base, id: 'b', argv: [node, '-e', script], expect: { stdout_json: [{ path: 'summary.failed', op: '==', value: 0 }] } })
    assert.equal(bad.verdict, 'assertion-failed')
    assert.ok(bad.receipt.assertions.some((item) => item.ok === false))
    const ex = await run(root, { ...base, id: 'c', argv: [node, '-e', 'console.log("ERROR boom")'], expect: { stdout_excludes: 'ERROR' } })
    assert.equal(ex.verdict, 'assertion-failed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('输出哈希覆盖完整输出（大于捕获上限时字节数仍准确）', async () => {
  const root = sandbox()
  try {
    const { receipt } = await run(root, { ...base, id: 'a', argv: [node, '-e', 'process.stdout.write("x".repeat(200000))'] })
    assert.equal(receipt.stdout_bytes, 200000)
    assert.equal(receipt.stdout_truncated, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('超时：杀掉进程，判 timed-out', async () => {
  const root = sandbox()
  try {
    const { verdict } = await run(root, { ...base, id: 'a', argv: [node, '-e', 'setInterval(()=>{},1000)'], timeout_ms: 1000 })
    assert.equal(verdict, 'timed-out')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expect 校验与求值的边界', () => {
  assert.equal(validateExpect(undefined).ok, true)
  assert.equal(validateExpect([]).ok, false)
  assert.equal(validateExpect({ exit_code: 1.5 }).ok, false)
  const e = validateExpect({ stdout_includes: 'a' }).expect
  assert.ok(evaluateExpect(e, { stdout: 'a'.repeat(10), truncated: { stdout: true } }).some((item) => !item.ok), '截断时不能判通过')
})

test('Windows：.cmd 脚本经 cmd.exe 执行，参数里的 & 被转义', { skip: process.platform !== 'win32' }, async () => {
  const root = sandbox()
  try {
    // 用 %* 原样转交给 node（npx.cmd 等 shim 也是这么写的）。批处理内部若写 echo %~1，
    // 批处理自己会再展开一次 &——那是 .cmd 文件本身的缺陷，调用方无法替它兜底。
    writeFileSync(join(root, 'echoargs.cmd'), '@echo off' + String.fromCharCode(13, 10) + '"' + node + '" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*' + String.fromCharCode(13, 10))
    const plan = buildSpawnPlan(['echoargs', 'a & whoami'], { cwd: root, env: { ...process.env, PATH: root + ';' + process.env.PATH } })
    assert.equal(plan.ok, true)
    assert.equal(plan.via, 'cmd.exe')
    const env = { ...process.env, PATH: root + ';' + (process.env.PATH ?? process.env.Path) }
    const receipt = await executeOracle({ root, env, oracle: { id: 'a', level: 'L0', argv: ['echoargs', 'a & whoami'], cwd: '.', timeout_ms: 20000, expect: { exit_code: 0, stdout_json: [{ path: '0', op: '==', value: 'a & whoami' }] } } })
    assert.equal(verdictOf(receipt), 'passed', receipt.stdout_head + receipt.stderr_head)
    assert.equal(resolveExecutable('npx').ok, true, 'npx 应能解析到 npx.cmd')
    const npx = await executeOracle({ root, oracle: { id: 'b', level: 'L0', argv: ['npx', '--version'], cwd: '.', timeout_ms: 60000, expect: { exit_code: 0 } } })
    assert.equal(verdictOf(npx), 'passed', npx.spawn_error ?? npx.stderr_head)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
