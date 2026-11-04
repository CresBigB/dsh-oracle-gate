// 代码版本指纹：回答「这份回执 / 这条评审，对应的是哪一版代码」。
//
// 为什么需要它：回执只记「跑过、过了」，不记「跑的是哪一版」。先跑绿、再改代码、
// 再调 gate，旧回执照样算通过——验收就和交付的东西脱钩了。
//
// 指纹 = git HEAD + 工作区相对 HEAD 的全部改动（已跟踪文件的 diff + 未被忽略的新文件内容）。
// 协议自己的产物目录 .protocol-kit/ 一律排除，否则每写一张回执指纹就变一次。
// 不是 git 仓库时返回 kind:'none'，不做新鲜度检查（如实说明，不假装检查过）。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const EXCLUDE = ':(exclude).protocol-kit'

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    shell: false,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) return null
  return result.stdout
}

export function codeFingerprint(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside === null || inside.toString('utf8').trim() !== 'true') {
    return { kind: 'none', value: null, reason: '不是 git 工作区，无法绑定代码版本' }
  }
  const head = git(root, ['rev-parse', 'HEAD'])
  const headText = head === null ? 'no-commit' : head.toString('utf8').trim()
  const hash = createHash('sha256').update('head:' + headText + '\n')

  const diff = git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--', '.', EXCLUDE])
    ?? git(root, ['diff', '--binary', '--no-ext-diff', '--', '.', EXCLUDE]) // 还没有任何 commit 时
    ?? Buffer.alloc(0)
  hash.update('diff:').update(diff).update('\n')

  const untrackedRaw = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', EXCLUDE])
  const untracked = untrackedRaw === null
    ? []
    : untrackedRaw.toString('utf8').split('\0').filter((name) => name !== '').sort()
  for (const name of untracked) {
    const abs = join(root, name)
    let content
    try {
      if (!statSync(abs).isFile()) continue
      content = readFileSync(abs)
    } catch {
      continue
    }
    hash.update('new:' + name + '\n').update(createHash('sha256').update(content).digest('hex') + '\n')
  }

  return {
    kind: 'git',
    head: headText,
    dirty: diff.length > 0 || untracked.length > 0,
    untracked: untracked.length,
    value: 'sha256:' + hash.digest('hex'),
  }
}

/**
 * 判断一份记录（回执或评审）是否仍对应当前代码。
 * 返回 'fresh' | 'stale' | 'unchecked'。旧版回执没有指纹字段、或当前不是 git 仓库时为 unchecked。
 */
export function freshnessOf(recorded, current) {
  if (!current || current.value === null || current.value === undefined) return 'unchecked'
  const values = [recorded?.value, recorded?.after].filter((item) => typeof item === 'string')
  if (values.length === 0) return 'unchecked'
  return values.includes(current.value) ? 'fresh' : 'stale'
}
