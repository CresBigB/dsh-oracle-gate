// 进度聚合：把「这个 run 跑到哪一步」一次算出来。
//
// 严格的只读层：这里不 import 任何 fs，也不调用 appendLedger / reserve / writeFile。
// 所以它既不可能改变预算余额，也不可能在 run 目录里留下任何东西 —— 这一点由
// tests/status-readonly.test.mjs 用「调用前后字节不变」来钉住。
//
// 四类计数不重新实现：直接取 evaluateGate 的返回值。判断一次、两处共用，
// 这样 kit_status 与 kit_gate 不可能在「哪些判据过了」上给出两个答案。
import { normalizeBudget, remainingOf, usageOf } from './ledger.js'
import { countsOf, evaluateGate, latestReceipts, NEXT_BY_VERDICT, summarizeGate } from './gate.js'

/**
 * @param {object} input
 * @param {object} input.doc            已校验的 oracles.json 文档（含 budget 与 oracles）
 * @param {Array}  input.entries        ledger.jsonl 的预留条目
 * @param {Array}  input.receipts       全部回执（同一判据可能多份）
 * @param {number} input.receiptsTotal  回执文件数（含解析失败的）
 * @param {number} input.skippedReceipts 解析失败被跳过的回执数
 * @param {Array}  input.reviews        人工判据的评审结论；不传则全是「未传入评审」
 */
export function summarizeRunStatus({
  doc,
  entries = [],
  receipts = [],
  receiptsTotal = receipts.length,
  skippedReceipts = 0,
  // 账本里解析失败的行数。忽略它的后果是「剩余预算被高估且没有任何提示」——
  // 坏行对应的消耗读不出来，余额看起来比实际多（评审 2026-11-01 notes）。
  corruptedEntries = 0,
  reviews = [],
}) {
  const gate = evaluateGate({ doc, receipts, reviews })

  // 预算的唯一权威是 oracles.json 的 doc.budget —— 不是 DEFAULT_BUDGET。
  // 真实 run 的 execution 可能是 12，而默认值是 100；用默认值兜底会算出假余额。
  const budget = normalizeBudget(doc.budget)
  const remaining = remainingOf(budget, entries)
  // 已用额度要账本自己的统计（ledger.js 的 usageOf），不要从余额反推。
  // 反推在「账本有解析失败的行」时与 usageOf 的口径会分叉：坏行里的消耗既进不了
  // usageOf 的计数，也会因为余额是「预算减已读出」而显得恰好对得上 —— 两处各算一次，
  // 迟早给出两个答案（评审 2026-11-01 notes）。
  const used = usageOf(entries)

  // 每条判据的重跑次数：账本只记消耗，回执才记「跑过几次」。
  const attemptsById = new Map()
  for (const receipt of receipts) {
    const id = String(receipt.oracle_id ?? '')
    if (id === '') continue
    attemptsById.set(id, (attemptsById.get(id) ?? 0) + 1)
  }

  // 「最新回执」的口径直接复用 gate 的实现，不在这里再建一份同样的 map。
  const byId = latestReceipts(
    receipts.filter((receipt) => String(receipt.oracle_id ?? '') !== ''),
  )

  // 通过 / 失败一律查 gate 算好的结果，不再自己从回执二次推导。
  // 评审（2026-11-01，run status-002 的 L2-1）指出：同源二次推导今天与 gate 等价，
  // 但一旦 gate 的判定规则变化（比如以后要求「最近一次必须通过」而不是「曾经通过」），
  // 这里会静默给出与裁决不一致的逐条状态。
  const passedSet = new Set(gate.passed)
  const failedById = new Map(gate.failed.map((entry) => [entry.id, entry]))
  // 评审结论里出现过的判据 id。「没传 reviews」与「传了但不准入」是两件事，
  // 之前的实现在这两种情况下都写「待评审」，会被读成「有人正在评」。
  // 取键口径必须与 gate 的 reviewIndex（src/kernel/gate.js:54-60）一致：
  // `oracle_id ?? id`，且不做 trim —— 两边各写一套归一规则，极端输入下就会
  // 出现「gate 判在等人、status 显示评审未准入」（评审 2026-11-01 notes）。
  const reviewedIds = new Set(
    reviews
      .map((review) => String(review?.oracle_id ?? review?.id ?? ''))
      .filter((id) => id !== ''),
  )

  const items = doc.oracles.map((oracle) => {
    const latest = byId.get(oracle.id)
    let state
    let reason = null
    if (passedSet.has(oracle.id)) {
      state = '通过'
    } else if (failedById.has(oracle.id)) {
      state = '失败'
      reason = failedById.get(oracle.id)?.reason ?? null
    } else if (oracle.manual) {
      state = reviewedIds.has(oracle.id) ? '评审未准入' : '未传入评审'
    } else {
      state = '未跑'
    }
    return {
      id: oracle.id,
      level: oracle.level,
      manual: oracle.manual === true,
      state,
      reason,
      exit_code: latest?.exit_code ?? null,
      attempts: attemptsById.get(oracle.id) ?? 0,
    }
  })

  return {
    verdict: gate.verdict,
    counts: countsOf(gate),
    total: gate.total,
    passed: gate.passed,
    failed: gate.failed,
    missing: gate.missing,
    awaiting_human: gate.awaiting_human,
    notes: gate.notes,
    summary: summarizeGate(gate),
    next_step: NEXT_BY_VERDICT[gate.verdict] ?? '',
    budget: { limit: budget, used, remaining },
    items,
    receipts_total: receiptsTotal,
    skipped_receipts: skippedReceipts,
    corrupted_entries: corruptedEntries,
    reviews_given: reviews.length,
  }
}

