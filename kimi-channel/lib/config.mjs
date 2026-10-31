/** Configuration resolution for the Kimi channel plugin. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Default read-only tools that may be auto-approved for channel-owned agents. */
export const DEFAULT_AUTO_ALLOW_TOOLS = Object.freeze([
  'read',
  'glob',
  'grep',
  'ls',
  'list_dir',
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_trace',
  'web_search',
  'web_fetch',
  'hindsight_search_knowledge_pages',
  'hindsight_list_knowledge_pages',
  'hindsight_read_knowledge_page',
  'hindsight_sync_status',
  'hindsight_diagnose',
])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * @returns {string} DSH home directory for this process.
 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Expand a leading `~` and resolve a path against the DSH home.
 * @param {string} value
 * @param {string} home
 * @returns {string}
 */
export function resolveHomePath(value, home = dshHome()) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('path must be a non-empty string')
  if (value === '~') return home
  if (value.startsWith('~/')) return path.join(home, value.slice(2))
  return path.resolve(value)
}

/**
 * Build the effective config: defaults, then row config, then the JSON file.
 * @param {object} rowConfig - Loader row config.
 * @param {{home?: string, file?: string}} [options]
 * @returns {{config: object, sources: string[]}}
 */
export function loadConfig(rowConfig = {}, options = {}) {
  const home = options.home ?? dshHome()
  const file = options.file ?? path.join(home, 'kimi-channel.json')
  const sources = ['defaults']
  const merged = { ...defaults(home) }
  if (rowConfig && typeof rowConfig === 'object' && Object.keys(rowConfig).length > 0) {
    mergeInto(merged, rowConfig)
    sources.push('row')
  }
  if (options.readFile !== false) {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (raw !== undefined) {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`kimi-channel: ${file} is not valid JSON: ${error.message}`)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`kimi-channel: ${file} must contain a JSON object`)
      }
      mergeInto(merged, parsed)
      sources.push(file)
    }
  }
  validate(merged)
  return { config: normalize(merged, home), sources }
}

/** @param {string} home */
function defaults(home) {
  return {
    host: '127.0.0.1',
    port: 8137,
    tokenFile: path.join(home, 'kimi-channel.token'),
    rotateTokenOnStart: true,
    sessionMapFile: path.join(home, 'kimi-channel-sessions.json'),
    eventBufferSize: 2000,
    interactionTimeoutMs: 120000,
    autoAllowTools: [...DEFAULT_AUTO_ALLOW_TOOLS],
    allowCwdRoots: [os.homedir()],
    defaultCwd: os.homedir(),
    streamDeltas: false,
    agentPreset: undefined,
    agent: {},
  }
}

/**
 * Shallow-merge known sections (`approval`, `agent`) and replace scalar keys.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    target[key] = value
  }
}

/** Validate the merged config and throw a readable error. */
function validate(config) {
  if (typeof config.host !== 'string' || !LOOPBACK_HOSTS.has(config.host)) {
    throw new Error(`kimi-channel: host must be a loopback address, got ${JSON.stringify(config.host)}`)
  }
  const port = config.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`kimi-channel: port must be an integer 1-65535, got ${JSON.stringify(port)}`)
  }
  if (!Array.isArray(config.autoAllowTools) || config.autoAllowTools.some((t) => typeof t !== 'string')) {
    throw new Error('kimi-channel: autoAllowTools must be an array of tool names')
  }
  if (!Array.isArray(config.allowCwdRoots) || config.allowCwdRoots.some((root) => typeof root !== 'string')) {
    throw new Error('kimi-channel: allowCwdRoots must be an array of absolute paths')
  }
  if (!Number.isInteger(config.eventBufferSize) || config.eventBufferSize < 1) {
    throw new Error('kimi-channel: eventBufferSize must be a positive integer')
  }
  if (!Number.isInteger(config.interactionTimeoutMs) || config.interactionTimeoutMs < 1) {
    throw new Error('kimi-channel: interactionTimeoutMs must be a positive integer')
  }
  if (!config.agent || typeof config.agent !== 'object' || Array.isArray(config.agent)) {
    throw new Error('kimi-channel: agent must be an object')
  }
  if (config.agentPreset !== undefined && (typeof config.agentPreset !== 'string' || config.agentPreset.length === 0)) {
    throw new Error('kimi-channel: agentPreset must be a non-empty string when set')
  }
}

/**
 * Normalize paths against the DSH home and freeze array config.
 * @param {object} config
 * @param {string} home
 */
function normalize(config, home) {
  const normalized = { ...config }
  normalized.tokenFile = resolveHomePath(String(config.tokenFile), home)
  normalized.sessionMapFile = resolveHomePath(String(config.sessionMapFile), home)
  normalized.defaultCwd = path.resolve(String(config.defaultCwd))
  normalized.agent = { ...config.agent }
  normalized.autoAllowTools = Object.freeze([...new Set(config.autoAllowTools.map((tool) => String(tool)))])
  normalized.allowCwdRoots = config.allowCwdRoots.map((root) => path.resolve(resolveHomePath(String(root), home)))
  return Object.freeze(normalized)
}

/**
 * Whether a directory is inside one of the allowed roots.
 * @param {string} cwd absolute path
 * @param {readonly string[]} roots absolute paths
 */
export function isCwdAllowed(cwd, roots) {
  const resolved = path.resolve(cwd)
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}
