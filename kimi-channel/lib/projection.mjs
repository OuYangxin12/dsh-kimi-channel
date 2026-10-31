/**
 * Projection: DSH durable session events -> channel events.
 *
 * The projection is deliberately lossless for the client-facing text and tool
 * data, but hides DSH internals (surface ops, headers, stream records). Every
 * function here is pure so the mapping can be unit-tested without a session.
 */

/** @typedef {{ event: string, data: object }} ChannelEvent */

/**
 * Aggregate one turn's projected events into the `final` trajectory payload.
 */
export class TurnRecorder {
  constructor() {
    this.reset()
  }

  reset() {
    /** @type {number | undefined} */
    this.turn = undefined
    /** @type {Array<object>} */
    this.trajectory = []
    /** @type {string[]} */
    this.texts = []
    /** @type {object | undefined} */
    this.usage = undefined
    this.interrupted = false
  }

  /** @param {number} turn */
  start(turn) {
    this.reset()
    this.turn = turn
  }

  /**
   * @param {object} event `assistant/message`
   * @returns {{ text: string, thinking: string, usage?: object, interrupted: boolean }}
   */
  addAssistant(event) {
    const message = event?.message ?? {}
    let text = ''
    let thinking = ''
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text
      else if (block?.type === 'reasoning' && typeof block.text === 'string') thinking += block.text
    }
    if (event?.usage) this.usage = event.usage
    if (event?.interrupted) this.interrupted = true
    const entry = { type: 'assistant', turn: event?.turn, step: event?.step }
    if (text) {
      this.texts.push(text)
      entry.text = text
    }
    if (thinking) entry.thinking = thinking
    if (event?.usage) entry.usage = event.usage
    if (event?.interrupted) entry.interrupted = true
    this.trajectory.push(entry)
    return { text, thinking, usage: event?.usage, interrupted: event?.interrupted === true }
  }

  /**
   * @param {object} event `tool/call`
   * @returns {{ callId: string, name: string, arguments: unknown, raw: string }}
   */
  addToolCall(event) {
    const raw = typeof event?.arguments === 'string' ? event.arguments : ''
    const entry = {
      type: 'tool_call',
      turn: event?.turn,
      step: event?.step,
      callId: event?.callId,
      name: event?.name,
      arguments: parseArguments(raw),
      raw,
    }
    this.trajectory.push(entry)
    return { callId: event?.callId, name: event?.name, arguments: entry.arguments, raw }
  }

  /**
   * @param {object} event `tool/result`
   * @returns {{ callId: string, ok: boolean, text: string, error?: object }}
   */
  addToolResult(event) {
    const message = event?.message ?? {}
    const text = flattenContent(message.content)
    const ok = message.isError !== true
    const entry = {
      type: 'tool_result',
      turn: event?.turn,
      step: event?.step,
      callId: message.toolCallId ?? event?.callId,
      ok,
      text,
    }
    if (event?.error) entry.error = event.error
    this.trajectory.push(entry)
    return { callId: entry.callId, ok, text, error: event?.error }
  }
}

/**
 * Build the `final` payload from the recorder's accumulated turn.
 * @param {TurnRecorder} recorder
 * @param {{turn: number, reason?: string}} turnEnd
 * @returns {object}
 */
export function buildFinal(recorder, turnEnd) {
  const payload = {
    turn: turnEnd?.turn ?? recorder.turn,
    reason: turnEnd?.reason ?? 'unknown',
    text: recorder.texts.join('\n').trim(),
    trajectory: recorder.trajectory.map((entry) => ({ ...entry })),
    eventCount: recorder.trajectory.length,
  }
  if (recorder.usage) payload.usage = recorder.usage
  if (recorder.interrupted) payload.interrupted = true
  return payload
}

/**
 * Project one committed session event.
 * @param {object} event - a `session/event` payload.
 * @param {TurnRecorder} recorder - per-conversation accumulator, mutated in place.
 * @returns {ChannelEvent[]} channel events for this session event (possibly empty).
 */
export function projectSessionEvent(event, recorder) {
  if (!event || typeof event !== 'object') return []
  switch (event.type) {
    case 'turn/start': {
      recorder.start(event.data?.turn)
      return [{ event: 'turn_start', data: { turn: event.data?.turn } }]
    }
    case 'assistant/message': {
      const { text, thinking, usage, interrupted } = recorder.addAssistant(event.data)
      /** @type {ChannelEvent[]} */
      const out = []
      if (thinking) out.push({ event: 'thinking', data: { turn: event.data?.turn, step: event.data?.step, text: thinking } })
      if (text) out.push({ event: 'text', data: { turn: event.data?.turn, step: event.data?.step, text } })
      if (interrupted) {
        out.push({ event: 'error', data: { turn: event.data?.turn, step: event.data?.step, code: 'INTERRUPTED', message: 'assistant output was interrupted' } })
      }
      if (usage) out.push({ event: 'status', data: { turn: event.data?.turn, usage } })
      return out
    }
    case 'tool/call': {
      const call = recorder.addToolCall(event.data)
      return [{ event: 'tool_call', data: { turn: event.data?.turn, step: event.data?.step, ...call } }]
    }
    case 'tool/result': {
      const result = recorder.addToolResult(event.data)
      return [{ event: 'tool_result', data: { turn: event.data?.turn, step: event.data?.step, ...result } }]
    }
    case 'turn/end': {
      const turnEnd = { turn: event.data?.turn, reason: event.data?.reason }
      const final = buildFinal(recorder, turnEnd)
      recorder.reset()
      return [
        { event: 'turn_end', data: turnEnd },
        { event: 'final', data: final },
      ]
    }
    default:
      return []
  }
}

/**
 * Flatten message content into plain text for tool results.
 * @param {unknown} content
 * @returns {string}
 */
export function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
    else if (block.type === 'tool-call') parts.push(`[tool call ${block.name}]`)
  }
  return parts.join('\n').trim()
}

/**
 * Parse a tool-call argument string, keeping the raw string when it is not JSON.
 * @param {string} raw
 * @returns {unknown}
 */
export function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
