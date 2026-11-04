// 判据的期望：退出码 + 输出断言。
//
// 只看退出码时，「跑测试、再看数字」这类验收都得另写包装脚本，而包装脚本 import 的
// 模块又不在文件锁里。把常见的输出断言放进冻结的 expect，判定本身就在锁内。
//
// 未知字段一律拒绝：expect 里写错一个键名（比如 stdout_include 少个 s），宽松实现会
// 静默忽略这条断言，结果就是一次假绿。宁可冻结失败，也不要少验一条。

export const JSON_OPS = ['==', '!=', '<', '<=', '>', '>=']
const STREAMS = ['stdout', 'stderr']
const TEXT_KINDS = ['includes', 'excludes', 'matches']
const KNOWN_KEYS = new Set([
  'exit_code',
  ...STREAMS.flatMap((stream) => TEXT_KINDS.map((kind) => `${stream}_${kind}`)),
  'stdout_json',
])

function toStringList(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}

/**
 * 校验并规整 expect。返回 { ok, expect } 或 { ok:false, error, hint }。
 * 规整结果只含真正生效的字段，冻结后哈希锁住的就是这一份。
 */
export function validateExpect(raw) {
  if (raw === undefined || raw === null) return { ok: true, expect: { exit_code: 0 } }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'bad-expect', hint: 'expect 必须是对象，例如 {"exit_code":0}' }
  }
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: 'unknown-expect-key',
      hint: `expect 不认识 ${unknown.join('、')}；可用字段：${[...KNOWN_KEYS].join(', ')}`,
    }
  }
  const out = { exit_code: 0 }
  if (raw.exit_code !== undefined) {
    if (!Number.isInteger(raw.exit_code)) return { ok: false, error: 'bad-expect', hint: 'expect.exit_code 必须是整数' }
    out.exit_code = raw.exit_code
  }
  for (const stream of STREAMS) {
    for (const kind of TEXT_KINDS) {
      const key = `${stream}_${kind}`
      if (raw[key] === undefined) continue
      const list = toStringList(raw[key])
      if (list === null || list.length === 0 || list.some((item) => item === '')) {
        return { ok: false, error: 'bad-expect', hint: `${key} 必须是非空字符串或非空字符串数组` }
      }
      if (kind === 'matches') {
        for (const source of list) {
          try {
            new RegExp(source, 'm')
          } catch (error) {
            return { ok: false, error: 'bad-regex', hint: `${key} 的正则「${source}」无法编译：${error.message}` }
          }
        }
      }
      out[key] = list
    }
  }
  if (raw.stdout_json !== undefined) {
    const list = Array.isArray(raw.stdout_json) ? raw.stdout_json : [raw.stdout_json]
    const rules = []
    for (const rule of list) {
      if (!rule || typeof rule !== 'object' || typeof rule.path !== 'string' || rule.path.trim() === '') {
        return { ok: false, error: 'bad-expect', hint: 'stdout_json 每项形如 {"path":"summary.failed","op":"==","value":0}' }
      }
      const op = rule.op ?? '=='
      if (!JSON_OPS.includes(op)) return { ok: false, error: 'bad-expect', hint: `stdout_json.op 只能是 ${JSON_OPS.join(' ')}` }
      const value = rule.value
      const scalar = value === null || ['number', 'string', 'boolean'].includes(typeof value)
      if (!scalar) return { ok: false, error: 'bad-expect', hint: 'stdout_json.value 必须是数字、字符串、布尔或 null' }
      if (!['==', '!='].includes(op) && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { ok: false, error: 'bad-expect', hint: `stdout_json 用 ${op} 比较时 value 必须是有限数字` }
      }
      rules.push({ path: rule.path.trim(), op, value })
    }
    out.stdout_json = rules
  }
  return { ok: true, expect: out }
}

/** 判据有没有输出断言（没有的话就不必为断言保留完整输出）。 */
export function hasOutputAssertions(expect) {
  return Object.keys(expect ?? {}).some((key) => key !== 'exit_code')
}

