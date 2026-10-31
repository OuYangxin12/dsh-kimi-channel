/** Bearer-token management for the loopback channel. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Read the current token, optionally rotating it first.
 * The file is created with mode 0600 and its directory with 0700.
 * @param {string} file - absolute token file path.
 * @param {{rotate?: boolean}} [options]
 * @returns {string} the token in effect for this process.
 */
export function ensureToken(file, options = {}) {
  if (options.rotate !== true) {
    try {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (existing.length >= 32) return existing
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
  return token
}

/**
 * Constant-time string comparison for tokens of arbitrary length.
 * @param {string} expected
 * @param {string} received
 * @returns {boolean}
 */
export function tokenMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Extract a bearer token from an HTTP request: `Authorization` header first,
 * then a `token` query parameter (kept for clients that cannot set headers).
 * @param {import('node:http').IncomingMessage} request
 * @returns {string | undefined}
 */
export function bearerToken(request) {
  const header = request.headers?.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1].trim()
  }
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const query = url.searchParams.get('token')
    if (query) return query
  } catch {
    /* fall through */
  }
  return undefined
}
