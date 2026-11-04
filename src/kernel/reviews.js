// 评审存档：<runDir>/reviews.jsonl，每行一条评审结论，带记录时间与当时的代码指纹。
//
// 为什么要落盘：以前 reviews 只是 oracle_gate_gate 的调用参数，裁决一结束就没了，
// 事后无从考证「谁、在哪版代码上、凭什么判了 pass」。存档后：
//   - gate / status 不传 reviews 时，用存档里每条判据最新的那条；
//   - 代码指纹变了的存档评审不再采信（评的是旧代码）。
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { freshnessOf } from './fingerprint.js'

export const REVIEWS_FILE = 'reviews.jsonl'

export function reviewsPath(runDir) {
  return join(runDir, REVIEWS_FILE)
}

export async function appendReviews(runDir, reviews, fingerprint) {
  if (reviews.length === 0) return 0
  await mkdir(runDir, { recursive: true })
  const recordedAt = new Date().toISOString()
  const lines = reviews.map((review) => JSON.stringify({
    ...review,
    oracle_id: String(review.oracle_id ?? review.id ?? ''),
    recorded_at: recordedAt,
    code_fingerprint: fingerprint ?? null,
  }))
  await appendFile(reviewsPath(runDir), lines.join('\n') + '\n', 'utf8')
  return lines.length
}

export async function readReviews(runDir) {
  let text = ''
  try {
    text = await readFile(reviewsPath(runDir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { reviews: [], corrupted: 0 }
    throw error
  }
  const reviews = []
  let corrupted = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      reviews.push(JSON.parse(line))
    } catch {
      corrupted += 1
    }
  }
  return { reviews, corrupted }
}

/**
 * 合并「本次传入」与「存档」：本次传入的优先；没传的判据取存档里最新且仍对应当前代码的那条。
 * 返回 { reviews, from_archive: [id], stale_reviews: [id] }。
 */
export function mergeReviews({ passed, archived, fingerprint }) {
  const byId = new Map()
  const fromArchive = []
  const staleReviews = new Set()
  for (const review of archived) {
    const id = String(review.oracle_id ?? '')
    if (id === '') continue
    if (fingerprint && freshnessOf(review.code_fingerprint, fingerprint) === 'stale') {
      staleReviews.add(id)
      byId.delete(id)
      continue
    }
    staleReviews.delete(id)
    byId.set(id, review)
  }
  for (const id of byId.keys()) fromArchive.push(id)
  for (const review of passed) {
    const id = String(review.oracle_id ?? review.id ?? '')
    byId.set(id, review)
    const at = fromArchive.indexOf(id)
    if (at >= 0) fromArchive.splice(at, 1)
    staleReviews.delete(id)
  }
  return { reviews: [...byId.values()], from_archive: fromArchive, stale_reviews: [...staleReviews] }
}
