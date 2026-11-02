// 数值判据内核 —— 移植自 一个 Python 前作的 evaluate.py。
//
// 只保留与领域无关的数学部分：误差怎么算、单位怎么换算、坐标能不能对齐、
// 有没有外推。项目怎么构建、跑什么命令、参考数据从哪来，属于领域包与
// 冻结判据的事，这里一概不管。
//
// 移植时的每一条硬规矩都能追溯到 v4 的一次真实误判，所以这里的「严格」
// 不是洁癖：放宽一条，就等于给一条假的绿色结果开门。

/** 单位换算表：目标单位 -> { 源单位: [scale, offset] }。 */
export const UNIT_CONVERSIONS = {
  degC: { K: [1, -273.15], degC: [1, 0] },
  bar: { bar: [1, 0], MPa: [10, 0], kPa: [0.01, 0], Pa: [1e-5, 0] },
  m: { m: [1, 0] },
  'kg/m3': { 'kg/m3': [1, 0], sg: [1000, 0] },
  'm3/s': { 'm3/s': [1, 0], 'L/s': [0.001, 0], 'L/min': [1 / 60000, 0] },
  rpm: { rpm: [1, 0] },
  dimensionless: { dimensionless: [1, 0], sg: [1, 0] },
}

/**
 * 相对误差分母的下限，按单位给。
 *
 * 为什么需要它：误差是 `|预测-参考| / max(|参考|, floor)`。参考值接近 0 时
 * 分母会被放大成天量，一个物理上无关紧要的 0.001 会算出 300% 的相对误差。
 * 但也不能随手把 floor 调大 —— 那是在稀释真实差异，所以这里给了上限。
 */
export const RELATIVE_FLOOR_LIMIT = {
  degC: 10,
  bar: 1,
  m: 1,
  'kg/m3': 1,
  'm3/s': 1e-6,
  rpm: 1,
  dimensionless: 0.01,
}

/** v4 的硬上限：目标误差不得超过 5%，最大允许误差不得超过 10%。 */
export const MAX_TARGET = 0.05
export const MAX_THRESHOLD = 0.1

const ALIGNMENTS = ['exact', 'linear']

/** 有限实数：只接受 JSON 数值本身。
 *
 * 不能用 Number() 兜底 —— 它会把 '42' 变成 42、null 变成 0、[] 变成 0、true 变成 1。
 * 于是一个 value:null 的坏数据会被当成 0 参与比较，还判通过。
 * v4 的 float(None) / float([]) 是直接抛异常的，这里保持同样的严格度。
 */
export function finiteNumber(value, label = 'value') {
  if (typeof value !== 'number') {
    const actual = value === null ? 'null' : Array.isArray(value) ? '数组' : typeof value
    throw new Error(`${label} 必须是 JSON 数值，实际是 ${actual}`)
  }
  if (!Number.isFinite(value)) throw new Error(`${label} 不是有限实数：${value}`)
  return value
}

/**
 * 规范化一串数据点。
 *
 * 坐标是数组（1 维时间/深度，或 2 维时间+深度）。同一坐标出现两次必须报错 ——
 * 两条曲线在同一个物理坐标上给了两个值，比没有值更糟：不管取哪一个都是编造。
 */
