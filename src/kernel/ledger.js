// 预算账本：只追加 JSONL，预留即消耗，不退款。
//
// 设计依据见 docs/generalization-design.md 期 4a。核心规则抄自 v4 README 第 35 行：
// 「所有真实运行从 adapter.execute 经过账本预留，不以 agent 自报扣账；预留即消耗，
// 不退款、不换 runTag 重新验收」。
//
// 为什么强调「不退款」：如果失败能把额度拿回来，agent 就会把「先跑一次看看」当作
// 免费试探，预算就退化成一个建议值。预留即消耗让每次执行都有真实代价。
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { signRecord, verifyRecord } from './signing.js'

export const BUCKETS = [
  'execution',
  'evidence',
  'design',
  'impl',
  'infra',
  'review',
  'acceptance',
]

// v4 的总预算 160 的拆分，直接沿用，便于和既有的运行记录对照。
export const DEFAULT_BUDGET = {
  execution: 100,
  evidence: 24,
  design: 8,
  impl: 8,
  infra: 8,
  review: 12,
  acceptance: 1,
}

export function ledgerPath(runDir) {
  return join(runDir, 'ledger.jsonl')
}

export function normalizeBudget(raw) {
  const out = {}
  for (const bucket of BUCKETS) {
    const value = raw?.[bucket]
    out[bucket] =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : DEFAULT_BUDGET[bucket]
  }
  return out
}

/**
 * @param key 本 run 的签名密钥（signingContext 给出）。给了就逐行验签并检查链：
 *   每行 seq 必须连续、prev 必须等于上一行的 sig —— 删除、调换、改写中间行都会被发现。
 *   验不过的行仍计入用量（宁可少算余额），tampered 非零时调用方应拒绝继续执行。
 */
export async function readLedger(runDir, { key = null } = {}) {
  let text = ''
  try {
    text = await readFile(ledgerPath(runDir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], corrupted: 0, tampered: 0 }
    throw error
  }
  const entries = []
  let corrupted = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 账本只追加且每行独立：一行坏了不该让整个运行不可读，但必须让人知道坏了几行。
      corrupted += 1
    }
  }
  let tampered = 0
  if (key !== null) {
    let prev = null
    entries.forEach((entry, index) => {
      if (!verifyRecord(key, entry) || entry.seq !== index + 1 || (entry.prev ?? null) !== prev) tampered += 1
      prev = typeof entry?.sig === 'string' ? entry.sig : null
    })
    // 坏行（解析失败）在签名 run 里也视为篡改
    tampered += corrupted
  }
  return { entries, corrupted, tampered }
}

export function usageOf(entries) {
  const used = {}
  for (const bucket of BUCKETS) used[bucket] = 0
  for (const entry of entries) {
    if (entry?.kind !== 'reserve') continue
    if (!BUCKETS.includes(entry.bucket)) continue
    used[entry.bucket] += typeof entry.amount === 'number' && entry.amount > 0 ? entry.amount : 1
  }
  return used
}

export function remainingOf(budget, entries) {
  const used = usageOf(entries)
  const out = {}
  for (const bucket of BUCKETS) out[bucket] = budget[bucket] - used[bucket]
  return out
}

export async function appendLedger(runDir, entry, { key = null } = {}) {
  await mkdir(runDir, { recursive: true })
  const { entries } = await readLedger(runDir)
  let record = {
    seq: entries.length + 1,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...entry,
  }
  if (key !== null) {
    const last = entries[entries.length - 1]
    record = signRecord(key, { ...record, prev: typeof last?.sig === 'string' ? last.sig : null })
  }
  // 单行一次 appendFile：O_APPEND 下这种小写入不会被其它 append 从中间插入。
  await appendFile(ledgerPath(runDir), JSON.stringify(record) + '\n', 'utf8')
  return record
}

/**
 * 预留一次消耗。余额不足时返回 ok:false，调用方必须停止而不是继续执行。
 * 注意：没有 refund / release —— 预留出去就是花掉了，这是刻意的。
 */
export async function reserve(runDir, { bucket, amount = 1, budget, oracle_id = null, note = '', key = null }) {
  if (!BUCKETS.includes(bucket)) {
    return { ok: false, error: 'unknown-bucket', bucket, known: BUCKETS }
  }
  const { entries } = await readLedger(runDir)
  const remaining = remainingOf(budget, entries)
  const need = typeof amount === 'number' && amount > 0 ? amount : 1
  if (remaining[bucket] < need) {
    return {
      ok: false,
      error: 'budget-exhausted',
      bucket,
      need,
      remaining: remaining[bucket],
      budget: budget[bucket],
    }
  }
  const record = await appendLedger(runDir, {
    kind: 'reserve',
    bucket,
    amount: need,
    oracle_id,
    note,
  }, { key })
  return { ok: true, entry: record, remaining: { ...remaining, [bucket]: remaining[bucket] - need } }
}
