// 评审 evidence_refs 校验：引用必须指向真实存在的东西，不能只是「非空数组」。
//
// 认两种形式：
//   - 文件：`src/a.ts`、`src/a.ts:12`、`src/a.ts:12-30`（相对 root 或 root 内的绝对路径）
//   - 回执：`rcpt_<seq>_<oracle_id>`（必须是本 run 里真实存在的回执 id）
// 其它写法（URL、自由文本）无法机器核对，一律判为无效——否则「evidence_refs:["看过了"]」也能准入。
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const FILE_REF = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/

function countLines(abs) {
  const text = readFileSync(abs, 'utf8')
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** 返回 (ref) => { ok, kind, reason? } */
export function makeRefChecker(root, { receiptIds = new Set() } = {}) {
  const base = resolve(root)
  const lineCache = new Map()
  return (ref) => {
    if (typeof ref !== 'string' || ref.trim() === '') return { ok: false, kind: 'unknown', reason: '空引用' }
    const text = ref.trim()
    if (/^rcpt_\d+_/.test(text)) {
      return receiptIds.has(text)
        ? { ok: true, kind: 'receipt' }
        : { ok: false, kind: 'receipt', reason: `本 run 没有回执 ${text}` }
    }
    const match = text.match(FILE_REF)
    const pathPart = match[1]
    // Windows 盘符 `E:\a.ts:12`：FILE_REF 的懒匹配会在第一个冒号前停下，补回盘符。
    let path = pathPart
    let start = match[2]
    let end = match[3]
    if (/^[A-Za-z]$/.test(pathPart)) {
      const rest = text.slice(2).match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/)
      if (rest === null) return { ok: false, kind: 'unknown', reason: `无法解析引用 ${text}` }
      path = text.slice(0, 2) + rest[1]
      start = rest[2]
      end = rest[3]
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      return { ok: false, kind: 'unknown', reason: `URL 无法核对：${text}（请引用 root 内的文件或回执 id）` }
    }
    const abs = isAbsolute(path) ? resolve(path) : resolve(base, path)
    const rel = relative(base, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, kind: 'file', reason: `${path} 不在 root 之内` }
    }
    let info
    try {
      info = statSync(abs)
    } catch {
      return { ok: false, kind: 'file', reason: `文件不存在：${path}` }
    }
    if (!info.isFile()) return { ok: false, kind: 'file', reason: `不是文件：${path}` }
    if (start !== undefined) {
      const from = Number(start)
      const to = end === undefined ? from : Number(end)
      if (from < 1 || to < from) return { ok: false, kind: 'file', reason: `行号范围不合法：${text}` }
      let total = lineCache.get(abs)
      if (total === undefined) {
        try {
          total = countLines(abs)
        } catch {
          return { ok: false, kind: 'file', reason: `读不了：${path}` }
        }
        lineCache.set(abs, total)
      }
      if (to > total) return { ok: false, kind: 'file', reason: `${path} 只有 ${total} 行，引用了第 ${to} 行` }
    }
    return { ok: true, kind: 'file' }
  }
}
