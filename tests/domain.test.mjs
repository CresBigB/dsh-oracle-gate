/**
 * 领域包加载与校验的单测（不含 @deepseek-ai/dsh-tools 依赖，可直接 node 跑）。
 *
 * 重点不在「能读 JSON」，而在：残缺的领域包不会被当成可用的，
 * 因为它的内容会直接进 P1/P2/P3 的 prompt —— 半成品比没有更坏。
 */
import {
  compactDomain,
  listDomains,
  loadDomain,
  renderOracleTemplate,
  validateDomain,
} from '../src/adapters/index.js'

let passed = 0
let failed = 0
function check(label, ok) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}
function report() {
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) process.exitCode = 1
}

console.log('[1] 内置 backend 领域包可加载')
{
  const loaded = await loadDomain('backend')
  check('loadDomain(backend) 成功', loaded.ok === true)
  check('name 与目录名一致', loaded.domain?.name === 'backend')
  check('至少 3 个发散视角', (loaded.domain?.perspectives.length ?? 0) >= 3)
  check('至少 3 个评审角色', (loaded.domain?.reviewers.length ?? 0) >= 3)
  check('判据模板覆盖 L0 与 L1', ['L0', 'L1'].every((level) => loaded.domain?.oracles_template.some((item) => item.level === level)))
  const ids = loaded.domain.perspectives.map((item) => item.id)
  check('视角 id 不重复', new Set(ids).size === ids.length)
  const reviewerIds = loaded.domain.reviewers.map((item) => item.id)
  check('评审 id 不重复', new Set(reviewerIds).size === reviewerIds.length)
}

console.log('[2] 加载失败的三种情形都返回明确错误')
{
  check('不存在的领域 → domain-not-found', (await loadDomain('nope')).error === 'domain-not-found')
  check('路径穿越 → domain-name-invalid', (await loadDomain('../backend')).error === 'domain-name-invalid')
  check('大写名 → domain-name-invalid', (await loadDomain('Backend')).error === 'domain-name-invalid')
  check('空串 → domain-name-invalid', (await loadDomain('')).error === 'domain-name-invalid')
  check('非字符串 → domain-name-invalid', (await loadDomain(null)).error === 'domain-name-invalid')
}

console.log('[3] validateDomain 拦得住残缺定义')
{
  const base = {
    name: 'demo',
    title: '演示',
    perspectives: [{ id: 'a', instruction: 'x' }, { id: 'b', instruction: 'y' }],
    reviewers: [{ id: 'r', focus: 'z' }],
    oracles_template: [{ level: 'L0', criterion: '编译通过' }],
  }
  check('完整的定义无 issue', validateDomain(base).length === 0)
  check('非对象被拦', validateDomain([]).length === 1)
  check('缺 title 被拦', validateDomain({ ...base, title: '  ' }).some((issue) => issue.field === 'title'))
  check(
    '视角少于 2 个被拦',
    validateDomain({ ...base, perspectives: [{ id: 'a', instruction: 'x' }] }).some((issue) => issue.field === 'perspectives'),
  )
  check(
    '视角缺 instruction 被拦',
    validateDomain({ ...base, perspectives: [{ id: 'a' }, { id: 'b', instruction: 'y' }] })
      .some((issue) => issue.field === 'perspectives[0].instruction'),
  )
  check('评审为空被拦', validateDomain({ ...base, reviewers: [] }).some((issue) => issue.field === 'reviewers'))
  check('判据模板为空被拦', validateDomain({ ...base, oracles_template: [] }).some((issue) => issue.field === 'oracles_template'))
  check(
    '非法 level 被拦',
    validateDomain({ ...base, oracles_template: [{ level: 'L9', criterion: 'x' }] })
      .some((issue) => issue.field === 'oracles_template[0].level'),
  )
  check(
    'failure_map 非对象被拦',
    validateDomain({ ...base, failure_map: [] }).some((issue) => issue.field === 'failure_map'),
  )
}

