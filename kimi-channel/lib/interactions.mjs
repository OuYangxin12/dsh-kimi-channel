/**
 * Approval and user-question bridging: forward an interaction to the
 * connected client, wait for its decision, and fail closed on timeout.
 *
 * The broker is transport-agnostic: the channel supplies `emit` and wires the
 * returned promise into the Cordis waterfall. Whitelisted read-only tools are
 * granted without asking, but the grant is still announced so the client sees
 * every decision.
 */
import { ChannelError } from './protocol.mjs'

/** Sentinel: delegate the request to the next answerer instead of claiming it. */
export const DELEGATE = Symbol('delegate')

/** Decisions a client may send for one interaction. */
export const DECISIONS = Object.freeze(['allow', 'deny', 'cancel', 'answer'])

/**
 * Whether one tool name is auto-approved by the configured whitelist.
 * A trailing `*` matches a name prefix.
 * @param {string} toolName
 * @param {readonly string[]} whitelist
 */
export function isAutoAllowed(toolName, whitelist) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  for (const entry of whitelist) {
    if (entry === toolName) return true
    if (entry.endsWith('*') && toolName.startsWith(entry.slice(0, -1))) return true
  }
  return false
}

export class InteractionBroker {
  /**
   * @param {{
   *   emit: (event: string, data: object) => void,
   *   timeoutMs: number,
   *   autoAllowTools: readonly string[],
   *   canAutoAllow?: () => boolean,
   *   logger?: { warn: (message: string) => void },
   * }} options
   */
  constructor(options) {
    this.emit = options.emit
    this.timeoutMs = options.timeoutMs
    this.autoAllowTools = options.autoAllowTools
    this.canAutoAllow = options.canAutoAllow ?? (() => true)
    this.logger = options.logger
    /** @type {Map<string, {id: string, kind: string, conversationKey: string, resolve: (value: unknown) => void, timer: NodeJS.Timeout, cleanup: () => void}>} */
    this.pending = new Map()
    this.counter = 0
  }

