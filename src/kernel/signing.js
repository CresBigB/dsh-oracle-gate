// HMAC 签名：回执、账本、评审存档都带签名，密钥放在工作区之外。
//
// 防的是什么：用编辑器 / 写文件工具直接改 receipts/*.json、删 ledger.jsonl 的行、
// 往 reviews.jsonl 里塞一条 pass —— 以前这些都和真的一模一样，现在签名对不上就作废。
// 防不了什么：能读到密钥文件的进程照样能伪造。密钥放在 root 之外（默认 ~/.dsh/oracle-gate/hmac.key），
// 只是让「改产物」必须多走一步、且这一步明显越界；它不是对抗同权限恶意进程的安全边界。
//
// 兼容：只有冻结时登记了 signing 的 run 才强制验签；旧 run 照旧不验。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalJson } from './canonical.js'

export const SIG_ALG = 'hmac-sha256'

export function defaultKeyFile(env = process.env) {
  const override = env.ORACLE_GATE_KEY_FILE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(homedir(), '.dsh', 'oracle-gate', 'hmac.key')
}

/** 读密钥；不存在就生成一把（32 字节随机，十六进制存放）。返回 { key, key_id, file }。 */
export function loadKey({ file = defaultKeyFile(), create = true } = {}) {
  let text = null
  try {
    text = readFileSync(file, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (text === null || text === '') {
    if (!create) return null
    text = randomBytes(32).toString('hex')
    mkdirSync(dirname(file), { recursive: true })
    // wx：并发时只有一个能写成功，失败的一方读回别人写的那把
    try {
      writeFileSync(file, text + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      text = readFileSync(file, 'utf8').trim()
    }
  }
  const key = Buffer.from(text, 'hex')
  if (key.length < 16) throw new Error(`签名密钥文件内容不合法：${file}`)
  // key_id 只用于核对「冻结时和现在是不是同一把」，不泄露密钥本身
  const key_id = 'kid:' + createHash('sha256').update(key).digest('hex').slice(0, 16)
  return { key, key_id, file }
}

function strip(record) {
  const { sig, ...body } = record
  return body
}

export function signRecord(key, record) {
  const mac = createHmac('sha256', key).update(canonicalJson(strip(record))).digest('hex')
  return { ...record, sig: `${SIG_ALG}:${mac}` }
}

export function verifyRecord(key, record) {
  if (!record || typeof record !== 'object' || typeof record.sig !== 'string') return false
  const expected = signRecord(key, record).sig
  const a = Buffer.from(expected)
  const b = Buffer.from(record.sig)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 按 doc.signing 取本 run 的签名上下文。
 * 返回 { ok:true, key|null }（null = 旧 run 不验签）或 { ok:false, error }（登记过但现在密钥对不上）。
 */
export function signingContext(doc, { keyFile } = {}) {
  if (!doc?.signing) return { ok: true, key: null }
  const loaded = loadKey({ file: keyFile ?? defaultKeyFile(), create: false })
  if (loaded === null) return { ok: false, error: 'signing-key-missing', hint: `本 run 冻结时启用了签名，但找不到密钥文件 ${defaultKeyFile()}` }
  if (loaded.key_id !== doc.signing.key_id) {
    return { ok: false, error: 'signing-key-mismatch', hint: `密钥与冻结时登记的不是同一把（冻结 ${doc.signing.key_id}，现在 ${loaded.key_id}）` }
  }
  return { ok: true, key: loaded.key }
}
