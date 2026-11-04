// 判据冻结：写入 <runDir>/oracles.json，之后任何改动都会被 hash 校验拒绝。
//
// 铁律（AGENTS.md）：oracle_gate_exec 只能按冻结判据 id 执行命令，禁止接受任意命令。
// 所以命令的唯一入口是 freeze，而 freeze 只能成功一次。
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BUCKETS } from './ledger.js'
import { resolveExecutable } from './command.js'
import { validateExpect } from './expect.js'

export const ORACLE_FILE = 'oracles.json'
export const LEVELS = ['L0', 'L1', 'L2', 'L3']

// 拒绝的理由不是「命令危险」，而是「它能让我们绕过冻结」：带 shell 元字符的命令
// 无法用 spawn(shell:false) 的语义精确执行，运行时要么静默失效，要么行为与冻结时
// 写下的不是同一件事。要求拆成多条判据，每条一个进程。
// 只禁「明确表示多条命令或重定向」的那几个字符。
//
// 为什么不禁括号、引号、$、反引号：执行用 spawn(shell:false)，shell 根本不存在，
// 这些字符只是字面量，禁掉反而会把 `node -e "process.exit(0)"` 这种正常命令挡在门外。
// 而 `&&`、`|`、`;`、`>` 不一样——写它们的人期待的是「跑两条」，我们只会跑第一条，
// 然后第一条恰好返回 0，就变成一次假绿。这类必须硬拒，让人拆成多条判据。
const SHELL_META = /[|&;<>\n\r]/

export function oraclesPath(runDir) {
  return join(runDir, ORACLE_FILE)
}

/** 键排序后的 JSON，保证同一个对象永远算出同一个 hash。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return (
    '{' +
    keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') +
    '}'
  )
}

export function hashOf(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** 支持双引号包裹的分词，够用且可预测；不做变量展开、不做通配符。 */
export function splitCommand(command) {
  const argv = []
  let current = ''
  let quoted = false
  let has = false
  for (const ch of String(command).trim()) {
    if (ch === '"') {
      quoted = !quoted
      has = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (has) {
        argv.push(current)
        current = ''
        has = false
      }
      continue
    }
    current += ch
    has = true
  }
  if (has) argv.push(current)
  return argv
}

// argv 数组里单独出现这些元素，说明写的人以为有 shell——我们只会把它当字面参数传下去。
const SHELL_OPERATOR = /^(\|\||&&|\||;|&|>|>>|<|2>|2>&1)$/