console.log('[4] 渲染出的文本带上了关键信息')
{
  const { domain } = await loadDomain('backend')
  const rendered = renderOracleTemplate(domain)
  check('按层级分组', rendered.includes('L0：') && rendered.includes('L1：') && rendered.includes('L2：'))
  check('带 hint 的条目渲染成「（例如 …）」', rendered.includes('（例如'))

  const compact = compactDomain(domain)
  check('含领域标题', compact.includes('后端服务'))
  check('含验收维度模板段', compact.includes('### 该领域的验收维度模板'))
  check('含失败归因段', compact.includes('### 复盘时常见的失败归因'))
  check('含留出集段', compact.includes('### 留出集形态'))
  check('不含 null/undefined 字样', !compact.includes('undefined') && !compact.includes('null'))
}

console.log('[5] listDomains 汇总可用领域')
{
  const domains = await listDomains()
  check('至少一个领域', domains.length >= 1)
  const backend = domains.find((item) => item.name === 'backend')
  check('backend 在列表里且 ok', backend?.ok === true)
  check('汇总里带视角/评审/模板计数', backend?.perspectives >= 3 && backend?.reviewers >= 3 && backend?.oracles_template >= 1)
  check('不返回 domain 全文', backend?.oracles_template !== undefined && backend?.description !== undefined)
}

console.log('[6] frontend 领域包')
{
  const loaded = await loadDomain('frontend')
  const domain = loaded.domain
  check('可加载且校验通过', loaded.ok === true)
  check('视角 3 条', domain?.perspectives?.length === 3)
  check('评审 3 条', domain?.reviewers?.length === 3)
  check('判据模板 9 条', domain?.oracles_template?.length === 9)
  check(
    '判据 level 都在 L0–L3',
    (domain?.oracles_template ?? []).every((item) => ['L0', 'L1', 'L2', 'L3'].includes(item.level)),
  )
  check('视角 id 不重复', new Set((domain?.perspectives ?? []).map((item) => item.id)).size === 3)
  check('评审 id 不重复', new Set((domain?.reviewers ?? []).map((item) => item.id)).size === 3)
  check('六类失败归因齐全', Object.keys(domain?.failure_map ?? {}).length === 6)
  check('留出集形态非空', typeof domain?.holdout === 'string' && domain.holdout.length > 50)

  const compact = compactDomain(domain)
  check('压缩文本含前端标题', compact.includes('前端界面'))
  check('压缩文本无 null/undefined', !compact.includes('undefined') && !compact.includes('null'))
  const renderedFrontend = renderOracleTemplate(domain)
  check('渲染含 axe 与包体积判据', renderedFrontend.includes('axe') && renderedFrontend.includes('包体积'))
}

console.log('[7] architecture 领域包')
{
  const loaded = await loadDomain('architecture')
  const domain = loaded.domain
  check('可加载且校验通过', loaded.ok === true)
  check('视角 3 条', domain?.perspectives?.length === 3)
  check('含边界优先视角', (domain?.perspectives ?? []).some((item) => item.id === 'boundary-first'))
  check('评审 3 条', domain?.reviewers?.length === 3)
  check('含依赖与分层评审', (domain?.reviewers ?? []).some((item) => item.id === 'dependency-and-layering'))
  check('判据模板 9 条', domain?.oracles_template?.length === 9)
  check(
    '判据 level 都在 L0–L3',
    (domain?.oracles_template ?? []).every((item) => ['L0', 'L1', 'L2', 'L3'].includes(item.level)),
  )
  check('六类失败归因齐全', Object.keys(domain?.failure_map ?? {}).length === 6)
  check('留出集以变更冲击测试为主', (domain?.holdout ?? '').includes('变更冲击测试'))

  const compact = compactDomain(domain)
  check('压缩文本含架构标题', compact.includes('架构设计'))
  check('压缩文本无 null/undefined', !compact.includes('undefined') && !compact.includes('null'))
  const rendered = renderOracleTemplate(domain)
  check('渲染含依赖图与分层规则判据', rendered.includes('依赖图无环') && rendered.includes('分层规则'))
}

report()
