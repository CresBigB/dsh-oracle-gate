// 把冻结的 argv 变成一次可执行的 spawn 计划。
//
// 为什么需要这一层：执行用 spawn(shell:false)，这在 POSIX 上没问题，但在 Windows 上
// `npx`、`npm`、`tsc` 这类命令实际是 `.cmd` 批处理文件，Node 不允许 shell:false 直接
// 启动它们（找不到时报 ENOENT，写全后缀则报 EINVAL，见 CVE-2024-27980 的修复）。
// 于是 README 快速开始里的 `npx tsc --noEmit` 在 Windows 上根本跑不起来。
//
// 做法沿用 cross-spawn 的成熟方案：先按 PATH/PATHEXT 找到真实文件；若是 .cmd/.bat，
// 改由 `cmd.exe /d /s /c "<逐个转义后的命令行>"` 执行。每个参数都用 ^ 转义 cmd 元字符，
// 所以参数里的 `&`、`|` 只会是字面量，不会变成第二条命令 —— 冻结时的 argv 依然就是
// 真正执行的那一份。
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, normalize, resolve } from 'node:path'

const META = /([()\][%!^"`<>&|;, *?])/g
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function pathExts(env, platform) {
  if (platform !== 'win32') return []
  const raw = env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD'
  return raw
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function envPath(env) {
  // Windows 上 process.env 大小写不敏感，但调用方可能传普通对象
  return env.PATH ?? env.Path ?? env.path ?? ''
}

function candidates(base, platform, exts) {
  if (platform !== 'win32') return [base]
  const out = []
  const ext = extname(base).toLowerCase()
  if (ext !== '' && exts.some((item) => item.toLowerCase() === ext)) out.push(base)
  for (const item of exts) out.push(base + item)
  return out
}

/**
 * 找到命令对应的真实文件。返回 { ok, file, kind } 或 { ok:false, error, name }。
 * kind：'cmd-script'（.cmd/.bat，需经 cmd.exe）或 'binary'。
 */
export function resolveExecutable(name, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const raw = String(name ?? '')
  if (raw === '') return { ok: false, error: 'empty-command', name: raw }
  const exts = pathExts(env, platform)
  const hasDir = isAbsolute(raw) || /[\\/]/.test(raw)
  const bases = hasDir
    ? [resolve(cwd, raw)]
    : envPath(env)
      .split(platform === 'win32' ? ';' : delimiter)
      .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
      .filter((dir) => dir !== '')
      .map((dir) => join(dir, raw))
  for (const base of bases) {
    for (const file of candidates(base, platform, exts)) {
      if (isFile(file)) {
        const kind = platform === 'win32' && /\.(cmd|bat)$/i.test(file) ? 'cmd-script' : 'binary'
        return { ok: true, file: normalize(file), kind }
      }
    }
  }
  return { ok: false, error: 'command-not-found', name: raw }
}

/** cmd.exe 命令本身的转义（cross-spawn lib/util/escape.js）。 */
export function escapeCmdCommand(arg) {
  return String(arg).replace(META, '^$1')
}

/**
 * cmd.exe 参数转义（cross-spawn lib/util/escape.js）。
 * 先按 CommandLineToArgvW 的规则处理反斜杠与引号，再给 cmd 元字符加 ^；
 * node_modules/.bin 下的 cmd-shim 会再解析一次 %*，所以要转义两遍。
 */
export function escapeCmdArgument(arg, doubleEscape = false) {
  let out = String(arg)
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1')
  out = `"${out}"`
  out = out.replace(META, '^$1')
  if (doubleEscape) out = out.replace(META, '^$1')
  return out
}

/**
 * 生成 spawn 计划：{ ok, file, args, options, executable, via }。
 * 不在这里 spawn，便于测试与在执行前预检（找不到命令不该扣预算）。
 */
export function buildSpawnPlan(argv, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: 'empty-command', name: '' }
  const found = resolveExecutable(argv[0], { cwd, env, platform })
  if (!found.ok) return found
  const rest = argv.slice(1).map(String)
  if (found.kind === 'cmd-script') {
    const double = CMD_SHIM.test(found.file)
    const line = [escapeCmdCommand(found.file), ...rest.map((arg) => escapeCmdArgument(arg, double))].join(' ')
    return {
      ok: true,
      file: env.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
      executable: found.file,
      via: 'cmd.exe',
    }
  }
  return { ok: true, file: found.file, args: rest, options: {}, executable: found.file, via: 'direct' }
}

/**
 * 杀掉整棵进程树。
 * Windows 上只杀 cmd.exe 的话，它启动的 node 还活着且握着 stdout 管道，'close' 永远不来。
 * POSIX 上子进程以 detached 方式启动成为进程组组长，用负 pid 一次杀全组。
 */
export function killTree(child, platform = process.platform) {
  if (!child || typeof child.pid !== 'number') return
  if (platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
      })
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}
