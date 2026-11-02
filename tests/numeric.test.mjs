// 数值内核自测。重点不是「算得对」，而是「不许悄悄变宽」。
import {
  compareSeries,
  interpolate1d,
  predict,
  convertValue,
  validateThresholds,
  normalizePoints,
  finiteNumber,
  UNIT_CONVERSIONS,
  RELATIVE_FLOOR_LIMIT,
  MAX_TARGET,
  MAX_THRESHOLD,
} from '../src/kernel/numeric.js'

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    const ok = fn()
    if (ok === false) throw new Error('断言为 false')
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error.message}`)
  }
}

function throws(label, fn, expect) {
  check(label, () => {
    try {
      fn()
    } catch (error) {
      if (expect && !error.message.includes(expect)) {
        throw new Error(`报错信息里没有「${expect}」，实际是「${error.message}」`)
      }
      return true
    }
    throw new Error('本该抛错却没抛')
  })
}

// 单位必须显式声明（内核会拒绝缺省 unit 的绑定），工厂默认按压力 bar，
// 需要别的单位时由调用点传 fromUnit。
function series(values, { fromUnit = 'bar', scale, offset } = {}) {
  return {
    unit: fromUnit,
    scale,
    offset,
    points: values.map(([t, v]) => ({ coord: [t], value: v })),
  }
}

const BASE = Array.from({ length: 11 }, (_, i) => [i, 100 + 10 * i])

console.log('[1] 完全一致的曲线')
{
  const result = compareSeries({
    name: 'same',
    unit: 'bar',
    relative_floor: 1,
    reference: series(BASE),
    candidate: series(BASE),
  })
  check('max_relative 为 0', () => result.max_relative === 0)
  check('pass 为 true', () => result.pass === true)
  check('对齐方式全部是 exact', () => result.alignment_counts.exact === 11)
  check('coverage 为 1', () => result.coverage === 1)
  check('claim 里说明插值不是原始观测', () => result.claim.includes('插值不是原始同时刻观测'))
}

console.log('[2] 误差在阈值之内与之外')
{
  // 全部点高 4%：最大相对误差 0.04，落在 target 0.05 以内
  const inside = compareSeries({
    name: 'inside',
    unit: 'bar',
    relative_floor: 1,
    reference: series(BASE),
    candidate: series(BASE.map(([t, v]) => [t, v * 1.04])),
  })
  check('4% 偏差 pass', () => inside.pass === true)
  check('4% 偏差在 target 内', () => inside.within_target === true)

  // 单点高 20%：超过 maximum 0.10，必须失败
  const outside = compareSeries({
    name: 'outside',
    unit: 'bar',
    relative_floor: 1,
    reference: series(BASE),
    candidate: series(BASE.map(([t, v]) => [t, t === 5 ? v * 1.2 : v])),
  })
  check('单点 20% 偏差 fail', () => outside.pass === false)
  check('worst 定位到 t=5', () => outside.worst.coord[0] === 5)
  check('worst.relative 约 0.2', () => Math.abs(outside.worst.relative - 0.2) < 1e-9)
}

console.log('[3] 温度：K 换到 ℃，且不以 ~300K 作分母')
{
  // 参考用 K 给，候选用 ℃ 给，物理上是同一条曲线
  const refPoints = Array.from({ length: 5 }, (_, i) => ({ coord: [i], value: 293.15 + i }))
  const candPoints = Array.from({ length: 5 }, (_, i) => ({ coord: [i], value: 20 + i }))
  const same = compareSeries({
    name: 'temp-same',
    unit: 'degC',
    relative_floor: 10,
    reference: { unit: 'K', scale: 1, offset: -273.15, points: refPoints },
    candidate: { unit: 'degC', points: candPoints },
  })
  check('K/℃ 换算后误差为 0', () => same.max_relative === 0)

  // 20℃ vs 21℃：绝对差 1℃，分母取参考值 20℃ -> 相对误差 1/20 = 0.05。
  // 若拿 300K 当分母，同一个物理差异会被稀释成 0.0033 —— 这正是 v4 禁止的。
  const shifted = compareSeries({
    name: 'temp-shifted',
    unit: 'degC',
    relative_floor: 10,
    reference: { unit: 'degC', points: [{ coord: [0], value: 20 }] },
    candidate: { unit: 'degC', points: [{ coord: [0], value: 21 }] },
  })
  check('20℃ vs 21℃ 的相对误差按摄氏参考值作分母', () => Math.abs(shifted.max_relative - 0.05) < 1e-9)
}

console.log('[4] 单位换算与护栏')
{
  check('MPa -> bar 乘 10', () => convertValue(1, 'bar', 'MPa', 10, 0) === 10)
  check('sg -> kg/m3 乘 1000', () => convertValue(1.2, 'kg/m3', 'sg', 1000, 0) === 1200)
  throws('换算系数与规范不符要报错', () => convertValue(1, 'bar', 'MPa', 1, 0), '单位换算与规范不一致')
  throws('未知源单位要报错', () => convertValue(1, 'bar', 'psi', 1, 0), '不在')
  throws('未知目标单位要报错', () => convertValue(1, 'furlong', 'm', 1, 0), '物理单位')
  throws('target 超过 5% 要拒绝', () => validateThresholds('bar', { target: 0.1, maximum: 0.1, relativeFloor: 1 }), 'target')
  throws('maximum 超过 10% 要拒绝', () => validateThresholds('bar', { target: 0.05, maximum: 0.2, relativeFloor: 1 }), 'maximum')
  throws('maximum 小于 target 要拒绝', () => validateThresholds('bar', { target: 0.05, maximum: 0.01, relativeFloor: 1 }), 'maximum')
  throws('floor 超过单位上限要拒绝', () => validateThresholds('dimensionless', { relativeFloor: 1 }), 'relative_floor')
  check('degC 的 floor 上限是 10', () => RELATIVE_FLOOR_LIMIT.degC === 10)
  check('硬上限常量没被放宽', () => MAX_TARGET === 0.05 && MAX_THRESHOLD === 0.1)
}

console.log('[5] 不外推')
{
  const candidate = series(BASE.slice(0, 3)) // 只覆盖 t=0,1,2
  throws(
    '参考点在候选覆盖范围外要报错',
    () =>
      compareSeries({
        name: 'extrapolate',
        unit: 'bar',
        relative_floor: 1,
        reference: series(BASE),
        candidate,
      }),
    '不允许外推',
  )
  const inner = new Map([[0, 1], [1, 3]])
  throws('interpolate1d 越界报错', () => interpolate1d(inner, 5, 'exact', 0), '不允许外推')
  check('区间内可插值', () => interpolate1d(inner, 0.5, 'linear', 0).value === 2)
  check('插值 kind 标记为 interpolated', () => interpolate1d(inner, 0.5, 'linear', 0).kind === 'interpolated')
  check('精确命中 kind 为 exact', () => interpolate1d(inner, 1, 'exact', 0).kind === 'exact')
  check('容差内命中 kind 为 within-declared-tolerance', () =>
    interpolate1d(inner, 1.001, 'exact', 0.01).kind === 'within-declared-tolerance')
}

console.log('[6] 数据本身的问题要挡在前面')
{
  throws('重复坐标要报错', () => normalizePoints([{ coord: [0], value: 1 }, { coord: [0], value: 2 }], 'x'), '重复物理坐标')
  throws('坐标维度不一致要报错', () => normalizePoints([{ coord: [0], value: 1 }, { coord: [0, 1], value: 2 }], 'x'), '维度不一致')
  throws('空数组要报错', () => normalizePoints([], 'x'), '非空数组')
  throws('布尔不是数值', () => finiteNumber(true), 'JSON 数值')
  throws('NaN 要报错', () => finiteNumber(Number.NaN), '有限实数')
  throws('无穷大要报错', () => finiteNumber(Infinity), '有限实数')
}

console.log('[7] 二维：每帧独立的深度网格')
{
  // t=0 帧深度 0,1,2；t=1 帧深度 0,0.5,1 —— 两帧网格不同，不能混用
  const reference = [
    { coord: [0, 0], value: 10 },
    { coord: [0, 1], value: 11 },
    { coord: [1, 0], value: 10 },
    { coord: [1, 0.5], value: 10.5 },
  ]
  const candidate = [
    { coord: [0, 0], value: 10 },
    { coord: [0, 1], value: 11 },
    { coord: [1, 0], value: 10 },
    { coord: [1, 0.5], value: 10.5 },
  ]
  const result = compareSeries({
    name: 'twod',
    unit: 'm',
    relative_floor: 1,
    reference: { unit: 'm', points: reference },
    candidate: { unit: 'm', points: candidate },
  })
  check('二维完全一致 pass', () => result.pass === true)
  check('二维不报维度错', () => result.reference_points === 4)

  // 候选缺少 t=1 帧的深度 0.5，而参考需要它 -> 必须报错而不是拿 t=0 的形状凑
  const broken = candidate.filter((p) => !(p.coord[0] === 1 && p.coord[1] === 0.5))
  throws(
    '某帧缺深度且非 linear 要报错',
    () =>
      compareSeries({
        name: 'twod-broken',
        unit: 'm',
        relative_floor: 1,
        reference: { unit: 'm', points: reference },
        candidate: { unit: 'm', points: broken },
      }),
    '未被覆盖',
  )
}

console.log('[8] 坐标容差与对齐方式')
{
  const ref = series(BASE)
  const cand = series(BASE.map(([t, v]) => [t + 0.001, v]))
  const tolerated = compareSeries({
    name: 'tol',
    unit: 'bar',
    relative_floor: 1,
    coordinate_tolerance: [0.01],
    reference: ref,
    candidate: cand,
  })
  check('容差内命中算对齐', () => tolerated.pass === true)
  check('对齐计数记录 within-declared-tolerance', () => tolerated.alignment_counts['within-declared-tolerance'] === 11)

  throws(
    '未知对齐方式要报错',
    () =>
      compareSeries({
        name: 'bad-align',
        unit: 'bar',
        relative_floor: 1,
        alignment: 'spline',
        reference: ref,
        candidate: cand,
      }),
    '不支持的坐标对齐方式',
  )

  // linear 模式下，候选稀疏一半也能通过插值对齐
  const sparse = series(BASE.filter(([t]) => t % 2 === 0))
  const interpolated = compareSeries({
    name: 'sparse',
    unit: 'bar',
    relative_floor: 1,
    alignment: 'linear',
    reference: ref,
    candidate: sparse,
  })
  check('linear 模式下稀疏候选仍 pass', () => interpolated.pass === true)
  check('插值计数被记录', () => (interpolated.alignment_counts.interpolated ?? 0) === 5)
}

console.log('[9] 绝对差并列')
{
  // 相对误差很小，但绝对差超过声明的上限 -> 必须失败
  const result = compareSeries({
    name: 'abs',
    unit: 'bar',
    relative_floor: 1,
    maximum: 0.1,
    maximum_absolute: 0.3,
    reference: series([[0, 100], [1, 200]]),
    candidate: series([[0, 100.4], [1, 200.4]]),
  })
  check('相对误差很小仍可能 fail', () => result.pass === false)
  check('max_absolute 被如实报告', () => Math.abs(result.max_absolute - 0.4) < 1e-9)
}

console.log('[10] 分母下限确实在防小量放大')
{
  // 参考值 0.001，floor 0.01 -> 分母用 0.01，误差 0.001 得到 0.1 而不是 1.0
  const result = compareSeries({
    name: 'floor',
    unit: 'dimensionless',
    relative_floor: 0.01,
    maximum: 0.1,
    reference: series([[0, 0.001]], { fromUnit: 'dimensionless' }),
    candidate: series([[0, 0.002]], { fromUnit: 'dimensionless' }),
  })
  check('相对误差被 floor 限制在 0.1', () => Math.abs(result.max_relative - 0.1) < 1e-9)
  check('相对误差 0.1 恰好不超过 maximum 0.1', () => result.pass === true)
}

console.log('[11] 两条「不许悄悄变绿」的硬约束')
{
  // 缺省 unit 曾经会退回目标单位，于是 300 vs 301 按 degC 算出 0.33% 判通过；
  // 真实是 27℃ vs 28℃（3.7%），差一个数量级。这条用例锁住「必须显式声明」。
  throws(
    '缺省 unit 必须抛错（否则把 K 当 ℃ 传会静默变绿）',
    () =>
      compareSeries({
        name: 'no-unit',
        unit: 'degC',
        relative_floor: 10,
        reference: { points: [{ coord: [0], value: 300 }] },
        candidate: { points: [{ coord: [0], value: 301 }] },
      }),
    '必须显式声明 unit',
  )

  // Number(null) === 0、Number('0.04') === 0.04、Number([]) === 0，
  // 坏数据会被当成合法数值参与比较。所以非 number 一律拒绝。
  throws('value 为 null 要抛错', () => finiteNumber(null), 'JSON 数值')
  throws('value 为字符串要抛错', () => finiteNumber('0.04'), 'JSON 数值')
  throws('value 为数组要抛错', () => finiteNumber([]), 'JSON 数值')

  // 顶层写 scale/offset 内核只认 binding 里的，静默忽略会让人以为换算生效了
  throws(
    'spec 顶层写 scale 要拒绝',
    () =>
      compareSeries({
        name: 'top-scale',
        unit: 'bar',
        scale: 10,
        relative_floor: 1,
        reference: series([[0, 100]]),
        candidate: series([[0, 100]]),
      }),
    '不能写在 spec 顶层',
  )

  // 缺省 relative_floor 要有专用报错，而不是退化成「必须是 JSON 数值，实际是 undefined」
  throws(
    'relative_floor 缺省要有专用报错',
    () =>
      compareSeries({
        name: 'no-floor',
        unit: 'bar',
        reference: series([[0, 100]]),
        candidate: series([[0, 100]]),
      }),
    '必须显式给出',
  )
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
