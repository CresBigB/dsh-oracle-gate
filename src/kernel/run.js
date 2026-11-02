// run 目录解析。所有落盘都必须先过这里，避免 run_id 里夹带路径分隔符跑出 root。
import { join, resolve } from 'node:path'

export const STATE_DIR = '.protocol-kit'

export function runDirOf(root, runId) {
  const safe = String(runId ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/-+$/, '')
  if (safe === '') {
    throw new Error('run_id 不能为空，且必须包含字母或数字')
  }
  return join(resolve(root), STATE_DIR, safe)
}

export function suggestRunId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `${prefix}-${stamp}`
}
