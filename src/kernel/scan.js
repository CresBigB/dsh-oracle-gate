/**
 * 文件遍历内核 —— 与领域无关，供各协议复用。
 *
 * 设计约束（都是踩过的坑）：
 * - 必须能在任意项目根上跑而不炸：软链接环、超大文件、权限拒绝都要静默跳过并计数
 * - 必须有硬上限：文件数、单文件读取字节数、总扫描耗时，防止在 monorepo 上卡死
 * - 必须可复现：同一输入产出稳定顺序（按路径排序），否则清单无法 diff
 */

import { readdir, stat, readFile } from 'node:fs/promises'
import { join, relative, extname, sep } from 'node:path'

/** 永远跳过的目录名（依赖、构建产物、版本库、缓存）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.bzr',
  'dist', 'build', 'out', 'output', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache',
  'vendor', 'third_party', 'third-party',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  'coverage', '.nyc_output', '.cache', 'tmp', 'temp', '.tmp',
  '.idea', '.vscode', '.vs', '.DS_Store',
  '.protocol-kit', '.agent-teams',
])

/**
 * 第三方库目录的启发式识别。只看目录名，不读内容。
 *
 * 命中的整棵子树跳过：vendored 库不是项目的「可复用资产」，列进清单只会稀释信号
 * （实测在 某项目 上，`native_src/src/eigen-3.3.9` 的 Eigen 头文件挤掉了真正的业务资产）。
 * 带完整版本号的后缀是最典型的 vendored 布局，如 `eigen-3.3.9`、`vue-router-4.2`。
 */
const VENDOR_DIR_RES = [
  /^(third|3rd)[-_]?party$/i,
  /^extern(al)?$/i,
  /^deps?$/i,
  /^bundled?$/i,
  /^[a-z][a-z0-9_]*[-_]v?\d+\.\d+(\.\d+)*$/i,
]

/** 目录名是否像第三方库。 */
function isVendoredDir(name) {
  return VENDOR_DIR_RES.some((re) => re.test(name))
}

/** 视为「源码」的扩展名。 */
export const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.rs', '.go', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.swift', '.m', '.mm', '.rb', '.php',
])

/** 视为「样式/设计约定」的扩展名。 */
export const STYLE_EXTS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl',
])

/** 视为「配置」的扩展名。 */
export const CONFIG_EXTS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.conf',
])

/** 编译产物/压缩文件特征，扫描内容时跳过。 */
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.bundle.js', '.chunk.js', '.map']

const DEFAULT_MAX_FILES = 20000
const DEFAULT_MAX_DEPTH = 24

/**
 * 递归遍历目录，返回稳定的文件清单。
 *
 * @param {string} root 绝对路径
 * @param {object} [options]
 * @param {number} [options.maxFiles] 文件数上限，超出即停止并标记 truncated
 * @param {number} [options.maxDepth] 目录深度上限
 * @param {Set<string>} [options.skipDirs] 额外跳过的目录名
 * @returns {Promise<{root:string, files:Array, stats:object}>}
 */
export async function walkFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const skipDirs = options.skipDirs ? new Set([...SKIP_DIRS, ...options.skipDirs]) : SKIP_DIRS

  const files = []
  const stats = {
    dirsVisited: 0,
    dirsSkipped: 0,
    dirsSkippedVendored: 0,
    entriesSeen: 0,
    unreadableDirs: 0,
    unreadableFiles: 0,
    truncated: false,
  }

  /** 显式栈，避免深目录递归爆栈。 */
  const stack = [{ abs: root, rel: '', depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current.depth > maxDepth) continue
    stats.dirsVisited += 1

    let entries
    try {
      entries = await readdir(current.abs, { withFileTypes: true })
    } catch {
      stats.unreadableDirs += 1
      continue
    }

    for (const entry of entries) {
      stats.entriesSeen += 1
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`

      // 软链接一律不跟进：环检测成本高，收益低，宁可漏。
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          stats.dirsSkipped += 1
          continue
        }
        if (isVendoredDir(entry.name)) {
          stats.dirsSkippedVendored += 1
          continue
        }
        stack.push({ abs: join(current.abs, entry.name), rel, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile()) continue

      if (files.length >= maxFiles) {
        stats.truncated = true
        break
      }

      const ext = extname(entry.name).toLowerCase()
      const lower = entry.name.toLowerCase()
      if (GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue

      let size = 0
      try {
        size = (await stat(join(current.abs, entry.name))).size
      } catch {
        stats.unreadableFiles += 1
        continue
      }

      const abs = join(current.abs, entry.name)
      files.push({
        path: rel.split(sep).join('/'),
        abs,
        name: entry.name,
        ext,
        size,
        kind: classifyExt(ext),
      })
    }

    if (stats.truncated) break
  }

  // 稳定排序：清单可 diff 的前提。
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return { root, files, stats }
}

/** 按扩展名粗分类。 */
export function classifyExt(ext) {
  if (SOURCE_EXTS.has(ext)) return 'source'
  if (STYLE_EXTS.has(ext)) return 'style'
  if (CONFIG_EXTS.has(ext)) return 'config'
  return 'other'
}

/**
 * 读取文件文本，带字节上限与二进制检测。
 *
 * @param {string} abs
 * @param {number} [maxBytes]
 * @returns {Promise<{text:string|null, bytes:number, skipped:string|null}>}
 */
export async function readTextFile(abs, maxBytes = 512 * 1024) {
  let buffer
  try {
    buffer = await readFile(abs)
  } catch {
    return { text: null, bytes: 0, skipped: 'unreadable' }
  }

  if (buffer.length > maxBytes) {
    return { text: null, bytes: buffer.length, skipped: 'too-large' }
  }

  // 前 8KB 内含 NUL 视为二进制。
  const probe = buffer.subarray(0, Math.min(8192, buffer.length))
  if (probe.includes(0)) {
    return { text: null, bytes: buffer.length, skipped: 'binary' }
  }

  return { text: buffer.toString('utf8'), bytes: buffer.length, skipped: null }
}

/** 把绝对路径转成相对根的可读路径。 */
export function relPath(root, abs) {
  return relative(root, abs).split(sep).join('/')
}
