/**
 * 判据文件内容锁：冻结的不只是命令文本，还有命令点到的那些文件。
 *
 * 起因：`check-numeric.mjs` 里改一句断言就能让判定翻转，而 `oracles.json` 的
 * 哈希校验只覆盖 JSON 文本，对脚本内容的变化完全看不见。于是「冻结即不可改」
 * 只在文本层面成立。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freezeOracles, filesOfCommand, verifyFiles } from '../src/kernel/oracles.js'

let passed = 0
let failed = 0

function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ✓ ${label}`)
    })
    .catch((error) => {
      failed += 1
      console.log(`  ✗ ${label}`)
      console.log(`    ${error instanceof Error ? error.message : String(error)}`)
    })
}

const BUDGET = { execution: 10, evidence: 4, design: 0, impl: 0, infra: 0, review: 2, acceptance: 1 }

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'kit-files-'))
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, 'tests', 'check.mjs'), 'console.log("original")\n', 'utf8')
  return root
}

console.log('\n[1] 冻结时记录命令点到的文件')
const root = await makeRoot()
const runDir = join(root, '.protocol-kit', 'run-1')

await check('node tests/check.mjs → 记 1 个文件', async () => {
  const result = await freezeOracles(runDir, {
    root,
    run_id: 'run-1',
    budget: BUDGET,
    oracles: [{ id: 'L0-1', level: 'L0', criterion: '检查脚本通过', command: 'node tests/check.mjs' }],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.doc.oracles[0].files.length, 1)
  assert.equal(result.doc.oracles[0].files[0].path, 'tests/check.mjs')
  assert.match(result.doc.oracles[0].files[0].sha256, /^[0-9a-f]{64}$/)
})

await check('人工判据不带文件', async () => {
  const other = await mkdtemp(join(tmpdir(), 'kit-files-manual-'))
  const result = await freezeOracles(join(other, '.protocol-kit', 'r'), {
    root: other,
    run_id: 'r',
    budget: BUDGET,
    oracles: [{ id: 'L2-1', level: 'L2', criterion: '人工判断' }],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.doc.oracles[0].files, [])
})

await check('文件哈希进 oracles.json 的哈希范围', async () => {
  const result = await freezeOracles(join(root, '.protocol-kit', 'run-hash'), {
    root,
    run_id: 'run-hash',
    budget: BUDGET,
    oracles: [{ id: 'L0-1', level: 'L0', criterion: 'c', command: 'node tests/check.mjs' }],
  })
  const body = { ...result.doc }
  delete body.hash
  const { hashOf } = await import('../src/kernel/oracles.js')
  assert.equal(hashOf(body), result.doc.hash)
})

console.log('\n[2] 执行前核对')
const frozen = await freezeOracles(join(root, '.protocol-kit', 'run-2'), {
  root,
  run_id: 'run-2',
  budget: BUDGET,
  oracles: [{ id: 'L0-1', level: 'L0', criterion: 'c', command: 'node tests/check.mjs' }],
})
const files = frozen.doc.oracles[0].files

await check('文件没动 → ok', async () => {
  const result = verifyFiles(root, files)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.missing, [])
})

await check('改一个字符 → changed', async () => {
  await writeFile(join(root, 'tests', 'check.mjs'), 'console.log("tampered")\n', 'utf8')
  const result = verifyFiles(root, files)
  assert.equal(result.ok, false)
  assert.equal(result.changed.length, 1)
  assert.equal(result.changed[0].path, 'tests/check.mjs')
  assert.notEqual(result.changed[0].expected, result.changed[0].actual)
})

await check('改回来 → 又 ok（哈希是可复现的事实，不是一次性标记）', async () => {
  await writeFile(join(root, 'tests', 'check.mjs'), 'console.log("original")\n', 'utf8')
  assert.equal(verifyFiles(root, files).ok, true)
})

await check('文件被删 → missing', async () => {
  await rm(join(root, 'tests', 'check.mjs'))
  const result = verifyFiles(root, files)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['tests/check.mjs'])
})

console.log('\n[3] 哪些参数会被当成文件')
const probeRoot = await mkdtemp(join(tmpdir(), 'kit-files-probe-'))
await mkdir(join(probeRoot, 'sub'), { recursive: true })
await writeFile(join(probeRoot, 'sub', 'a.mjs'), '1\n', 'utf8')
await writeFile(join(probeRoot, 'b.json'), '{}\n', 'utf8')

await check('相对路径与数据文件都收', async () => {
  const result = filesOfCommand(probeRoot, ['node', 'sub/a.mjs', 'b.json'])
  assert.deepEqual(result.map((item) => item.path).sort(), ['b.json', 'sub/a.mjs'])
})

await check('参数开关跳过', async () => {
  const result = filesOfCommand(probeRoot, ['node', '--test', 'sub/a.mjs'])
  assert.deepEqual(result.map((item) => item.path), ['sub/a.mjs'])
})

await check('不存在的路径跳过（不报错的命令照跑）', async () => {
  assert.deepEqual(filesOfCommand(probeRoot, ['node', 'nope.mjs']), [])
})

await check('root 之外的文件不记录', async () => {
  assert.deepEqual(filesOfCommand(probeRoot, ['node', '../../etc/passwd']), [])
})

await check('通配符不展开（那是 shell 的事）', async () => {
  assert.deepEqual(filesOfCommand(probeRoot, ['node', '*.mjs']), [])
})

await check('argv[0] 自己不记录（解释器不是判据内容）', async () => {
  const result = filesOfCommand(probeRoot, ['node', '--version'])
  assert.deepEqual(result, [])
})

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
await rm(root, { recursive: true, force: true })
await rm(probeRoot, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
