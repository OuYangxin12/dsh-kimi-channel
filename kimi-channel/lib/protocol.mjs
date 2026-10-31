/**
 * Wire protocol v1 for the Kimi channel: frame encoding, request validation,
 * and the closed method set.
 *
 * Three frame kinds:
 *   req  { v, t: 'req', id, method, params }
 *   res  { v, t: 'res', id, ok, result? , error? }
 *   evt  { v, t: 'evt', seq, conversationKey?, event, data }
 */

export const PROTOCOL_VERSION = 1

/** Request methods this server accepts. */
export const METHODS = Object.freeze([
  'session.ensure',
  'prompt.submit',
  'prompt.steer',
  'prompt.abort',
  'interaction.respond',
  'state.snapshot',
  'events.resume',
  'health',
])

/** Event names the server emits. */
export const EVENT_NAMES = Object.freeze([
  'ready',
  'session',
  'turn_start',
  'text',
  'thinking',
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'interaction',
  'interaction_resolved',
  'turn_end',
  'final',
  'status',
  'error',
  'server_error',
])

/** Closed error-code vocabulary. */
export const ERROR_CODES = Object.freeze([
  'BAD_FRAME',
  'BAD_VERSION',
  'BAD_PARAMS',
  'UNKNOWN_METHOD',
  'NOT_FOUND',
  'NOT_CONNECTED',
  'CONFLICT',
  'CWD_NOT_ALLOWED',
  'SESSION_FAILED',
  'UNAUTHORIZED',
  'TIMEOUT',
  'INTERNAL',
])

/** @typedef {{ code: string, message: string, details?: unknown }} ProtocolError */

/** Raised for a client mistake; carries a protocol error code. */
export class ChannelError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
    this.details = details
  }

  /** @returns {ProtocolError} */
  toProtocolError() {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

/**
 * Validate one request frame.
 * @param {unknown} value - parsed JSON payload.
 * @returns {{id: string, method: string, params: Record<string, unknown>}}
 * @throws {ChannelError} BAD_FRAME / BAD_VERSION / UNKNOWN_METHOD
 */
export function validateRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelError('BAD_FRAME', 'request frame must be a JSON object')
  }
  const frame = /** @type {Record<string, unknown>} */ (value)
  const id = frame.id
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new ChannelError('BAD_FRAME', 'request id must be a non-empty string of at most 128 characters')
  }
  if (frame.v === undefined) {
    throw new ChannelError('BAD_VERSION', 'frame is missing the protocol version field "v"', { expected: PROTOCOL_VERSION })
  }
  if (frame.v !== PROTOCOL_VERSION) {
    throw new ChannelError('BAD_VERSION', `unsupported protocol version ${JSON.stringify(frame.v)}`, { expected: PROTOCOL_VERSION })
  }
  if (frame.t !== undefined && frame.t !== 'req') {
    throw new ChannelError('BAD_FRAME', `client may only send "req" frames, got ${JSON.stringify(frame.t)}`)
  }
  const method = frame.method
  if (typeof method !== 'string' || !METHODS.includes(method)) {
    throw new ChannelError('UNKNOWN_METHOD', `unknown method ${JSON.stringify(method)}`, { methods: METHODS })
  }
  const params = frame.params ?? {}
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ChannelError('BAD_PARAMS', 'params must be a JSON object')
  }
  return { id, method, params: /** @type {Record<string, unknown>} */ (params) }
}

/**
 * Build a success response frame.
 * @param {string} id
 * @param {unknown} result
 */
export function successFrame(id, result) {
  return JSON.stringify({ v: PROTOCOL_VERSION, t: 'res', id, ok: true, result })
}

/**
 * Build a failure response frame.
 * @param {string} id
 * @param {ProtocolError} error
 */
export function errorFrame(id, error) {
  return JSON.stringify({ v: PROTOCOL_VERSION, t: 'res', id, ok: false, error })
}

/**
 * Build a notification frame.
 * @param {number} seq
 * @param {string} event
 * @param {unknown} data
 * @param {string} [conversationKey]
 */
export function eventFrame(seq, event, data, conversationKey) {
  const frame = { v: PROTOCOL_VERSION, t: 'evt', seq, event, data }
  if (conversationKey !== undefined) frame.conversationKey = conversationKey
  return frame
}

/**
 * Validate an event name used by the server; guards programming mistakes.
 * @param {string} event
 */
export function assertEventName(event) {
  if (!EVENT_NAMES.includes(event)) throw new Error(`kimi-channel: unknown event name ${event}`)
}

/**
 * Read a required string parameter.
 * @param {Record<string, unknown>} params
 * @param {string} name
 * @param {{maxLength?: number}} [options]
 */
export function requireString(params, name, options = {}) {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ChannelError('BAD_PARAMS', `"${name}" must be a non-empty string`)
  }
  const max = options.maxLength ?? 4096
  if (value.length > max) {
    throw new ChannelError('BAD_PARAMS', `"${name}" must be at most ${max} characters`)
  }
  return value
}

/**
 * Read an optional string parameter.
 * @param {Record<string, unknown>} params
 * @param {string} name
 */
export function optionalString(params, name) {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ChannelError('BAD_PARAMS', `"${name}" must be a string`)
  return value
}

/**
 * Read an optional boolean parameter.
 * @param {Record<string, unknown>} params
 * @param {string} name
 */
export function optionalBoolean(params, name) {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ChannelError('BAD_PARAMS', `"${name}" must be a boolean`)
  return value
}

/**
 * Read an optional non-negative integer parameter.
 * @param {Record<string, unknown>} params
 * @param {string} name
 */
export function optionalInteger(params, name) {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new ChannelError('BAD_PARAMS', `"${name}" must be a non-negative integer`)
  }
  return value
}
