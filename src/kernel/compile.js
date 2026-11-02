/**
 * 把 design 阶段产出的分层验收条件编译成可冻结的 oracles。
 *
 * 缺口背景：`kit_design` 给的是 `{criterion, level, check}`，`check` 是给人看的自然语言；
 * `kit_freeze` 要的是 `{id, level, criterion, command}`，`command` 必须能直接 spawn。
 * 中间没有任何转换，一轮闭环就得手工搬五条判据，搬运时还会碰上「check 里写了 &&」
 * 「check 要求先新建一个还不存在的测试文件」这类问题。
 *
 * 这里只做机械的那部分：拆命令链、提命令、定桶、编号。
 * 判断留给复核的人 —— 尤其 **L0/L1 提不出命令时绝不自动降级成人工判据**，
 * 那等于把硬门拆掉、让「没跑」看起来像「不用跑」。
 */

const COMMAND_HEADS = new Set([
  'node', 'npm', 'pnpm', 'npx', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pip', 'pytest', 'uv', 'poetry',
  'cargo', 'rustc', 'go', 'dotnet', 'java', 'javac', 'gradle', 'mvn',
  'mvnw', 'gradlew', 'make', 'cmake', 'jom', 'qmake',
  'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'cypress',
  'git', 'tsx', 'swc', 'vite', 'webpack', 'rollup',
])

/** 中日韩文字与全角标点：出现在命令 token 里就意味着自然语言开始了。 */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/

const LEVELS = new Set(['L0', 'L1', 'L2', 'L3'])

/** 与 oracles.js 的 levelBucket 保持一致。 */
function bucketOf(level) {
  if (level === 'L0') return 'execution'
  if (level === 'L1') return 'evidence'
  if (level === 'L2') return 'review'
  return 'acceptance'
}

/**
 * 按顶层 `&&` / `||` / `;` 把命令链拆开。
 * 引号内的内容不拆（内联脚本里常有 `;`），同时记录无法支持的 shell 元字符。
 */
export function splitChain(text) {
  const source = String(text ?? '')
  const parts = []
  const unsupported = new Set()
  let current = ''
  let quote = null

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '&' && source[i + 1] === '&') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === '|' && source[i + 1] === '|') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === ';') {
      parts.push(current)
      current = ''
      continue
    }
    if (ch === '|' || ch === '>' || ch === '<') {
      const prev = source[i - 1] ?? ''
      const next = source[i + 1] ?? ''
      const spaceBefore = prev === '' || /\s/.test(prev)
      const spaceAfter = next === '' || /\s/.test(next)
      // 只有两侧都被空白包围才算 shell 元字符（`cmd | grep`、`cmd > out.txt`）。
      // `|D|`、`=>`、`a->b` 这类是数学或代码记号，原样保留 —— 误报会让一条正常
      // 的验收条件永远冻不进去，比漏判一条真管道更糟。
      if (spaceBefore && spaceAfter) unsupported.add(ch)
      current += ch
      continue
    }
    current += ch
  }
  parts.push(current)

  return {
    parts: parts.map((part) => part.trim()).filter((part) => part !== ''),
    unsupported: [...unsupported],
  }
}

/** 按空白分词，但引号内的空白不拆 —— 内联脚本正是靠引号保持完整。 */
export function tokenize(text) {
  const source = String(text ?? '')
  const tokens = []
  let current = ''
  let quote = null

  for (const ch of source) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * 从某个命令头开始收集命令 token，遇到自然语言（中文）就停。
 * 引号内的 token 不受此限：那是脚本参数，里面的中文属于数据。
 */
function joinFromTokens(tokens, start) {
  const out = []
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]
    const quoted = token.startsWith('"') || token.startsWith("'")
    if (!quoted && CJK_RE.test(token)) break
    out.push(token)
  }
  // 结尾可能挂着一个纯标点，去掉
  while (out.length > 1 && /^[，。、,.；;:：)）\]】]+$/.test(out[out.length - 1])) out.pop()
  return out.join(' ')
}

/**
 * 从一段自然语言里提取命令。优先取反引号包起来的东西（作者已经标好了），
 * 否则找第一个已知命令头。
 */
