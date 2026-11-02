/**
 * 期 3 / 3.5 / 3.6 协议的纯逻辑测试：用 mock 的 agent/parallel 执行生成的 workflow 脚本，
 * 验证控制流与 P4 硬门计算，不启动任何真实子代理。
 *
 * 用法：node tests/design-protocol.test.mjs
 */

import { buildDesignScript, buildClarifyScript, compactInventory } from '../src/protocols/design.js'

const designScript = buildDesignScript()
const clarifyScript = buildClarifyScript()
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/** 清单文本：reuses 只能引用这里出现过的路径，否则算编造。 */
const INVENTORY = [
  '可复用资产（路径:行号 — 类型 — 名称）：',
  '- src/components/FlexTable.vue:1 — component — FlexTable',
  '- src/components/SearchBox.vue:1 — component — SearchBox',
  '- src/utils/debounce.ts:12 — function — debounce',
].join('\n')

/**
 * 构造一个可控的 script 执行器。
 *
 * @param {object} [options]
 * @param {boolean} [options.p1Fails] P1 返回 null
 * @param {number} [options.failingDesigner] 第 N 个设计者返回 null（1-based）
 * @param {boolean} [options.ignoredList] 评审认定无视既有资产
 * @param {number} [options.fabricate] 第 N 个方案编造一个不存在的复用路径
 * @param {boolean} [options.withRequirementUnknowns] 第二个方案报需求歧义
 * @param {boolean} [options.withEvidenceUnknowns] 第二个方案报证据缺口
 * @param {boolean} [options.vetoed] 第一个方案被投否决票
 * @param {boolean} [options.duplicateChoice] 所有方案结构选择相同
 * @param {boolean} [options.noEvidence] 评审不给 evidence_refs
 * @param {boolean} [options.noApplicableAsset] 方案不复用任何资产，评审如实判定清单用不上
 * @param {boolean} [options.contradictoryNoAsset] 方案明明复用了资产，评审却说清单用不上
 * @param {boolean} [options.vagueNoAsset] 说清单用不上，但理由只有几个字
 * @param {number} [options.questionCount] P1 返回几道决策题（默认 0）
 * @param {number} [options.readingCount] P1 返回几种解读（默认 0，即单解读）
 * @param {string} [options.stage] 传给脚本的 stage（默认 'all'）
 * @param {object} [options.spec] stage=design 时传入的已决议 spec
 */
