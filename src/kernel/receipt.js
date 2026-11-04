// 回执：一次判据执行的真实结果。命令的 stdout/stderr 全文不落盘，只留哈希 + 头部样本，
// 这样回执本身不会变成凭证泄露渠道，同时要复核时能对上字节。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const MAX_CAPTURE = 8000
const HARD_CAP = MAX_CAPTURE * 8

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
export async function readReceipts(runDir) {
  const dir = receiptsDir(runDir)
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return { receipts: [], files: 0, skipped: 0 }
    throw error
  }
  const receipts = []
  let files = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    files += 1
    try {
      const text = await readFile(join(dir, name), 'utf8')
      receipts.push(JSON.parse(text))
    } catch {
      /* 坏回执跳过：不因为一个文件坏掉就让整个裁决不可用 */
    }
  }
  return { receipts, files, skipped: files - receipts.length }
}

/**
 * 执行一条已冻结的判据。
 * shell:false + argv 数组是刻意的：命令不经过 shell，所以冻结时校验过的 argv 就是真正
 * 执行的那一份，中间不存在被解释成别的东西的空间。
 */
export function executeOracle({ root, oracle, signal }) {
  return new Promise((done) => {
    const cwd = resolve(root, oracle.cwd ?? '.')
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let finished = false

    let timer = null
    const finish = (code, spawnError) => {
      if (finished) return
      finished = true
      if (timer !== null) clearTimeout(timer)
      done({
        ok: spawnError === null || spawnError === undefined,
        oracle_id: oracle.id,
        level: oracle.level,
        command: oracle.command,
        argv: oracle.argv,
        cwd,
        exit_code: typeof code === 'number' ? code : null,
        expected_exit_code: oracle.expect?.exit_code ?? 0,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        spawn_error: spawnError === null || spawnError === undefined ? null : String(spawnError.message ?? spawnError),
        stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
        stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
        stdout_sha256: hashText(stdout),
        stderr_sha256: hashText(stderr),
        stdout_head: stdout.slice(0, MAX_CAPTURE),
        stderr_head: stderr.slice(0, MAX_CAPTURE),
      })
    }

    let child
    try {
      child = spawn(oracle.argv[0], oracle.argv.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      })
    } catch (error) {
      finish(null, error)
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      // 超时不算脚本自己失败：进程被我们杀死，退出码没有意义，回执里用 timed_out 表达。
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已经退出 */
      }
    }, oracle.timeout_ms)

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < HARD_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < HARD_CAP) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code, null))
  })
}

export async function writeReceipt(runDir, receipt, seq) {
  const dir = receiptsDir(runDir)
  await mkdir(dir, { recursive: true })
  const safeId = String(receipt.oracle_id).replace(/[^a-zA-Z0-9._-]+/g, '_')
  const file = join(dir, `${safeId}__${String(seq).padStart(4, '0')}.json`)
  const body = {
    ...receipt,
    receipt_id: `rcpt_${seq}_${safeId}`,
    recorded_at: new Date().toISOString(),
  }
  await writeFile(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
  return { file, receipt: body }
}

export function verdictOf(receipt) {
  if (receipt.spawn_error !== null && receipt.spawn_error !== undefined) return 'spawn-failed'
  if (receipt.timed_out) return 'timed-out'
  if (receipt.exit_code === receipt.expected_exit_code) return 'passed'
  return 'failed'
}