export function pickCommand(text) {
  const source = String(text ?? '')

  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1].trim()
    const head = candidate.split(/\s+/)[0]
    if (COMMAND_HEADS.has(head)) return candidate
  }

  const tokens = tokenize(source)
  for (let i = 0; i < tokens.length; i += 1) {
    if (COMMAND_HEADS.has(tokens[i])) return joinFromTokens(tokens, i)
  }
  return null
}

/**
 * 编译一批分层验收条件。
 *
 * 返回 `{ oracles, issues }`：
 * - `oracles` 可直接交给 `kit_freeze` 的 `oracles` 参数（也可再人工改）
 * - `issues` 里 `severity: 'blocking'` 的项意味着这条判据没能编译成功，
 *   必须先补命令或改写，不能让它悄悄消失
 */
export function compileAcceptance(acceptance) {
  const list = Array.isArray(acceptance) ? acceptance : []
  const oracles = []
  const issues = []
  const counters = new Map()

  const nextId = (level) => {
    const n = (counters.get(level) ?? 0) + 1
    counters.set(level, n)
    return `${level}-${n}`
  }

  list.forEach((item, index) => {
    const level = String(item?.level ?? '').trim().toUpperCase()
    const criterion = String(item?.criterion ?? '').trim().replace(/\s+/g, ' ')
    const check = String(item?.check ?? '').trim()

    if (!LEVELS.has(level)) {
      issues.push({
        index,
        level,
        criterion,
        reason: 'bad-level',
        severity: 'blocking',
        detail: `level「${item?.level}」不在 L0–L3 之内，无法分层`,
      })
      return
    }
    if (criterion === '') {
      issues.push({
        index,
        level,
        criterion,
        reason: 'no-criterion',
        severity: 'blocking',
        detail: '缺少 criterion，冻结出来的判据无从知道在验什么',
      })
      return
    }

    // L2/L3 本来就没有命令，走人工评审
    if (level === 'L2' || level === 'L3') {
      oracles.push({
        id: nextId(level),
        level,
        criterion,
        command: null,
        manual: true,
        bucket: bucketOf(level),
      })
      return
    }

    // L0/L1：必须有可执行命令
    if (check === '') {
      issues.push({
        index,
        level,
        criterion,
        reason: 'needs-command',
        severity: 'blocking',
        detail: 'L0/L1 判据必须给可执行命令，但 check 是空的',
      })
      return
    }

    const { parts, unsupported } = splitChain(check)
    if (unsupported.length > 0) {
      issues.push({
        index,
        level,
        criterion,
        reason: 'shell-meta',
        severity: 'blocking',
        detail: `check 里含 shell 元字符 ${unsupported.join(' ')}。kit_exec 不经过 shell，这些命令跑不出预期结果；请拆成多条判据，或把管道/重定向改写成程序内部的检查。`,
      })
      return
    }

    const commands = parts.map((part) => pickCommand(part)).filter((command) => command !== null)
    if (commands.length === 0) {
      issues.push({
        index,
        level,
        criterion,
        reason: 'needs-command',
        severity: 'blocking',
        detail: `L0/L1 判据必须给可执行命令，但没能从 check 里识别出命令：${check.slice(0, 120)}`,
      })
      return
    }
    if (commands.length !== parts.length) {
      issues.push({
        index,
        level,
        criterion,
        reason: 'partial-command',
        severity: 'warning',
        detail: `check 拆成 ${parts.length} 段，其中只有 ${commands.length} 段识别出了命令，其余段被忽略`,
      })
    }

    const base = nextId(level)
    commands.forEach((command, i) => {
      oracles.push({
        id: commands.length === 1 ? base : `${base}${String.fromCharCode(97 + i)}`,
        level,
        criterion: commands.length === 1 ? criterion : `${criterion}（第 ${i + 1} 段）`,
        command,
        manual: false,
        bucket: bucketOf(level),
      })
    })
  })

  const blocking = issues.filter((issue) => issue.severity === 'blocking')
  return {
    ok: blocking.length === 0,
    oracles,
    issues,
    blocking_count: blocking.length,
    counts: {
      compiled: oracles.filter((oracle) => !oracle.manual).length,
      manual: oracles.filter((oracle) => oracle.manual).length,
    },
  }
}