/** 整体是 JSON 就取整体；否则从最后一行往前找第一行能解析成对象/数组的 JSON。 */
export function extractJson(text) {
  const whole = String(text ?? '').trim()
  try {
    return { ok: true, value: JSON.parse(whole) }
  } catch {
    /* 退回逐行查找 */
  }
  const lines = whole.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      return { ok: true, value: JSON.parse(line) }
    } catch {
      /* 继续往上找 */
    }
  }
  return { ok: false }
}

/** 取 `a.b[0].c` / `$.a.b` 形式的路径；不存在返回 { found:false }。 */
export function getPath(value, path) {
  const tokens = String(path).replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) ?? []
  let current = value
  for (const raw of tokens) {
    const key = raw.startsWith('[') ? Number(raw.slice(1, -1)) : raw
    if (current === null || typeof current !== 'object' || !(key in Object(current))) return { found: false }
    current = current[key]
  }
  return { found: true, value: current }
}

function compare(actual, op, expected) {
  switch (op) {
    case '==':
      return actual === expected
    case '!=':
      return actual !== expected
    default: {
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return false
      if (op === '<') return actual < expected
      if (op === '<=') return actual <= expected
      if (op === '>') return actual > expected
      return actual >= expected
    }
  }
}

function brief(text, max = 80) {
  const value = String(text)
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 逐条评估输出断言，返回 [{ kind, stream, target, ok, detail }]。
 * truncated[stream] 为真时，该流上的断言一律判不通过：在截断后的输出上判「不包含」
 * 恰恰是最容易出假绿的地方。
 */
export function evaluateExpect(expect, { stdout = '', stderr = '', truncated = {} } = {}) {
  const results = []
  const texts = { stdout, stderr }
  for (const stream of STREAMS) {
    for (const kind of TEXT_KINDS) {
      for (const target of expect?.[`${stream}_${kind}`] ?? []) {
        if (truncated[stream]) {
          results.push({ kind, stream, target, ok: false, detail: `${stream} 超过捕获上限被截断，无法可靠判定` })
          continue
        }
        const text = texts[stream]
        let ok
        if (kind === 'includes') ok = text.includes(target)
        else if (kind === 'excludes') ok = !text.includes(target)
        else ok = new RegExp(target, 'm').test(text)
        const verb = kind === 'includes' ? '应包含' : kind === 'excludes' ? '不应包含' : '应匹配'
        results.push({ kind, stream, target, ok, detail: `${stream} ${verb}「${brief(target)}」${ok ? '' : '，实际不符'}` })
      }
    }
  }
  const rules = expect?.stdout_json ?? []
  if (rules.length > 0) {
    const parsed = truncated.stdout ? { ok: false } : extractJson(stdout)
    for (const rule of rules) {
      const target = `${rule.path} ${rule.op} ${JSON.stringify(rule.value)}`
      if (truncated.stdout) {
        results.push({ kind: 'json', stream: 'stdout', target, ok: false, detail: 'stdout 超过捕获上限被截断，无法可靠判定' })
        continue
      }
      if (!parsed.ok) {
        results.push({ kind: 'json', stream: 'stdout', target, ok: false, detail: 'stdout 里找不到可解析的 JSON' })
        continue
      }
      const got = getPath(parsed.value, rule.path)
      if (!got.found) {
        results.push({ kind: 'json', stream: 'stdout', target, ok: false, detail: `JSON 里没有路径 ${rule.path}` })
        continue
      }
      const ok = compare(got.value, rule.op, rule.value)
      results.push({
        kind: 'json',
        stream: 'stdout',
        target,
        ok,
        actual: got.value,
        detail: `${rule.path} = ${brief(JSON.stringify(got.value))}，期望 ${rule.op} ${JSON.stringify(rule.value)}`,
      })
    }
  }
  return results
}