  /**
   * Answer one approval ask.
   * @param {string} conversationKey
   * @param {{toolName?: string, callId?: string, reason?: string, signal?: AbortSignal}} request
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'>}
   */
  async handleApproval(conversationKey, request) {
    const toolName = request?.toolName ?? 'unknown'
    if (this.canAutoAllow() && isAutoAllowed(toolName, this.autoAllowTools)) {
      const data = {
        id: this.#nextId(),
        kind: 'approval',
        conversationKey,
        toolName,
        callId: request?.callId,
        reason: request?.reason,
        auto: true,
        outcome: 'allowed-once',
      }
      this.emit('interaction', data)
      this.emit('interaction_resolved', { id: data.id, outcome: 'allowed-once', auto: true })
      return 'allowed-once'
    }
    const interaction = await this.#ask(conversationKey, {
      kind: 'approval',
      toolName,
      callId: request?.callId,
      reason: request?.reason,
      signal: request?.signal,
    })
    if (interaction.timeout) return 'rejected'
    if (interaction.aborted) return 'cancelled'
    if (interaction.decision === 'allow') return 'allowed-once'
    if (interaction.decision === 'cancel') return 'cancelled'
    return 'rejected'
  }

  /**
   * Answer one structured user question.
   * @param {string} conversationKey
   * @param {{questions?: unknown, wait?: {callId?: string}, signal?: AbortSignal}} request
   * @returns {Promise<{answers: Array<{id: string, selected: string[], custom?: string}>} | typeof DELEGATE>}
   */
  async handleQuestion(conversationKey, request) {
    const interaction = await this.#ask(conversationKey, {
      kind: 'question',
      questions: request?.questions,
      callId: request?.wait?.callId,
      signal: request?.signal,
    })
    if (interaction.timeout || interaction.aborted) return DELEGATE
    if (interaction.decision !== 'answer' || !interaction.answer) return DELEGATE
    const answers = normalizeAnswers(interaction.answer)
    if (answers.length === 0) return DELEGATE
    return { answers }
  }

  /**
   * Settle one pending interaction from a client response.
   * @param {string} interactionId
   * @param {{decision?: unknown, answer?: unknown}} response
   * @returns {{interactionId: string, decision: string}}
   * @throws {ChannelError} NOT_FOUND / BAD_PARAMS
   */
  respond(interactionId, response) {
    const pending = this.pending.get(interactionId)
    if (!pending) throw new ChannelError('NOT_FOUND', `no pending interaction with id ${JSON.stringify(interactionId)}`)
    const decision = response?.decision
    if (!DECISIONS.includes(decision)) {
      throw new ChannelError('BAD_PARAMS', `decision must be one of ${DECISIONS.join(', ')}`)
    }
    if (decision === 'answer' && (response.answer === undefined || response.answer === null)) {
      throw new ChannelError('BAD_PARAMS', 'decision "answer" requires an "answer" payload')
    }
    this.pending.delete(interactionId)
    pending.cleanup()
    pending.resolve({ decision, answer: response.answer, timeout: false, aborted: false })
    this.emit('interaction_resolved', { id: interactionId, outcome: decision })
    return { interactionId, decision }
  }

  /**
   * Describe every pending interaction for `state.snapshot`.
   * @param {string} [conversationKey]
   */
  list(conversationKey) {
    const out = []
    for (const pending of this.pending.values()) {
      if (conversationKey !== undefined && pending.conversationKey !== conversationKey) continue
      out.push({
        id: pending.id,
        kind: pending.kind,
        conversationKey: pending.conversationKey,
        toolName: pending.toolName,
        callId: pending.callId,
        reason: pending.reason,
        questions: pending.questions,
        createdAt: pending.createdAt,
      })
    }
    return out
  }

  /** Reject every pending interaction (plugin teardown). */
  dispose() {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.resolve({ decision: 'cancel', timeout: false, aborted: true })
    }
  }

  /**
   * Create one pending interaction, announce it, and await its settlement.
   * @param {string} conversationKey
   * @param {{kind: string, toolName?: string, callId?: string, reason?: string, questions?: unknown, signal?: AbortSignal}} spec
   * @returns {Promise<{decision?: string, answer?: unknown, timeout: boolean, aborted: boolean}>}
   */
  #ask(conversationKey, spec) {
    const id = this.#nextId()
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        this.emit('interaction_resolved', { id, outcome: 'cancelled' })
        finish({ decision: 'cancel', timeout: false, aborted: true })
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        this.emit('interaction_resolved', { id, outcome: 'timeout' })
        this.logger?.warn(`kimi-channel: interaction ${id} (${spec.kind}) timed out after ${this.timeoutMs}ms`)
        finish({ decision: 'deny', timeout: true, aborted: false })
      }, this.timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        spec.signal?.removeEventListener?.('abort', onAbort)
      }
      if (spec.signal?.aborted === true) {
        cleanup()
        this.emit('interaction_resolved', { id, outcome: 'cancelled' })
        finish({ decision: 'cancel', timeout: false, aborted: true })
        return
      }
      spec.signal?.addEventListener?.('abort', onAbort, { once: true })
      this.pending.set(id, {
        id,
        kind: spec.kind,
        conversationKey,
        toolName: spec.toolName,
        callId: spec.callId,
        reason: spec.reason,
        questions: spec.questions,
        createdAt: Date.now(),
        resolve: finish,
        timer,
        cleanup,
      })
      this.emit('interaction', {
        id,
        kind: spec.kind,
        conversationKey,
        toolName: spec.toolName,
        callId: spec.callId,
        reason: spec.reason,
        questions: spec.questions,
        auto: false,
      })
    })
  }

  #nextId() {
    this.counter += 1
    return `int-${Date.now().toString(36)}-${this.counter}`
  }
}

/**
 * Normalize a client's answer payload into the service shape.
 * @param {unknown} answer
 * @returns {Array<{id: string, selected: string[], custom?: string}>}
 */
export function normalizeAnswers(answer) {
  const items = Array.isArray(answer) ? answer : Array.isArray(answer?.answers) ? answer.answers : []
  const out = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.id !== 'string' || item.id.length === 0) continue
    const selected = Array.isArray(item.selected) ? item.selected.filter((value) => typeof value === 'string') : []
    const entry = { id: item.id, selected }
    if (typeof item.custom === 'string' && item.custom.length > 0) entry.custom = item.custom
    out.push(entry)
  }
  return out
}
