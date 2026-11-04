// 回执：一次判据执行的真实结果。命令的 stdout/stderr 全文不落盘，只留哈希 + 头部样本，
// 这样回执本身不会变成凭证泄露渠道，同时要复核时能对上字节。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildSpawnPlan, killTree } from './command.js'
import { evaluateExpect, hasOutputAssertions } from './expect.js'
import { signRecord, verifyRecord } from './signing.js'

export const MAX_CAPTURE = 8000
const HARD_CAP = MAX_CAPTURE * 8
// 有输出断言时要在完整输出上判定，上限放宽到 4 MiB；超过就标记截断、断言判不通过。
export const ASSERT_CAP = 4 * 1024 * 1024

export function hashText(text) {
  return 'sha256:' + createHash('sha256').update(text).digest('hex')
}

export function receiptsDir(runDir) {
  return join(runDir, 'receipts')
}

/**
 * 读一个 run 下的全部回执。
 *
 * 坏回执跳过而不是抛：一个文件坏掉不该让整次裁决/进度查询不可用，
 * 但调用方需要知道「跳过了几个」时才不会把残缺当完整 —— 所以返回值带总数。
 *
 * 原来这个函数是 src/tools/gate.js 的私有实现；oracle_gate_status 也要读回执，
 * 与其复制一份「坏文件跳过」的语义，不如上提到内核，让两个工具共用一套口径。
 */
export async function readReceipts(runDir, { key = null } = {}) {
  const dir = receiptsDir(runDir)
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return { receipts: [], files: 0, skipped: 0, tampered: 0 }
    throw error
  }
  const receipts = []
  let files = 0
  let tampered = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    files += 1
    let parsed
    try {
      parsed = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      /* 坏回执跳过：不因为一个文件坏掉就让整个裁决不可用 */
      continue
    }
    // 签名对不上的回执不采信：等同于这条判据没跑过（而不是跑过且通过）
    if (key !== null && !verifyRecord(key, parsed)) {
      tampered += 1
      continue
    }
    receipts.push(parsed)
  }
  return { receipts, files, skipped: files - receipts.length - tampered, tampered }
}

/**
 * 执行一条已冻结的判据。
 * shell:false + argv 数组是刻意的：命令不经过 shell，所以冻结时校验过的 argv 就是真正
 * 执行的那一份，中间不存在被解释成别的东西的空间。
 */
export function executeOracle({ root, oracle, signal, env = process.env, platform = process.platform }) {
  return new Promise((done) => {
    const cwd = resolve(root, oracle.cwd ?? '.')
    const startedAt = Date.now()
    const expect = oracle.expect ?? { exit_code: 0 }
    const cap = hasOutputAssertions(expect) ? ASSERT_CAP : HARD_CAP
    // 哈希边读边算，覆盖完整输出；保留的文本最多 cap 字符。
    const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }
    const bytes = { stdout: 0, stderr: 0 }
    const texts = { stdout: '', stderr: '' }
    const truncated = { stdout: false, stderr: false }
    let timedOut = false
    let finished = false
    let plan = null

    let timer = null
    const finish = (code, spawnError) => {
      if (finished) return
      finished = true
      if (timer !== null) clearTimeout(timer)
      const failedToSpawn = spawnError !== null && spawnError !== undefined
      const assertions = failedToSpawn || timedOut
        ? []
        : evaluateExpect(expect, { stdout: texts.stdout, stderr: texts.stderr, truncated })
      done({
        ok: !failedToSpawn,
        oracle_id: oracle.id,
        level: oracle.level,
        command: oracle.command,
        argv: oracle.argv,
        cwd,
        executable: plan?.executable ?? null,
        via: plan?.via ?? null,
        exit_code: typeof code === 'number' ? code : null,
        expected_exit_code: expect.exit_code ?? 0,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        spawn_error: failedToSpawn ? String(spawnError.message ?? spawnError) : null,
        stdout_bytes: bytes.stdout,
        stderr_bytes: bytes.stderr,
        stdout_sha256: 'sha256:' + hashes.stdout.digest('hex'),
        stderr_sha256: 'sha256:' + hashes.stderr.digest('hex'),
        stdout_truncated: truncated.stdout,
        stderr_truncated: truncated.stderr,
        stdout_head: texts.stdout.slice(0, MAX_CAPTURE),
        stderr_head: texts.stderr.slice(0, MAX_CAPTURE),
        assertions,
      })
    }

    plan = buildSpawnPlan(oracle.argv, { cwd, env, platform })
    if (!plan.ok) {
      finish(null, new Error(`${plan.error}: ${plan.name}`))
      return
    }

    let child
    try {
      child = spawn(plan.file, plan.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        // POSIX 下成为进程组组长，超时时能一次杀掉整组
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        ...plan.options,
      })
    } catch (error) {
      finish(null, error)
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      // 超时不算脚本自己失败：进程被我们杀死，退出码没有意义，回执里用 timed_out 表达。
      killTree(child, platform)
    }, oracle.timeout_ms)

    const collect = (stream) => (chunk) => {
      hashes[stream].update(chunk)
      bytes[stream] += chunk.length
      if (texts[stream].length < cap) {
        texts[stream] += chunk.toString('utf8')
        if (texts[stream].length > cap) {
          texts[stream] = texts[stream].slice(0, cap)
          truncated[stream] = true
        }
      } else {
        truncated[stream] = true
      }
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code, null))
  })
}

export async function writeReceipt(runDir, receipt, seq, { key = null } = {}) {
  const dir = receiptsDir(runDir)
  await mkdir(dir, { recursive: true })
  const safeId = String(receipt.oracle_id).replace(/[^a-zA-Z0-9._-]+/g, '_')
  const file = join(dir, `${safeId}__${String(seq).padStart(4, '0')}.json`)
  let body = {
    ...receipt,
    receipt_id: `rcpt_${seq}_${safeId}`,
    recorded_at: new Date().toISOString(),
  }
  // JSON 往返去掉 undefined，保证签名对象与读回对象一致
  if (key !== null) body = signRecord(key, JSON.parse(JSON.stringify(body)))
  await writeFile(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
  return { file, receipt: body }
}

export function verdictOf(receipt) {
  if (receipt.spawn_error !== null && receipt.spawn_error !== undefined) return 'spawn-failed'
  if (receipt.timed_out) return 'timed-out'
  if (receipt.exit_code !== receipt.expected_exit_code) return 'failed'
  if (Array.isArray(receipt.assertions) && receipt.assertions.some((item) => item.ok !== true)) return 'assertion-failed'
  return 'passed'
}