/** 把 argv 拼成可读的命令文本，仅用于展示与回执，不用于执行。 */
export function formatArgv(argv) {
  return argv.map((arg) => (arg === '' || /[\s"]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg)).join(' ')
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 校验单条判据。返回 { ok, argv } 或 { ok:false, error }。
 * cwd 必须落在 root 内 —— 判据能跑的命令必须是你授权的那个工作区里的。
 */
export function validateOracle(oracle, root, options = {}) {
  if (!oracle || typeof oracle !== 'object') return { ok: false, error: 'oracle-not-object' }
  const id = typeof oracle.id === 'string' ? oracle.id.trim() : ''
  if (id === '') return { ok: false, error: 'missing-id' }
  if (!LEVELS.includes(oracle.level)) {
    return { ok: false, error: 'bad-level', id, known: LEVELS }
  }
  if (typeof oracle.criterion !== 'string' || oracle.criterion.trim() === '') {
    return { ok: false, error: 'missing-criterion', id }
  }
  const hasArgv = oracle.argv !== undefined && oracle.argv !== null
  const hasCommand = oracle.command !== undefined && oracle.command !== null
  if (!hasArgv && !hasCommand) {
    // L2/L3 是人工判断，允许没有命令。
    if (oracle.level === 'L2' || oracle.level === 'L3') {
      return { ok: true, id, argv: null, manual: true }
    }
    return { ok: false, error: 'missing-command', id }
  }
  let argv
  if (hasArgv) {
    // argv 数组：每个元素原样作为一个参数，不分词、不解析引号——带空格、带引号的参数都不会被拆坏。
    if (!Array.isArray(oracle.argv) || oracle.argv.some((arg) => typeof arg !== 'string')) {
      return { ok: false, error: 'bad-argv', id, hint: 'argv 必须是字符串数组，例如 ["node","tests/a.mjs"]' }
    }
    argv = oracle.argv.slice()
    if (argv.length === 0 || argv[0].trim() === '') return { ok: false, error: 'empty-command', id }
    const op = argv.find((arg) => SHELL_OPERATOR.test(arg.trim()))
    if (op !== undefined) {
      return {
        ok: false,
        error: 'shell-meta-not-allowed',
        id,
        found: op,
        hint: 'argv 里单独的 && | ; > 不会被当成 shell 运算符执行；拆成多条判据，每条一个进程',
      }
    }
  } else {
    const command = String(oracle.command)
    const meta = command.match(SHELL_META)
    if (meta !== null) {
      return {
        ok: false,
        error: 'shell-meta-not-allowed',
        id,
        found: meta[0],
        hint: '拆成多条判据，每条一个进程；参数里确实需要 & | 等字面字符时改用 argv 数组',
      }
    }
    argv = splitCommand(command)
    if (argv.length === 0) return { ok: false, error: 'empty-command', id }
  }
  const cwdRaw = typeof oracle.cwd === 'string' && oracle.cwd.trim() !== '' ? oracle.cwd.trim() : '.'
  const cwd = isAbsolute(cwdRaw) ? resolve(cwdRaw) : resolve(root, cwdRaw)
  if (!inside(root, cwd)) {
    return { ok: false, error: 'cwd-outside-root', id, cwd }
  }
  if (oracle.bucket !== undefined && !BUCKETS.includes(oracle.bucket)) {
    return { ok: false, error: 'bad-bucket', id, known: BUCKETS }
  }
  const expectCheck = validateExpect(oracle.expect)
  if (!expectCheck.ok) return { ok: false, error: expectCheck.error, id, hint: expectCheck.hint }
  // 冻结前预检：命令找不到就现在报错，别等到 exec 时才发现、白扣一次预算。
  if (options.preflight !== false) {
    const found = resolveExecutable(argv[0], { cwd, env: options.env, platform: options.platform })
    if (!found.ok) {
      return {
        ok: false,
        error: 'command-not-found',
        id,
        found: argv[0],
        hint: `在 PATH 里找不到 ${argv[0]}（cwd=${cwd}）；确认已安装，或写绝对路径`,
      }
    }
  }
  return { ok: true, id, argv, cwd, manual: false, expect: expectCheck.expect }
}

/**
 * 冻结判据。成功后再调用会返回 already-frozen，不会覆盖 —— 覆盖就等于允许改判据，
 * 冻结也就失去意义了。要换判据请开新的 run。
 */
export async function freezeOracles(runDir, { root, run_id, budget, oracles, preflight, env, platform }) {
  if (!Array.isArray(oracles) || oracles.length === 0) {
    return { ok: false, error: 'no-oracles' }
  }
  const existing = await loadOracles(runDir)
  if (existing.ok) {
    return {
      ok: false,
      error: 'already-frozen',
      frozen_at: existing.doc.frozen_at,
      hash: existing.doc.hash,
      hint: '判据已冻结，要改请开新的 run-id；冻结后不可修改正是这个工具存在的意义',
    }
  }

  const seen = new Set()
  const normalized = []
  for (const raw of oracles) {
    const check = validateOracle(raw, root, { preflight, env, platform })
    if (!check.ok) return { ok: false, error: 'invalid-oracle', detail: check }
    if (seen.has(check.id)) {
      return { ok: false, error: 'duplicate-id', id: check.id }
    }
    seen.add(check.id)
    normalized.push({
      id: check.id,
      level: raw.level,
      criterion: String(raw.criterion).trim(),
      command: check.manual ? null : raw.command === undefined || raw.command === null ? formatArgv(check.argv) : String(raw.command),
      argv: check.argv,
      cwd: check.manual ? null : relative(root, check.cwd) || '.',
      bucket: BUCKETS.includes(raw.bucket) ? raw.bucket : levelBucket(raw.level),
      timeout_ms: clampTimeout(raw.timeout_ms),
      expect: check.manual ? { exit_code: 0 } : check.expect,
      manual: check.manual,
      // 判据冻结的不能只是命令文本。命令里点到的每个本地文件，冻结时记下内容哈希，
      // 执行前重算 —— 否则改一句断言就能改判定，而 oracles.json 的哈希对此无感。
      files: check.manual ? [] : filesOfCommand(root, check.argv),
    })
  }

  const body = {
    version: 1,
    run_id,
    root,
    frozen_at: new Date().toISOString(),
    budget,
    oracles: normalized,
  }
  const doc = { ...body, hash: hashOf(body) }
  await mkdir(runDir, { recursive: true })
  try {
    // 排他创建（wx）：即使上面的「已冻结」检查被并发或异常路径绕过，也不会覆盖已经冻结
    // 的判据。「冻结后不可改」是这套内核的全部意义所在，不能只靠一次读检查兜底。
    await writeFile(oraclesPath(runDir), JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') {
      const current = await loadOracles(runDir)
      return {
        ok: false,
        error: 'already-frozen',
        frozen_at: current.ok ? current.doc.frozen_at : null,
        hash: current.ok ? current.doc.hash : null,
        hint: '判据已冻结，要改请开新的 run-id；冻结后不可修改正是这个工具存在的意义',
      }
    }
    throw error
  }
  return { ok: true, doc }
}

function levelBucket(level) {
  if (level === 'L0') return 'execution'
  if (level === 'L1') return 'evidence'
  if (level === 'L2') return 'review'
  return 'acceptance'
}

function clampTimeout(raw) {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 120000
  if (value < 1000) return 1000
  if (value > 600000) return 600000
  return value
}

/** 读回并重算 hash。hash 不符说明文件被改过，一律当成不可用。 */
export async function loadOracles(runDir) {
  let text = ''
  try {
    text = await readFile(oraclesPath(runDir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, error: 'not-frozen' }
    throw error
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, error: 'corrupted', detail: 'oracles.json 不是合法 JSON' }
  }
  if (!doc || typeof doc !== 'object' || typeof doc.hash !== 'string') {
    return { ok: false, error: 'corrupted', detail: 'oracles.json 缺少 hash 字段' }
  }
  const { hash, ...body } = doc
  const actual = hashOf(body)
  if (actual !== hash) {
    return {
      ok: false,
      error: 'hash-mismatch',
      expected: hash,
      actual,
      hint: 'oracles.json 在冻结后被修改过，本次运行作废，请开新的 run-id',
    }
  }
  return { ok: true, doc }
}

export function findOracle(doc, id) {
  return doc.oracles.find((oracle) => oracle.id === id) ?? null
}

function sha256OfFile(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/**
 * 从命令的 argv 里挑出「本地文件」并记下内容哈希。
 *
 * 为什么需要它：判据冻结的若只是命令文本，改掉脚本里的一句断言就能让判定翻转，
 * 而 oracles.json 的哈希校验只覆盖文本，完全看不见这件事。冻结必须锁到真正
 * 被执行的东西上。
 *
 * 只认真实存在的普通文件，且必须在 root 之内；通配符不展开（那是 shell 的事，
 * 而我们从不用 shell）。argv[0] 是解释器本身，跳过。
 */
export function filesOfCommand(root, argv) {
  const base = resolve(root)
  const out = []
  const seen = new Set()
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    if (/[*?[\]]/.test(arg)) continue
    let abs
    try {
      abs = isAbsolute(arg) ? resolve(arg) : resolve(base, arg)
    } catch {
      continue
    }
    const rel = relative(base, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    let info
    try {
      info = statSync(abs)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const key = rel.split(sep).join('/')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path: key, sha256: sha256OfFile(abs), bytes: info.size })
  }
  return out
}

/** 执行前核对：冻结时记下的文件是否还在、内容是否还是那份。 */
export function verifyFiles(root, files) {
  const base = resolve(root)
  const changed = []
  const missing = []
  for (const entry of files ?? []) {
    const abs = resolve(base, entry.path)
    let info
    try {
      info = statSync(abs)
    } catch {
      missing.push(entry.path)
      continue
    }
    if (!info.isFile()) {
      missing.push(entry.path)
      continue
    }
    const actual = sha256OfFile(abs)
    if (actual !== entry.sha256) changed.push({ path: entry.path, expected: entry.sha256, actual })
  }
  return { ok: changed.length === 0 && missing.length === 0, changed, missing }
}

export { inside as isInside, sep as pathSep }
