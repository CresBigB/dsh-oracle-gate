/**
 * 按项目里已有的脚本/配置推荐 L0 判据（只读，不执行任何东西）。
 *
 * 只推荐「项目自己已经声明过的」检查：package.json 的 scripts、tsconfig、pytest、cargo、go。
 * 每条都带 argv 和推荐理由；可执行文件找不到的标 available:false，由调用方决定是否丢弃。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveExecutable } from './command.js'

// package.json 里值得当硬门的脚本名，按优先级。
const NPM_SCRIPTS = [
  ['typecheck', '类型检查通过'],
  ['type-check', '类型检查通过'],
  ['lint', 'lint 通过'],
  ['test', '测试通过'],
  ['build', '构建成功'],
]

// npm 默认的 test 占位脚本，不算真测试。
const NPM_PLACEHOLDER = /no test specified/i

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function packageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export function suggestOracles(root, { env = process.env, platform = process.platform } = {}) {
  const out = []
  const add = (id, criterion, argv, reason) => {
    if (out.some((item) => item.id === id)) return
    const exe = resolveExecutable(argv[0], { cwd: root, env, platform })
    out.push({ id, level: 'L0', criterion, argv, reason, available: exe.ok })
  }

  const pkg = readJson(join(root, 'package.json'))
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  const pm = packageManager(root)
  let hasTypecheckScript = false
  for (const [name, criterion] of NPM_SCRIPTS) {
    const body = scripts[name]
    if (typeof body !== 'string' || body.trim() === '') continue
    if (name === 'test' && NPM_PLACEHOLDER.test(body)) continue
    if (name.startsWith('type')) {
      if (hasTypecheckScript) continue
      hasTypecheckScript = true
    }
    add(`L0-${name}`, criterion, [pm, 'run', name], `package.json scripts.${name}: ${body}`)
  }
  if (!hasTypecheckScript && existsSync(join(root, 'tsconfig.json'))) {
    add('L0-typecheck', '类型检查通过', ['npx', 'tsc', '--noEmit'], '存在 tsconfig.json')
  }

  const hasPytest = existsSync(join(root, 'pytest.ini'))
    || (existsSync(join(root, 'pyproject.toml')) && /\[tool\.pytest/.test(readFileSync(join(root, 'pyproject.toml'), 'utf8')))
    || existsSync(join(root, 'tests', 'conftest.py'))
  if (hasPytest) {
    const python = platform === 'win32' ? 'python' : 'python3'
    add('L0-pytest', 'pytest 通过', [python, '-m', 'pytest', '-q'], '存在 pytest 配置')
  }
  if (existsSync(join(root, 'Cargo.toml'))) add('L0-cargo-test', 'cargo test 通过', ['cargo', 'test'], '存在 Cargo.toml')
  if (existsSync(join(root, 'go.mod'))) add('L0-go-test', 'go test 通过', ['go', 'test', './...'], '存在 go.mod')
  return out
}