/**
 * 渲染成人看的文本。
 *
 * 紧凑是硬要求（验收里有一项 2500 字符的 L1）。明细超过 limit 条时只列前 limit 条并
 * 显式写出「还有 N 条」——不静默截断，否则会让人以为那就全部。
 */
const NOTE_LIMIT = 160
// 「已通过」的 id 清单要能整列出来 —— 评审 2026-11-01 指出截断到 12 条会让大 run
// 上「给出判据 id」这一问退化。判据 id 本身很短，60 条也就几百字符；
// 真超过 60 条时写「等 N 条」并保留结构性 items 里的全量。
const PASS_ID_LIMIT = 60

export function renderRunStatus(status, { limit = 20 } = {}) {
  const lines = []
  lines.push(`## ${status.verdict} · ${status.counts}`)

  const budgetLine = Object.keys(status.budget.remaining)
    .map((bucket) => `${bucket} ${status.budget.remaining[bucket]}/${status.budget.limit[bucket]}`)
    .join(' · ')
  lines.push(`预算剩余：${budgetLine}`)

  // 通过的判据也要能看到 id。
  // 评审（2026-11-01，L3-1-F1 high）指出：只列异常项时，「哪些判据跑过了」这一问
  // 只能靠「总数减异常项」猜 —— 9 条判据的 run 里 4 个 id 在输出中根本不存在。
  // 计数回答了「过了几条」，但没回答「过的是哪几条」，而后者才是看进度时最常问的。
  const passedIds = status.items.filter((item) => item.state === '通过').map((item) => item.id)
  if (passedIds.length > 0) {
    const head = passedIds.slice(0, PASS_ID_LIMIT)
    const more = passedIds.length > head.length ? ` 等 ${passedIds.length} 条` : ''
    lines.push(`已通过：${head.join('、')}${more}`)
  }

  // 「待处理」只放真正需要动作的（没通过）。重跑过但已经通过的不属于待处理 ——
  // 原来把两者塞进同一段，会渲染成「L0-1 通过（跑了 2 次）」躺在「待处理」里，
  // 读的人第一反应是「它到底过没过」。重跑是另一类信号（说明这条判据不稳定或
  // 改过实现），单独一行足够。
  const pending = status.items.filter((item) => item.state !== '通过')
  const reruns = status.items.filter((item) => item.state === '通过' && item.attempts > 1)

  const shown = pending.slice(0, limit)
  if (shown.length > 0) {
    lines.push('待处理：')
    for (const item of shown) {
      let detail = ''
      if (item.state === '失败') {
        // 「失败」有三种成因，渲染成同一行的话，人就得多跑一次 kit_gate 才能分辨。
        if (item.reason === 'timed-out') detail = '（超时）'
        else if (item.reason === 'spawn-failed') detail = '（起不来）'
        else if (typeof item.exit_code === 'number') detail = `（退出码 ${item.exit_code}）`
        else if (item.reason !== null) detail = `（${item.reason}）`
      }
      lines.push(`- ${item.id} ${item.level} ${item.state}${detail}`)
    }
    if (pending.length > shown.length) {
      lines.push(`- …还有 ${pending.length - shown.length} 条未显示`)
    }
  }
  if (reruns.length > 0) {
    const head = reruns.slice(0, limit).map((item) => `${item.id}（${item.attempts} 次）`)
    const more = reruns.length > limit ? ` 等 ${reruns.length} 条` : ''
    lines.push(`重跑过：${head.join('、')}${more}`)
  }

  if (status.skipped_receipts > 0) {
    lines.push(`注意：${status.receipts_total} 份回执里有 ${status.skipped_receipts} 份解析失败已跳过。`)
  }
  if (status.corrupted_entries > 0) {
    lines.push(`注意：账本里有 ${status.corrupted_entries} 行解析失败已跳过，剩余预算是按已读出的行算的，实际可能更少。`)
  }
  // 这句「未传入不等于没人评过」的免责已经在 gate 的 awaitingHuman note 里说过一次
  // （带具体 id 的那句）。这里再说一遍就是同一段输出里重复两遍同一件事 ——
  // 保留 gate 那句，因为带 id，信息量更大。
  // notes 来自 evaluateGate，里面会把缺失判据的 id 全列出来。判据一多（上千条）
  // 这串 id 能占掉几千字符，而它要说的其实只是一句话。这里按条截断：主旨在前半句，
  // 明细交给上面的 items 段与「还有 N 条未显示」。
  for (const note of status.notes) {
    lines.push(note.length <= NOTE_LIMIT ? note : `${note.slice(0, NOTE_LIMIT)}…`)
  }
  lines.push('')
  lines.push(status.next_step)
  return lines.join('\n')
}
