// 失败归因库：记录失败并把「下一步该回哪一段」定下来。
//
// v4 的分流规则是这套东西里最容易被做错的部分：如果失败一律回到实现阶段，那么
// 「阈值本身定错了」就会被反复当成 bug 修，直到有人放弃；如果一律不重放，
// 那么真正的实现缺陷就永远不会被修。所以分类必须是显式的一步，不能靠 agent 自由发挥。
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const FAILURE_FILE = 'failures.jsonl'

export const FAILURE_CLASSES = [
  'requirement-misread',
  'design',
  'implementation',
  'evidence-gap',
  'oracle-gamed',
  'infrastructure',
]

/**
 * 每类失败应该回到哪一段重来。
 * no-replay 表示不重放：基础设施问题重放只会浪费预算，要人去修环境。
 */
export const RETRY_TARGET = {
  'requirement-misread': 'clarify',
  design: 'design',
  implementation: 'implement',
  'evidence-gap': 'evidence',
  'oracle-gamed': 'freeze',
  infrastructure: 'no-replay',
}

export function failuresPath(runDir) {
  return join(runDir, FAILURE_FILE)
}

export async function recordFailure(runDir, { class: kind, summary, evidence = [], oracle_id = null, round = null }) {
  if (!FAILURE_CLASSES.includes(kind)) {
    return { ok: false, error: 'unknown-class', got: kind, known: FAILURE_CLASSES }
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    return { ok: false, error: 'missing-summary' }
  }
  await mkdir(runDir, { recursive: true })
  const record = {
    id: `fail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    class: kind,
    summary: summary.trim(),
    evidence: Array.isArray(evidence) ? evidence.slice(0, 20).map(String) : [],
    oracle_id,
    round,
    retry_target: RETRY_TARGET[kind],
  }
  await appendFile(failuresPath(runDir), JSON.stringify(record) + '\n', 'utf8')
  return { ok: true, record }
}

export async function readFailures(runDir) {
  let text = ''
  try {
    text = await readFile(failuresPath(runDir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过：失败库的价值在能读，不在绝对完整 */
    }
  }
  return out
}

/** 按关键词检索。P2 出方案前必须跑一次，避免重复踩同一个坑。 */
export async function searchFailures(runDir, { query = '', limit = 10, class: kind = null } = {}) {
  const all = await readFailures(runDir)
  const needle = String(query).trim().toLowerCase()
  const hits = all.filter((item) => {
    if (kind !== null && item.class !== kind) return false
    if (needle === '') return true
    return (
      String(item.summary).toLowerCase().includes(needle) ||
      String(item.class).toLowerCase().includes(needle) ||
      item.evidence.some((entry) => String(entry).toLowerCase().includes(needle))
    )
  })
  return { total: all.length, matched: hits.length, limit, items: hits.slice(-limit).reverse() }
}

export function summarizeFailures(items) {
  const byClass = {}
  for (const item of items) {
    byClass[item.class] = (byClass[item.class] ?? 0) + 1
  }
  return byClass
}
