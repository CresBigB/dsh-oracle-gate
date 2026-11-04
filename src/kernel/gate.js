// 准入裁决：只由「已冻结判据 + 真实回执 + 结构化评审」算出来，不看任何 agent 的自我评价。
//
// 判定顺序是有意为之：
//   1. 硬失败优先 —— 有 L0/L1 判据跑失败，或者评审投了 veto，那没什么可讨论的。
//   2. 缺证据其次 —— 判据还没跑完就不能说通过，但也不该判成失败，那是「还不知道」。
//   3. 只缺人工判断时转 blocked-on-human —— 这不是失败，是需要人拍板。
import { verdictOf } from './receipt.js'

export const VERDICTS = ['pass', 'rejected', 'insufficient-evidence', 'blocked-on-human']

/**
 * 同一判据可能有多份回执（重跑），取最后写入的那份。
 *
 * 从 oracle_gate_status 侧上提：它原本自己也建了一份同样的 map（评审 2026-11-01 的 L2-1 notes
 * 指出「同语义两份实现」）。「最新」的口径只该有一处，否则两边会慢慢分叉。
 */
export function latestReceipts(receipts) {
  const byOracle = new Map()
  for (const receipt of receipts) {
    byOracle.set(receipt.oracle_id, receipt) // 后写入的覆盖先写入的
  }
  return byOracle
}

/**
 * 计数行的唯一模板。
 *
 * 从 summarizeGate 里抽出来给 oracle_gate_status 复用：评审（2026-11-01）指出 status 自己
 * 重拼了一遍「通过 X / 失败 Y」，两处模板迟早漂移，同一次查询会给出两种措辞。
 */
export function countsOf(result) {
  return `通过 ${result.passed.length} / 失败 ${result.failed.length} / 未跑 ${result.missing.length} / 待人工 ${result.awaiting_human.length}（共 ${result.total}）`
}

/**
 * 把 reviews 归一成数组。
 *
 * 数组与「按判据 id 索引的对象」都接受：调用方（尤其是模型）经常把 reviews 写成
 * `{"L2-ui": {...}}`，那种写法更自然，但只认数组的实现会静默当成「没人评」，
 * 明明传了结论却仍判 blocked-on-human。宁可宽容输入，也不要静默丢掉评审意见。
 */
export function normalizeReviews(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((item) => item !== null && typeof item === 'object')
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.entries(raw)
      .filter(([, value]) => value !== null && typeof value === 'object')
      .map(([key, value]) => ({ ...value, oracle_id: value.oracle_id ?? key }))
  }
  return []
}

function reviewIndex(reviews) {
  const byOracle = new Map()
  for (const review of reviews) {
    byOracle.set(String(review.oracle_id ?? review.id ?? ''), review)
  }
  return byOracle
}

export function evaluateGate({ doc, receipts, reviews = [] }) {
  const latest = latestReceipts(receipts)
  const reviewBy = reviewIndex(reviews)

  const passed = []
  const failed = []
  const missing = []
  const awaitingHuman = []
  const vetoed = []
  const withUnknowns = []
  const withoutEvidenceRefs = []

  for (const oracle of doc.oracles) {
    if (oracle.manual) {
      const review = reviewBy.get(oracle.id)
      if (review === undefined) {
        awaitingHuman.push(oracle.id)
        continue
      }
      const veto = review.veto === true
      const unknowns = Array.isArray(review.unknowns) ? review.unknowns : []
      const refs = Array.isArray(review.evidence_refs) ? review.evidence_refs : []
      if (veto) vetoed.push(oracle.id)
      if (unknowns.length > 0) withUnknowns.push({ id: oracle.id, unknowns })
      if (refs.length === 0) withoutEvidenceRefs.push(oracle.id)
      if (veto || unknowns.length > 0 || refs.length === 0) {
        failed.push({ id: oracle.id, reason: veto ? 'veto' : unknowns.length > 0 ? 'unknowns' : 'no-evidence-refs' })
      } else if (review.verdict === 'fail') {
        failed.push({ id: oracle.id, reason: 'review-failed' })
      } else {
        passed.push(oracle.id)
      }
      continue
    }

    const receipt = latest.get(oracle.id)
    if (receipt === undefined) {
      missing.push(oracle.id)
      continue
    }
    const outcome = verdictOf(receipt)
    if (outcome === 'passed') {
      passed.push(oracle.id)
    } else {
      failed.push({ id: oracle.id, reason: outcome, exit_code: receipt.exit_code })
    }
  }

  let verdict
  if (failed.length > 0) verdict = 'rejected'
  else if (missing.length > 0) verdict = 'insufficient-evidence'
  else if (awaitingHuman.length > 0) verdict = 'blocked-on-human'
  else verdict = 'pass'

  const notes = []
  if (vetoed.length > 0) notes.push(`评审投了 veto：${vetoed.join('、')} —— 这条不是「再改改」，是方案方向被否了`)
  if (withUnknowns.length > 0) notes.push(`评审有 unknowns 未解决：${withUnknowns.map((item) => item.id).join('、')}`)
  if (missing.length > 0) notes.push(`还有 ${missing.length} 条判据没跑：${missing.join('、')} —— 没跑不等于过，也不等于失败`)
  // 措辞刻意不说「没人评」：reviews 是不落盘的调用参数，gate 无从知道历史上有没有人评过，
  // 只能说「这次没传进来」。评审（2026-11-01，L3-1-F3）指出原文把「本次没传 reviews」
  // 断言成了「没人评过」，和 oracle_gate_status 里那句「不代表没人评过」自相矛盾。
  if (awaitingHuman.length > 0) notes.push(`还有 ${awaitingHuman.length} 条人工判据没有评审结论传入：${awaitingHuman.join('、')} —— 未传入不等于没人评过`)
  if (failed.length > 0 && missing.length > 0) notes.push('注意：硬失败优先，所以即使补跑了剩下的判据，本次结论仍是 rejected')

  return {
    verdict,
    total: doc.oracles.length,
    passed,
    failed,
    missing,
    awaiting_human: awaitingHuman,
    vetoed,
    with_unknowns: withUnknowns,
    without_evidence_refs: withoutEvidenceRefs,
    notes,
  }
}

export function summarizeGate(result) {
  const head = `准入裁决：${result.verdict}`
  return [head, countsOf(result), ...result.notes].join('\n')
}

/**
 * 「下一步该做什么」的唯一映射。
 *
 * 从 src/tools/gate.js 上提到内核：oracle_gate_status 也要报下一步，两个工具各写一份必然漂移
 * ——同一次查询里给出两个不同的建议，比不给建议更糟。
 */
export const NEXT_BY_VERDICT = {
  pass: '全部通过，可以交付。',
  rejected: '有硬失败或 veto：按失败分类回退（oracle_gate_failures 记录时会给 retry_target），不要原地重试。',
  'insufficient-evidence': '还有判据没跑：用 oracle_gate_exec 补齐后重新调用 oracle_gate_gate。没跑不等于过。',
  'blocked-on-human': '只剩人工判据：把评审结论通过 reviews 传进来，或者直接问用户拍板。',
}
