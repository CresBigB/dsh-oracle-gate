/**
 * 领域包加载。
 *
 * 内核（kernel/）与领域无关；每个领域把自己的「该验哪些维度」放在
 * `src/adapters/<name>/domain.json`，由这里加载并校验。
 *
 * 领域包只影响 design 阶段（P1 的验收维度清单、P2 的发散视角、P3 的评审角色），
 * 不参与 oracle_gate_freeze / oracle_gate_exec / oracle_gate_gate —— 那三个必须保持领域无关，
 * 否则「换个领域就要改内核」的耦合会立刻回来。
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** `src/adapters/` 目录的绝对路径。 */
const HERE = fileURLToPath(new URL('./', import.meta.url))

/** 领域名限定为目录名，防止 `../` 之类的路径穿越。 */
const NAME_RE = /^[a-z][a-z0-9_-]*$/

/**
 * 校验一个领域包的定义。
 *
 * 返回 issues 数组，每项 `{ field, message }`；空数组表示通过。
 * 规则刻意保守：宁可要求写全，也不要让残缺的领域包悄悄影响 prompt。
 */
export function validateDomain(doc) {
  const issues = []
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return [{ field: '(root)', message: '领域包必须是一个 JSON 对象' }]
  }
  if (typeof doc.name !== 'string' || !NAME_RE.test(doc.name)) {
    issues.push({ field: 'name', message: 'name 必须是 [a-z][a-z0-9_-]* 形式的目录名' })
  }
  if (typeof doc.title !== 'string' || doc.title.trim() === '') {
    issues.push({ field: 'title', message: 'title 不能为空' })
  }
  // 至少两个视角：单视角等于没有发散，P2 的「互不可见并行」就失去意义。
  if (!Array.isArray(doc.perspectives) || doc.perspectives.length < 2) {
    issues.push({ field: 'perspectives', message: '至少需要 2 个发散视角' })
  } else {
    doc.perspectives.forEach((item, index) => {
      if (typeof item?.id !== 'string' || item.id === '') {
        issues.push({ field: `perspectives[${index}].id`, message: 'id 不能为空' })
      }
      if (typeof item?.instruction !== 'string' || item.instruction.trim() === '') {
        issues.push({ field: `perspectives[${index}].instruction`, message: 'instruction 不能为空' })
      }
    })
  }
  if (!Array.isArray(doc.reviewers) || doc.reviewers.length === 0) {
    issues.push({ field: 'reviewers', message: '至少需要 1 个评审角色' })
  } else {
    doc.reviewers.forEach((item, index) => {
      if (typeof item?.id !== 'string' || item.id === '') {
        issues.push({ field: `reviewers[${index}].id`, message: 'id 不能为空' })
      }
      if (typeof item?.focus !== 'string' || item.focus.trim() === '') {
        issues.push({ field: `reviewers[${index}].focus`, message: 'focus 不能为空' })
      }
    })
  }
  if (!Array.isArray(doc.oracles_template) || doc.oracles_template.length === 0) {
    issues.push({ field: 'oracles_template', message: '至少需要 1 条判据模板' })
  } else {
    doc.oracles_template.forEach((item, index) => {
      if (item?.level !== 'L0' && item?.level !== 'L1' && item?.level !== 'L2' && item?.level !== 'L3') {
        issues.push({ field: `oracles_template[${index}].level`, message: 'level 必须是 L0/L1/L2/L3 之一' })
      }
      if (typeof item?.criterion !== 'string' || item.criterion.trim() === '') {
        issues.push({ field: `oracles_template[${index}].criterion`, message: 'criterion 不能为空' })
      }
    })
  }
  if (doc.failure_map !== undefined) {
    if (typeof doc.failure_map !== 'object' || doc.failure_map === null || Array.isArray(doc.failure_map)) {
      issues.push({ field: 'failure_map', message: 'failure_map 必须是对象' })
    }
  }
  return issues
}

/**
 * 列出所有领域包（只读 name / title / description / counts，不返回全文）。
 *
 * 目录不存在时返回空数组而不是抛错 —— 领域包是可选增强，
 * 没有它内核照样能用。
 */
export async function listDomains() {
  let entries
  try {
    entries = await readdir(HERE, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const out = []
  for (const name of names) {
    const loaded = await loadDomain(name)
    if (!loaded.ok) {
      out.push({ name, ok: false, error: loaded.error })
      continue
    }
    out.push({
      name,
      ok: true,
      title: loaded.domain.title,
      description: loaded.domain.description ?? '',
      perspectives: loaded.domain.perspectives.length,
      reviewers: loaded.domain.reviewers.length,
      oracles_template: loaded.domain.oracles_template.length,
    })
  }
  return out
}

/**
 * 读取并校验一个领域包。
 *
 * 返回 `{ ok: true, domain }` 或 `{ ok: false, error, issues? }`。
 * 校验不通过时**不返回 domain**，避免调用方拿着半成品去拼 prompt。
 */
export async function loadDomain(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, error: 'domain-name-invalid' }
  }
  let raw
  try {
    raw = await readFile(join(HERE, name, 'domain.json'), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, error: 'domain-not-found' }
    return { ok: false, error: `domain-unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `domain-invalid-json: ${error instanceof Error ? error.message : String(error)}` }
  }
  const issues = validateDomain(doc)
  if (issues.length > 0) return { ok: false, error: 'domain-invalid', issues }
  if (doc.name !== name) {
    return { ok: false, error: `domain-name-mismatch: 目录名 ${name} 与文件内 name ${doc.name} 不一致` }
  }
  return { ok: true, domain: doc }
}

/**
 * 把领域包里的判据模板渲染成 prompt 用的一段文字。
 *
 * 只给「该验什么 + 命令长什么样」，不给确切命令 —— 确切命令必须由 P1
 * 结合 oracle_gate_inventory 的盘点结果写出来，否则模板会变成硬编码。
 */
export function renderOracleTemplate(domain) {
  const lines = []
  const byLevel = new Map()
  for (const item of domain.oracles_template) {
    if (!byLevel.has(item.level)) byLevel.set(item.level, [])
    byLevel.get(item.level).push(item)
  }
  for (const level of ['L0', 'L1', 'L2', 'L3']) {
    const items = byLevel.get(level)
    if (!items || items.length === 0) continue
    lines.push(`${level}：`)
    for (const item of items) {
      lines.push(item.hint ? `- ${item.criterion}（例如 ${item.hint}）` : `- ${item.criterion}`)
    }
  }
  return lines.join('\n')
}

/**
 * 把领域包压缩成注入 workflow args 的纯文本。
 *
 * workflow 沙箱没有文件系统，领域包只能以文本形式经 args 传进去。
 */
export function compactDomain(domain) {
  const lines = []
  lines.push(`领域：${domain.title}（${domain.name}）`)
  if (domain.description) lines.push(domain.description)
  lines.push('')
  lines.push('### 该领域的验收维度模板')
  lines.push('以下是这个领域通常要验的维度；结合本次盘点结果挑适用的，命令必须替换成本项目真实可执行的形态。')
  lines.push(renderOracleTemplate(domain))
  lines.push('')
  lines.push('### 复盘时常见的失败归因')
  for (const [key, value] of Object.entries(domain.failure_map ?? {})) {
    lines.push(`- ${key}：${value}`)
  }
  if (domain.holdout) {
    lines.push('')
    lines.push('### 留出集形态')
    lines.push(domain.holdout)
  }
  return lines.join('\n')
}