export function normalizePoints(raw, label) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} 不是非空数组`)
  const points = new Map()
  let dimension = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error(`${label} 里有非对象条目`)
    const coord = item.coord
    if (!Array.isArray(coord) || coord.length < 1 || coord.length > 2) {
      throw new Error(`${label} 的 coord 必须是长度 1 或 2 的数组`)
    }
    if (dimension === 0) dimension = coord.length
    else if (coord.length !== dimension) throw new Error(`${label} 的坐标维度不一致`)
    const key = coord.map((x) => finiteNumber(x, `${label} 坐标`)).join(',')
    const value = finiteNumber(item.value, `${label} 数值`)
    if (points.has(key)) throw new Error(`${label} 出现重复物理坐标：${key}`)
    points.set(key, { coord: coord.map(Number), value })
  }
  return { dimension, points }
}

/** 按单位把原始数值换算到规范单位；换算系数必须与表里一致。 */
export function convertValue(value, unit, fromUnit, scale, offset) {
  const table = UNIT_CONVERSIONS[unit]
  if (!table) throw new Error(`单位必须是明确的物理单位：${unit}`)
  if (!Object.hasOwn(table, fromUnit)) {
    throw new Error(`单位 ${fromUnit} 不在 ${unit} 的换算表里`)
  }
  const expected = table[fromUnit]
  const actualScale = finiteNumber(scale ?? 1, 'scale')
  const actualOffset = finiteNumber(offset ?? 0, 'offset')
  if (actualScale !== expected[0] || actualOffset !== expected[1]) {
    throw new Error(
      `单位换算与规范不一致（${fromUnit} -> ${unit} 应为 scale=${expected[0]} offset=${expected[1]}，` +
        `实际是 scale=${actualScale} offset=${actualOffset}）`,
    )
  }
  if (actualScale === 0) throw new Error('单位换算 scale 不能为 0')
  return finiteNumber(value, '数值') * actualScale + actualOffset
}

/** 二分查找插入点，与 Python 的 bisect_left 一致。 */
function lowerBound(keys, target) {
  let low = 0
  let high = keys.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (keys[mid] < target) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * 一维取值：精确命中 / 落在声明容差内 / 插值。
 *
 * 相邻两个候选点都落在容差内时必须报错，不能挑一个近的 —— 那就是在猜。
 * 目标点落在采样区间外时，非 linear 模式一律报错（不外推）。
 */
export function interpolate1d(points, target, mode, tolerance) {
  return interpolateSorted([...points.keys()].sort((a, b) => a - b), points, target, mode, tolerance)
}

/** 已排序 keys 版本的取值。
 *
 * 拆出来是为了 predict：它要对同一组坐标做 N 次查询，若每次都重建并重排 keys，
 * 整体复杂度会变成 O(n² log n)。实测 500/1000/2000/4000 点是 18/41/175/780ms，
 * 十万点的算例根本跑不完 —— 而这正是数值场景的常规规模。
 */
function interpolateSorted(keys, points, target, mode, tolerance) {
  const index = lowerBound(keys, target)
  const nearby = keys.slice(Math.max(0, index - 1), index + 1).filter((k) => Math.abs(k - target) <= tolerance)
  if (nearby.length > 1) throw new Error(`坐标容差内出现多个候选点：${target}`)
  if (nearby.length === 1) {
    return { value: points.get(nearby[0]), kind: nearby[0] === target ? 'exact' : 'within-declared-tolerance' }
  }
  if (mode !== 'linear' || index === 0 || index === keys.length) {
    throw new Error(`坐标 ${target} 未被覆盖，且不允许外推`)
  }
  const left = keys[index - 1]
  const right = keys[index]
  const ratio = (target - left) / (right - left)
  return { value: points.get(left) + (points.get(right) - points.get(left)) * ratio, kind: 'interpolated' }
}

/** 把序列整理成「可反复查询」的索引。
 *
 * 为什么单独抽出来：compareSeries 要用同一个候选序列回答 N 个参考点的查询。
 * 如果每次 predict 都重建 Map、重排 keys，整体复杂度就是 O(n²) ——
 * 实测 500/1000/2000/4000 点是 30/78/321/1192ms，两万点已经要 60 秒。
 * 数值场景的算例动辄几千点，这个量级不能用。
 */
export function prepareSeries(series) {
  if (series.dimension === 1) {
    const flat = new Map()
    for (const point of series.points.values()) flat.set(point.coord[0], point.value)
    return { __prepared: true, dimension: 1, flat, keys: [...flat.keys()].sort((a, b) => a - b) }
  }

  const frames = new Map()
  for (const point of series.points.values()) {
    const [time, depth] = point.coord
    if (!frames.has(time)) frames.set(time, new Map())
    frames.get(time).set(depth, point.value)
  }
  const frameKeys = new Map()
  for (const [time, frame] of frames) frameKeys.set(time, [...frame.keys()].sort((a, b) => a - b))
  return {
    __prepared: true,
    dimension: series.dimension,
    frames,
    frameKeys,
    times: [...frames.keys()].sort((a, b) => a - b),
  }
}

/**
 * 取值：1 维走 interpolateSorted，2 维按「每一时间帧独立的深度网格」对齐。
 *
 * v4 的注释写得很直白：绝不把 pipe 的深度替换成 annulus 的深度。换句话说，
 * 不同时间帧的深度采样可以不同，混用等于把两条不同的曲线当同一条。
 *
 * 第一个参数既可以是原始 series，也可以是 prepareSeries() 的结果。
 */
export function predict(target, coordinate, mode, tolerances) {
  const prepared = target.__prepared === true ? target : prepareSeries(target)
  if (prepared.dimension === 1) {
    return interpolateSorted(
      prepared.keys,
      prepared.flat,
      finiteNumber(coordinate[0], 'coordinate'),
      mode,
      tolerances[0],
    )
  }
  const { frames, frameKeys, times } = prepared
  const index = lowerBound(times, coordinate[0])
  const nearby = times.slice(Math.max(0, index - 1), index + 1).filter((t) => Math.abs(t - coordinate[0]) <= tolerances[0])
  if (nearby.length > 1) throw new Error(`时间容差内出现多个候选帧：${coordinate[0]}`)
  if (nearby.length === 1) {
    const frame = interpolateSorted(
      frameKeys.get(nearby[0]),
      frames.get(nearby[0]),
      coordinate[1],
      mode,
      tolerances[1],
    )
    return {
      value: frame.value,
      kind: nearby[0] === coordinate[0] ? frame.kind : 'within-declared-tolerance',
    }
  }
  if (mode !== 'linear' || index === 0 || index === times.length) {
    throw new Error(`时间 ${coordinate[0]} 未被覆盖，且不允许外推`)
  }
  const left = times[index - 1]
  const right = times[index]
  const leftValue = interpolateSorted(frameKeys.get(left), frames.get(left), coordinate[1], mode, tolerances[1]).value
  const rightValue = interpolateSorted(frameKeys.get(right), frames.get(right), coordinate[1], mode, tolerances[1]).value
  return {
    value: leftValue + (rightValue - leftValue) * ((coordinate[0] - left) / (right - left)),
    kind: 'interpolated',
  }
}

/** 阈值护栏：任何人都不许把判据放宽成「怎么都过」。 */
export function validateThresholds(unit, { target = 0.05, maximum = 0.1, relativeFloor }) {
  const floorLimit = RELATIVE_FLOOR_LIMIT[unit]
  if (floorLimit === undefined) throw new Error(`单位必须是明确的物理单位：${unit}`)
  // 缺省时给专用报错：否则会退化成人看不懂的「必须是 JSON 数值，实际是 undefined」
  if (relativeFloor === undefined || relativeFloor === null) {
    throw new Error(`relative_floor 必须显式给出（单位 ${unit} 的上限是 ${floorLimit}）`)
  }
  const floor = finiteNumber(relativeFloor, 'relative_floor')
  const targetValue = finiteNumber(target, 'target')
  const maximumValue = finiteNumber(maximum, 'maximum')
  if (!(floor > 0 && floor <= floorLimit)) {
    throw new Error(`relative_floor 必须在 (0, ${floorLimit}] 之间（单位 ${unit}），实际 ${floor}`)
  }
  if (!(targetValue > 0 && targetValue <= MAX_TARGET)) {
    throw new Error(`target 必须在 (0, ${MAX_TARGET}] 之间，实际 ${targetValue}`)
  }
  if (!(targetValue <= maximumValue && maximumValue <= MAX_THRESHOLD)) {
    throw new Error(`maximum 必须满足 target <= maximum <= ${MAX_THRESHOLD}，实际 ${maximumValue}`)
  }
  return { floor, target: targetValue, maximum: maximumValue }
}

/**
 * 比较两条曲线。
 *
 * 返回的指标与 v4 的 `compare_metric` 同构，方便把 v4 那边的报告直接对照。
 * `claim` 那句不是装饰：插值算出来的「一致」和原始同时刻观测的「一致」不是
 * 一回事，报告里必须写清楚是哪一种。
 */
export function compareSeries(spec) {
  const name = spec.name ?? 'metric'
  const unit = spec.unit
  if (!Object.hasOwn(UNIT_CONVERSIONS, unit ?? '')) {
    throw new Error(`单位必须是明确的物理单位：${unit ?? '(未给)'}`)
  }

  // 顶层写 scale/offset 只认 binding 里的，顶层会被静默忽略。
  // 与其让人以为生效了，不如直接拒绝 —— 单位换算写错是这类比较最常见的错误来源。
  for (const field of ['scale', 'offset']) {
    if (spec[field] !== undefined) {
      throw new Error(`${field} 必须写在 reference / candidate 内部，不能写在 spec 顶层（顶层会被忽略）`)
    }
  }

  const reference = buildSeries(spec.reference, unit, `${name}.reference`)
  const candidate = buildSeries(spec.candidate, unit, `${name}.candidate`)
  if (reference.dimension !== candidate.dimension) throw new Error('参考与候选项的坐标维度不一致')

  const mode = spec.alignment ?? 'exact'
  if (!ALIGNMENTS.includes(mode)) throw new Error(`不支持的坐标对齐方式：${mode}`)

  const tolerances = (spec.coordinate_tolerance ?? new Array(reference.dimension).fill(0)).map((x) =>
    finiteNumber(x, 'coordinate_tolerance'),
  )
  if (tolerances.length !== reference.dimension || tolerances.some((x) => x < 0)) {
    throw new Error('coordinate_tolerance 长度或取值不合法')
  }

  const { floor, target, maximum } = validateThresholds(unit, {
    target: spec.target,
    maximum: spec.maximum,
    relativeFloor: spec.relative_floor,
  })

  const absoluteLimit =
    spec.maximum_absolute === undefined || spec.maximum_absolute === null
      ? null
      : finiteNumber(spec.maximum_absolute, 'maximum_absolute')
  if (absoluteLimit !== null && absoluteLimit < 0) throw new Error('maximum_absolute 不能为负')

  const errors = []
  const relatives = []
  const alignmentCounts = {}
  let worst = null
  let covered = 0

  // 候选序列只 prepare 一次：后面每个参考点都要查它。
  // 放在循环里会让整体退化成 O(n²)（见 prepareSeries 的注释）。
  const preparedCandidate = prepareSeries(candidate)
  for (const point of [...reference.points.values()].sort((a, b) => compareCoord(a.coord, b.coord))) {
    const predicted = predict(preparedCandidate, point.coord, mode, tolerances)
    covered += 1
    const error = Math.abs(predicted.value - point.value)
    const relative = error / Math.max(Math.abs(point.value), floor)
    errors.push(error)
    relatives.push(relative)
    alignmentCounts[predicted.kind] = (alignmentCounts[predicted.kind] ?? 0) + 1
    if (worst === null || relative > worst.relative) {
      worst = {
        coord: point.coord,
        reference: point.value,
        candidate: predicted.value,
        absolute: error,
        relative,
      }
    }
  }

  // 不能用 Math.max(...errors)：展开传参在十万量级的点集上会撞调用栈上限。
  const maxAbsolute = errors.reduce((best, value) => (value > best ? value : best), 0)
  const maxRelative = relatives.reduce((best, value) => (value > best ? value : best), 0)
  const passed = maxRelative <= maximum && (absoluteLimit === null || maxAbsolute <= absoluteLimit)

  return {
    name,
    unit,
    reference_points: reference.points.size,
    candidate_points: candidate.points.size,
    coverage: reference.points.size === 0 ? 0 : covered / reference.points.size,
    mae: mean(errors),
    max_absolute: maxAbsolute,
    mean_relative: mean(relatives),
    max_relative: maxRelative,
    relative_floor: floor,
    target,
    maximum,
    within_target: maxRelative <= target,
    pass: passed,
    alignment_counts: alignmentCounts,
    worst,
    claim: '全参考点按已声明坐标对齐；插值不是原始同时刻观测。',
  }
}

function buildSeries(binding, unit, label) {
  if (!binding || typeof binding !== 'object') throw new Error(`${label} 缺失`)
  // 单位必须显式声明。回退到目标单位看着无害，实际是把「把 K 数值当 ℃ 传」直接放过：
  // 300 与 301 在 degC 下相对误差 0.33%，在 K 下真实是 27℃ vs 28℃（3.7%）——
  // 相差一个数量级，而判据会绿。v4 对 reference / candidate 都强制要求单位。
  if (typeof binding.unit !== 'string' || binding.unit.trim() === '') {
    throw new Error(`${label} 必须显式声明 unit（如 "degC"），省略会让单位假设被悄悄默认`)
  }
  const raw = binding.points
  const series = normalizePoints(raw, label)
  const fromUnit = binding.unit.trim()
  const converted = new Map()
  for (const [key, point] of series.points) {
    converted.set(key, {
      coord: point.coord,
      value: convertValue(point.value, unit, fromUnit, binding.scale, binding.offset),
    })
  }
  return { dimension: series.dimension, points: converted }
}

function compareCoord(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

function mean(values) {
  return values.reduce((sum, x) => sum + x, 0) / values.length
}
