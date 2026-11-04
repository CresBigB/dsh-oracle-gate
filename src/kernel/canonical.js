// 键排序后的 JSON，保证同一个对象永远算出同一份文本（哈希与签名共用）。
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}