function runScript(options = {}) {
  const {
    p1Fails = false,
    failingDesigner = -1,
    ignoredList = false,
    fabricate = -1,
    withRequirementUnknowns = false,
    withEvidenceUnknowns = false,
    vetoed = false,
    duplicateChoice = false,
    noEvidence = false,
    noApplicableAsset = false,
    contradictoryNoAsset = false,
    vagueNoAsset = false,
    sameReuse = false,
    questionCount = 0,
    readingCount = 0,
    stage = 'all',
    spec = undefined,
  } = options

  const events = []
  const choices = ['输入即过滤', '回车触发过滤', '防抖后过滤']
  const mockQuestions = Array.from({ length: questionCount }, (_, i) => ({
    id: `q${i + 1}`,
    kind: 'requirement',
    question: `第 ${i + 1} 个待定事项？`,
    context: '代码现状：src/components/SearchBox.vue:1 已有一个非实时搜索框',
    options: [
      { label: '改造现有', impact: '改 SearchBox.vue，验收改为实时', files: ['src/components/SearchBox.vue:1'] },
      { label: '新增一个', impact: '新增组件，两个搜索入口', files: ['src/components/SearchBox.vue:1'] },
    ],
    recommended: '改造现有',
    reason: '避免两个搜索入口',
    example: '输入 大庆 时，选改造则原框变实时，选新增则出现两个框',
  }))
  const mockReadings = Array.from({ length: readingCount }, (_, i) => ({
    id: `r${i + 1}`,
    summary: `第 ${i + 1} 种理解`,
    target_files: [`src/target${i + 1}.vue`],
  }))

  const agent = async (prompt, agentOptions = {}) => {
    const label = agentOptions.label ?? ''
    events.push(label)

    if (label === 'P1-术语落地') {
      if (p1Fails) return null
      return {
        terms: [
          {
            term: '井列表',
            hit_count: 1,
            verdict: 'unique',
            candidates: ['src/components/FlexTable.vue:1 — 井列表渲染'],
            note: '唯一命中',
          },
        ],
        questions: mockQuestions,
        goal: '给井列表加按井名搜索',
        acceptance: [
          { criterion: '输入井名后列表只剩名称匹配的井', level: 'L0', check: 'pnpm test:e2e -- well-search' },
          { criterion: '输入为空时恢复显示全部井', level: 'L1', check: '渲染耗时 < 100ms' },
          { criterion: '搜索框样式与现有输入框一致', level: 'L2', check: '人工判断' },
        ],
        constraints: ['未指定'],
        readings: mockReadings,
      }
    }

    if (label.startsWith('P2-')) {
      const index = Number(label.match(/方案(\d+)$/)?.[1] ?? '0')
      const readingTag = label.match(/^P2-(r\d+)-/)?.[1] ?? ''
      if (index === failingDesigner && readingTag === '') return null
      if (index === failingDesigner && readingTag === 'r1') return null
      // 每个方案侧重不同的资产组合：真实情况下不同视角关注的现成资产不会完全一样，
      // 若三个方案复用集合完全相同，去重硬门本来就该判红。
      const reusePool = [
        'src/components/FlexTable.vue:1 — 复用表格渲染与空态',
        'src/components/SearchBox.vue:1 — 复用搜索输入框',
        'src/utils/debounce.ts:12 — 复用防抖工具',
      ]
      const reuses = noApplicableAsset || vagueNoAsset
        ? []
        : sameReuse
          ? [reusePool[0], reusePool[1]]
          : [reusePool[index - 1], reusePool[index % 3]]
      if (index === fabricate && readingTag === '') {
        reuses.push('src/components/FilterPanel.vue:8 — 这个文件根本不存在')
      }
      return {
        name: readingTag === '' ? `设计${index}` : `${readingTag}-设计${index}`,
        summary: `第 ${index} 个方案：用${choices[index - 1] ?? '自定义'}方式实现筛选`,
        structural_choice: duplicateChoice
          ? '筛选时机=输入即过滤'
          : `${readingTag}筛选时机=${choices[index - 1] ?? '自定义'}`,
        reuses,
        tradeoffs: ['放弃一部分定制性'],
        risks: ['大数据量下渲染变慢'],
        second_option: '改为服务端过滤，当井数量超过一万条时更合适',
      }
    }

    if (label.startsWith('P3-评审-')) {
      const design = label.replace('P3-评审-', '')
      const isFirst = design === '设计1'
      const isSecond = design === '设计2'
      const unknowns = []
      if (withRequirementUnknowns && isSecond) {
        unknowns.push({ kind: 'requirement', text: '「按井名」是只匹配井节点，还是沿用现状的全层级匹配？' })
      }
      if (withEvidenceUnknowns && isSecond) {
        unknowns.push({ kind: 'evidence', text: '本地库 md_well 全表为空，无法验证大数据量下的性能' })
      }
      return {
        design,
        verdict: 'recommend',
        veto: vetoed && isFirst,
        unknowns,
        reuse_verdict:
          noApplicableAsset || contradictoryNoAsset || vagueNoAsset
            ? 'no-applicable-asset'
            : ignoredList
              ? 'ignored-list'
              : 'fully-reused',
        reuse_reason: vagueNoAsset
          ? '没用上'
          : noApplicableAsset || contradictoryNoAsset
            ? '清单里的资产全是表格与水力学相关类型，本需求是树结构过滤，没有任何一条可以复用，改动完全落在现有的树组件与过滤谓词上。'
            : '方案复用了 FlexTable 与 SearchBox，没有重复实现表格和输入框逻辑',
        evidence_refs: noEvidence ? [] : ['src/components/FlexTable.vue:1'],
        issues: [],
        recommended: design,
      }
    }

    return null
  }

  const parallel = async (thunks) => Promise.all(thunks.map((thunk) => thunk()))
  const phase = (name) => events.push(`phase:${name}`)
  const log = (message) => events.push(`log:${message}`)

  const baseArgs = {
    requirement: '给井浏览器加按井名搜索的输入框',
    inventory: INVENTORY,
    root: 'E:/demo',
    perspectives: ['最小改动', '一致性优先', '性能优先'],
  }
  const args = { ...baseArgs, stage }
  if (spec !== undefined) args.spec = spec

  const script = stage === 'clarify' ? clarifyScript : designScript
  const fn = new AsyncFunction('args', 'phase', 'log', 'agent', 'parallel', script)
  return fn(args, phase, log, agent, parallel)
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  OK   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('用例 1：三个视角全部产出、评审、准入')
{
  const value = await runScript()
  const gate = value.gate
  check('designs_produced = 3', gate.designs_produced === 3, String(gate.designs_produced))
  check('designs_admitted = 3', gate.designs_admitted === 3, String(gate.designs_admitted))
  check('designs_blocked_on_human = 0', gate.designs_blocked_on_human === 0)
  check('designs_rejected = 0', gate.designs_rejected === 0)
  check('all_reuse_paths_verified', gate.all_reuse_paths_verified)
  check('all_evidence_backed', gate.all_evidence_backed)
  check('structural_choices_distinct', gate.structural_choices_distinct)
  check('designs_are_distinct', gate.designs_are_distinct)
  check('reuse_overlap_max ≈ 0.33（两两共享一条复用资产）', Math.abs(gate.reuse_overlap_max - 0.33) < 0.01, String(gate.reuse_overlap_max))
  check(
    '分层判据计数 L0=1 L1=1 L2=1',
    value.acceptance_levels.L0 === 1 && value.acceptance_levels.L1 === 1 && value.acceptance_levels.L2 === 1,
    JSON.stringify(value.acceptance_levels),
  )
  check('verdict = admitted', value.verdict === 'admitted', value.verdict)
  check('术语落地结果被带出', value.terms.length === 1 && value.terms[0].verdict === 'unique')
}

console.log('用例 2：P1 澄清失败时后续仍能推进')
{
  const value = await runScript({ p1Fails: true })
  check('未崩溃且 ok = true', value.ok === true)
  check('仍产出 3 个方案', value.designs.length === 3)
  check('分层判据全为 0', Object.values(value.acceptance_levels).every((n) => n === 0))
}

console.log('用例 3：一个设计者失败时按实际产出计数')
{
  const value = await runScript({ failingDesigner: 2 })
  check('designs_produced = 2', value.gate.designs_produced === 2, String(value.gate.designs_produced))
  check('designs_expected 仍为 3', value.gate.designs_expected === 3, String(value.gate.designs_expected))
  check('两个方案都被评审', value.gate.all_reviewed)
}

console.log('用例 4：评审认定无视既有资产')
{
  const value = await runScript({ ignoredList: true })
  check('any_ignored_existing_assets = true', value.gate.any_ignored_existing_assets)
}

console.log('用例 5：编造复用路径的方案被否决')
{
  const value = await runScript({ fabricate: 1 })
  const target = value.checks.find((item) => item.design === '设计1')
  check('decision = rejected', target.decision === 'rejected', target.decision)
  check('blocked_by 指向 fabricated-reuse-path', target.blocked_by.includes('fabricated-reuse-path'))
  check('记录了编造的路径', target.reuse_fabricated.length === 1)
  check('gate.any_fabricated_reuse = true', value.gate.any_fabricated_reuse)
  check('gate.all_reuse_paths_verified = false', value.gate.all_reuse_paths_verified === false)
  check('其余方案仍准入（admitted = 2）', value.gate.designs_admitted === 2, String(value.gate.designs_admitted))
}

console.log('用例 6：只缺需求信息时判 blocked-on-human，不算失败')
{
  const value = await runScript({ withRequirementUnknowns: true })
  const target = value.checks.find((item) => item.design === '设计2')
  check('decision = blocked-on-human', target.decision === 'blocked-on-human', target.decision)
  check('blocked_by 指向 requirement-unknowns', target.blocked_by.includes('requirement-unknowns'))
  check('gate.designs_blocked_on_human = 1', value.gate.designs_blocked_on_human === 1)
  check('gate.designs_rejected = 0', value.gate.designs_rejected === 0)
  check('gate.any_requirement_unknowns = true', value.gate.any_requirement_unknowns)
  check('gate.any_evidence_unknowns = false', value.gate.any_evidence_unknowns === false)
  check('其余两个方案仍准入', value.gate.designs_admitted === 2, String(value.gate.designs_admitted))
}

console.log('用例 7：缺证据时判 rejected，与缺需求区分开')
{
  const value = await runScript({ withEvidenceUnknowns: true })
  const target = value.checks.find((item) => item.design === '设计2')
  check('decision = rejected', target.decision === 'rejected', target.decision)
  check('blocked_by 指向 evidence-unknowns', target.blocked_by.includes('evidence-unknowns'))
  check('gate.designs_blocked_on_human = 0', value.gate.designs_blocked_on_human === 0)
  check('gate.any_evidence_unknowns = true', value.gate.any_evidence_unknowns)
}

console.log('用例 8：行使否决权即 rejected')
{
  const value = await runScript({ vetoed: true })
  const target = value.checks.find((item) => item.design === '设计1')
  check('decision = rejected', target.decision === 'rejected', target.decision)
  check('blocked_by 指向 veto', target.blocked_by.includes('veto'))
  check('gate.any_veto = true', value.gate.any_veto)
}

console.log('用例 9：评审没有给出清单依据即 rejected')
{
  const value = await runScript({ noEvidence: true })
  check('所有方案都不准入', value.gate.designs_admitted === 0)
  check('gate.all_evidence_backed = false', value.gate.all_evidence_backed === false)
  check('verdict = rejected', value.verdict === 'rejected', value.verdict)
  check('next 提示定位 blocked_by', value.next.includes('blocked_by'))
}

console.log('用例 10：结构选择重复视为没有真正发散')
{
  const value = await runScript({ duplicateChoice: true })
  check('structural_choices_distinct = false', value.gate.structural_choices_distinct === false)
  check('designs_are_distinct = false', value.gate.designs_are_distinct === false)
}

console.log('用例 11：清单确实没有可用资产时，诚实说明也算有据可依')
{
  const value = await runScript({ noApplicableAsset: true })
  check('all_have_reuse_evidence = true', value.gate.all_have_reuse_evidence === true)
  check('每个方案 reuse_justified', value.checks.every((item) => item.reuse_justified))
  check(
    'reuse_verdict 记为 no-applicable-asset',
    value.checks.every((item) => item.reuse_verdict === 'no-applicable-asset'),
  )
}

console.log('用例 12：嘴上说清单用不上、实际却复用了资产，算矛盾')
{
  const value = await runScript({ contradictoryNoAsset: true })
  check('all_have_reuse_evidence = false', value.gate.all_have_reuse_evidence === false)
  check('每个方案 reuse_justified = false', value.checks.every((item) => item.reuse_justified === false))
  check('gate.any_reuse_contradiction = true', value.gate.any_reuse_contradiction)
}

console.log('用例 13：说清单用不上但没给理由，不算有据可依')
{
  const value = await runScript({ vagueNoAsset: true })
  check('all_have_reuse_evidence = false', value.gate.all_have_reuse_evidence === false)
  check(
    'reuse_reason_len 记录了实际长度',
    value.checks.every((item) => item.reuse_reason_len === 3),
    String(value.checks[0]?.reuse_reason_len),
  )
}

console.log('用例 14：stage=clarify 只跑 P1，返回问题与草稿 spec')
{
  const value = await runScript({ stage: 'clarify', questionCount: 2 })
  check('stage = clarify', value.stage === 'clarify')
  check('返回 2 道题', value.questions.length === 2, String(value.questions.length))
  check('题目带 2 个选项', value.questions[0].options.length === 2)
  check('题目带推荐值', value.questions[0].recommended === '改造现有')
  check('draft_spec 已产出', value.draft_spec !== null && value.draft_spec.acceptance.length === 3)
  check('默认假设由推荐值生成', value.default_assumptions.length === 2)
  check('没有真的跑 P2', !value.designs)
}

console.log('用例 15：问题超过 3 道时，多出的降级为假设而不是丢掉')
{
  const value = await runScript({ stage: 'clarify', questionCount: 5 })
  check('只保留 3 道题', value.questions.length === 3, String(value.questions.length))
  check('2 道被记为 deferred', value.deferred_questions.length === 2)
  check('5 条默认假设都保留了', value.default_assumptions.length === 5, String(value.default_assumptions.length))
}

console.log('用例 16：多解读时按解读分别出方案')
{
  const value = await runScript({ readingCount: 2 })
  check('方案数 = 2 解读 × 3 视角', value.gate.designs_expected === 6, String(value.gate.designs_expected))
  check('实际产出 6 个方案', value.designs.length === 6, String(value.designs.length))
  check(
    '方案名带解读前缀',
    value.designs.every((item) => /^r\d+-设计\d+$/.test(item.name)),
    JSON.stringify(value.designs.map((item) => item.name)),
  )
}

console.log('用例 17：采用默认假设时标 admitted-under-assumptions 并附待确认清单')
{
  const value = await runScript({ stage: 'clarify', questionCount: 1 })
  const assumption = value.default_assumptions
  const design = await runScript({ stage: 'design', spec: { ...value.draft_spec, assumptions: assumption } })
  check('verdict = admitted-under-assumptions', design.verdict === 'admitted-under-assumptions', design.verdict)
  check('gate.under_assumptions = true', design.gate.under_assumptions)
  check('pending_assumptions 带出了待确认项', design.pending_assumptions.length === 1)
  check('next 提示先确认假设', design.next.includes('未确认的假设'))
}

console.log('用例 18：多个评审一致提出的需求歧义会聚成下一轮问题')
{
  const value = await runScript({ withRequirementUnknowns: true })
  check(
    '一致 unknowns 聚类（<2 个评审提及时为空）',
    Array.isArray(value.consistent_unknowns),
    JSON.stringify(value.consistent_unknowns),
  )
  check('有 blocked-on-human 时给出下一轮问题字段', Array.isArray(value.next_round_questions))
}

console.log('用例 19：compactInventory 同目录折叠')
{
  const fake = {
    root: 'E:/demo',
    focus: '按钮',
    assets: Array.from({ length: 50 }, (_, i) => ({
      path: `src/a/C${i}.vue`,
      line: i + 1,
      kind: 'component',
      name: `C${i}`,
    })),
    conventions: Array.from({ length: 20 }, (_, i) => ({
      path: `src/s${i}.scss`,
      line: i + 1,
      name: `--c${i}`,
      value: '#fff',
    })),
    similar: Array.from({ length: 40 }, (_, i) => ({
      path: `src/f${i}.vue`,
      hits: [{ line: 1, needle: 'button', text: 'x' }],
    })),
  }
  const text = compactInventory(fake)
  // 折叠说明行同样以 `- src/a` 开头，必须先排除，否则会把 6 条资产误数成 7 条。
  const assetLines = text
    .split('\n')
    .filter((line) => /^- src\/a\/C\d+\.vue:\d+ — /.test(line)).length
  const convLines = text.split('\n').filter((line) => line.startsWith('- src/s')).length
  const simLines = text.split('\n').filter((line) => line.startsWith('- src/f')).length
  check('同目录只展开 6 条', assetLines === 6, String(assetLines))
  check('折叠说明标注了剩余条数', text.includes('另有 44 条同类'))
  check('约定截到 15 条', convLines === 15, String(convLines))
  check('相关文件截到 20 条', simLines === 20, String(simLines))
  check('相关文件标注了剩余数量', text.includes('另有 20 个文件'))
}

console.log('用例 20：资产分散在多目录时不折叠')
{
  const fake = {
    root: 'E:/demo',
    focus: '按钮',
    assets: Array.from({ length: 20 }, (_, i) => ({
      path: `src/d${i % 10}/C${i}.vue`,
      line: 1,
      kind: 'component',
      name: `C${i}`,
    })),
    conventions: [],
    similar: [],
  }
  const text = compactInventory(fake)
  const lines = text.split('\n').filter((line) => line.startsWith('- src/d'))
  check('20 条全部展开（每目录 2 条）', lines.length === 20, String(lines.length))
  check('没有折叠说明', !text.includes('未逐条展开'))
}

console.log('用例 21：清单贫瘠导致复用集合完全重叠时，只要结构选择不同仍算发散')
{
  const value = await runScript({ sameReuse: true })
  check('三个方案复用同样两条资产', value.gate.reuse_overlap_max === 1, String(value.gate.reuse_overlap_max))
  check('结构选择两两不同', value.gate.structural_choices_distinct === true)
  check('designs_are_distinct = true（不再被复用重叠度误伤）', value.gate.designs_are_distinct === true)
}

console.log('用例 22：硬门与需求缺口并存时，两类原因都记进 blocked_by')
{
  const value = await runScript({ withRequirementUnknowns: true, withEvidenceUnknowns: true })
  const target = value.checks.find((item) => item.design === '设计2')
  check('设计2 被硬门判 rejected', target.decision === 'rejected', String(target.decision))
  check('blocked_by 含 evidence-unknowns', target.blocked_by.includes('evidence-unknowns'), target.blocked_by.join(','))
  check('blocked_by 同时含 requirement-unknowns', target.blocked_by.includes('requirement-unknowns'), target.blocked_by.join(','))
  check('gate.designs_with_requirement_gaps = 1', value.gate.designs_with_requirement_gaps === 1, String(value.gate.designs_with_requirement_gaps))
  check('gate.designs_blocked_on_human 仍为 0（硬门优先）', value.gate.designs_blocked_on_human === 0)
}

console.log('')
if (failures > 0) {
  console.log(`${failures} 项失败`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
