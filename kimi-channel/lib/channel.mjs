/**
 * Channel runtime: loopback HTTP/WebSocket server, method dispatch, DSH session
 * and turn bridging, and event projection.
 *
 * Security posture (design §3.3): bind only to a loopback address, require a
 * bearer token stored 0600, reject non-loopback peers, and fail closed when an
 * interaction times out.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'

import { loadConfig, isCwdAllowed } from './config.mjs'
import { InteractionBroker, DELEGATE } from './interactions.mjs'
import { TurnRecorder, projectSessionEvent } from './projection.mjs'
import {
  ChannelError,
  PROTOCOL_VERSION,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireString,
  successFrame,
  errorFrame,
  validateRequest,
} from './protocol.mjs'
import { EventBuffer, IdempotencyTable, SessionMap } from './store.mjs'
import { attachWebSocketServer } from './ws.mjs'
import { bearerToken, ensureToken, tokenMatches } from './token.mjs'

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Start the channel for the lifetime of the plugin's fiber.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [rowConfig] - Loader row config.
 * @returns {void}
 */
export function startChannel(ctx, rowConfig = {}) {
  const log = loggerOf(ctx)
  let resolved
  try {
    resolved = loadConfig(rowConfig)
  } catch (error) {
    log.warn?.(`kimi-channel: configuration invalid, channel not started: ${error.message}`)
    return
  }
  const { config } = resolved
  const startedAt = Date.now()
  const token = ensureToken(config.tokenFile, { rotate: config.rotateTokenOnStart !== false })

  const sessionMap = new SessionMap(config.sessionMapFile).load()
  if (sessionMap.corrupt) log.warn?.(`kimi-channel: session map ${config.sessionMapFile} is corrupt; starting empty`)

  /** @type {Map<string, Conversation>} */
  const conversations = new Map()
  const bySessionId = new Map()
  const idempotency = new IdempotencyTable()
  const buffer = new EventBuffer(config.eventBufferSize)

  const broadcast = (frame) => {
    const text = JSON.stringify(frame)
    for (const connection of ws.connections) {
      if (!connection.closed) connection.sendText(text)
    }
  }

  const emit = (event, data, conversationKey) => {
    const frame = buffer.push(event, data, conversationKey)
    broadcast(frame)
    return frame
  }

  const broker = new InteractionBroker({
    emit: (event, data) => emit(event, data, data?.conversationKey),
    timeoutMs: config.interactionTimeoutMs,
    autoAllowTools: config.autoAllowTools,
    logger: log,
  })

  // ---------------------------------------------------------------- sessions

  /**
   * @typedef {{
   *   key: string,
   *   sessionId: string,
   *   cwd: string,
   *   agent: object,
   *   handle: {dispose: () => Promise<void>} | undefined,
   *   recorder: TurnRecorder,
   *   streamDeltas: boolean,
   *   lastTurn: number,
   * }} Conversation
   */

  /**
   * @param {string} key
   * @returns {Conversation}
   */
  const requireConversation = (key) => {
    const conversation = conversations.get(key)
    if (!conversation) throw new ChannelError('NOT_FOUND', `no session for conversationKey ${JSON.stringify(key)}; call session.ensure first`)
    return conversation
  }

  const conversationSummary = (conversation) => ({
    conversationKey: conversation.key,
    sessionId: conversation.sessionId,
    cwd: conversation.cwd,
    turn: conversation.lastTurn,
    status: conversation.agent?.status ?? 'unknown',
  })

  /**
   * Resolve the model route for a channel-owned agent.
   * @returns {object} AgentOptions
   */
  const agentOptions = () => {
    const configured = config.agent ?? {}
    if (typeof configured.provider === 'string' && typeof configured.model === 'string') {
      const options = { provider: configured.provider, model: configured.model }
      if (typeof configured.reasoningEffort === 'string') options.reasoningEffort = configured.reasoningEffort
      return options
    }
    try {
      const defaultModel = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      const selection = defaultModel?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        const options = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort
        return options
      }
    } catch (error) {
      log.warn?.(`kimi-channel: default model selection unavailable: ${error?.message ?? error}`)
    }
    return {}
  }

  /**
   * Resolve the agent preset the channel mounts into its agents, matching what
   * the Web app does so channel sessions get the same tools.
   * @param {string | undefined} presetId
   * @returns {Promise<{id: string, setup: (agentCtx: object) => Promise<void>} | undefined>}
   */
  const resolvePresetMount = async (presetId) => {
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (!presets) return undefined
    try {
      const preset = await presets.resolve(presetId)
      return {
        id: preset.id,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, preset.id)
        },
      }
    } catch (error) {
      log.warn?.(`kimi-channel: agent preset unavailable, agents get only root tools: ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * Create or resume the agent backing one conversation.
   * @param {string} key
   * @param {string} cwd
   * @returns {Promise<Conversation>}
   */
  const openConversation = async (key, cwd, streamDeltas) => {
    /** @type {Record<string, unknown>} */
    const options = agentOptions()
    const existing = conversations.get(key)
    if (existing && ctx.agents?.get?.(existing.sessionId) === existing.agent) {
      existing.streamDeltas = streamDeltas
      emit('session', { ...conversationSummary(existing), fresh: false }, key)
      return existing
    }
    const mapped = existing ?? sessionMap.get(key)
    let sessionId = typeof mapped?.sessionId === 'string' ? mapped.sessionId : undefined
    let handle
    let agent
    let fresh = false
    // Agents created outside the Web app only get the preset's tools (fs, bash,
    // search, skills, ...) when that preset is mounted into the agent scope.
    const presetMount = await resolvePresetMount(config.agentPreset)
    const setup = presetMount?.setup
    const presetMeta = presetMount?.id ? { agentPreset: presetMount.id } : {}

    if (sessionId && ctx.agents?.get?.(sessionId)) {
      agent = ctx.agents.get(sessionId)
    } else if (sessionId) {
      try {
        handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options, setup })
        agent = handle.agent
      } catch (error) {
        log.info?.(`kimi-channel: resume of ${sessionId} failed (${error?.message ?? error}); creating a fresh session`)
        sessionId = undefined
      }
    }
    if (!agent) {
      sessionId = sessionId ?? mintSessionId(key)
      try {
        handle = await ctx.agents.create({ sessionId, meta: { cwd, ...presetMeta }, agentOptions: options, setup })
      } catch (error) {
        const replacement = mintSessionId(key)
        log.warn?.(`kimi-channel: create of ${sessionId} failed (${error?.message ?? error}); retrying as ${replacement}`)
        sessionId = replacement
        handle = await ctx.agents.create({ sessionId, meta: { cwd, ...presetMeta }, agentOptions: options, setup })
      }
      agent = handle.agent
      fresh = true
    }

    sessionMap.set(key, { sessionId, cwd })
    const conversation = {
      key,
      sessionId,
      cwd,
      agent,
      handle,
      recorder: new TurnRecorder(),
      streamDeltas,
      lastTurn: 0,
    }
    conversations.set(key, conversation)
    bySessionId.set(sessionId, conversation)
    const summary = { ...conversationSummary(conversation), fresh }
    emit('session', summary, key)
    return conversation
  }

  // --------------------------------------------------------------- DSH hooks

  /** @param {object} session @param {object} event */
  const onSessionEvent = (session, event) => {
    const conversation = bySessionId.get(session?.id)
    if (!conversation) return
    let projected
    try {
      projected = projectSessionEvent(event, conversation.recorder)
    } catch (error) {
      log.warn?.(`kimi-channel: projection failed for ${event?.type}: ${error?.message ?? error}`)
      return
    }
    for (const item of projected) {
      emit(item.event, item.data, conversation.key)
      if (item.event === 'final') conversation.lastFinal = item.data
    }
    if (event?.type === 'turn/start') conversation.lastTurn = event.data?.turn ?? conversation.lastTurn
    if (event?.type === 'turn/end') conversation.lastTurn = event.data?.turn ?? conversation.lastTurn
  }

  /** @param {{agent: object, frame: object}} payload */
  const onAssistantStream = (payload) => {
    const agent = payload?.agent
    const frame = payload?.frame
    if (!agent || !frame) return
    const conversation = bySessionId.get(agent.id)
    if (!conversation || conversation.streamDeltas !== true) return
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      emit('text_delta', { turn: frame.turn, step: frame.step, text: chunk.text }, conversation.key)
    } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      emit('thinking_delta', { turn: frame.turn, step: frame.step, text: chunk.text }, conversation.key)
    }
  }

  /** @param {{agent: object, status: string}} payload */
  const onAgentStatus = (payload) => {
    const conversation = bySessionId.get(payload?.agent?.id)
    if (!conversation) return
    emit('status', { agentStatus: payload.status, turn: conversation.lastTurn }, conversation.key)
  }

  /** @param {{agent: object, turn?: number, step?: number, error: unknown}} payload */
  const onAgentError = (payload) => {
    const conversation = bySessionId.get(payload?.agent?.id)
    if (!conversation) return
    emit(
      'error',
      { turn: payload.turn, step: payload.step, code: 'AGENT_ERROR', message: errorMessage(payload.error) },
      conversation.key,
    )
  }

  /**
   * Waterfall answerer for approvals raised by channel-owned agents.
   * Unknown agents delegate, so the Web UI keeps working.
   */
  const onApprovalRequest = async (request, next) => {
    const conversation = bySessionId.get(request?.agent?.id)
    if (!conversation) return next()
    try {
      return await broker.handleApproval(conversation.key, request)
    } catch (error) {
      log.warn?.(`kimi-channel: approval bridging failed: ${error?.message ?? error}`)
      return next()
    }
  }

  /** Waterfall answerer for structured questions raised by channel-owned agents. */
  const onQuestionRequest = async (request, next) => {
    const conversation = bySessionId.get(request?.agent?.id)
    if (!conversation) return next()
    try {
      const answer = await broker.handleQuestion(conversation.key, request)
      if (answer === DELEGATE) return next()
      return answer
    } catch (error) {
      log.warn?.(`kimi-channel: question bridging failed: ${error?.message ?? error}`)
      return next()
    }
  }

  // ----------------------------------------------------------- method table

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {string} requestId
   * @returns {Promise<unknown>}
   */
  const dispatch = async (method, params, requestId) => {
    switch (method) {
      case 'health':
        return {
          ok: true,
          protocol: PROTOCOL_VERSION,
          pid: process.pid,
          startedAt,
          conversations: conversations.size,
          clients: ws.connections.size,
          port: config.port,
        }
      case 'session.ensure': {
        const key = requireString(params, 'conversationKey', { maxLength: 200 })
        const requestedCwd = optionalString(params, 'cwd')
        const streamDeltas = optionalBoolean(params, 'streamDeltas') ?? config.streamDeltas
        const previous = conversations.get(key) ?? sessionMap.get(key)
        const cwd = requestedCwd ? path.resolve(requestedCwd) : path.resolve(previous?.cwd ?? config.defaultCwd)
        if (!isCwdAllowed(cwd, config.allowCwdRoots)) {
          throw new ChannelError('CWD_NOT_ALLOWED', `cwd ${cwd} is outside allowCwdRoots`, { allowCwdRoots: config.allowCwdRoots })
        }
        const conversation = await openConversation(key, cwd, streamDeltas)
        return {
          ...conversationSummary(conversation),
          fresh: (previous?.sessionId ?? undefined) !== conversation.sessionId,
        }
      }
      case 'prompt.submit': {
        const key = requireString(params, 'conversationKey', { maxLength: 200 })
        const text = requireString(params, 'text', { maxLength: 1_000_000 })
        const conversation = requireConversation(key)
        const idempotencyKey = `${key}:submit:${requestId}`
        const seen = idempotency.get(idempotencyKey)
        if (seen?.pending) return seen.pending
        if (seen?.result !== undefined) return seen.result
        const pending = (async () => {
          const message = createUserMessage(text)
          conversation.agent.followup(message)
          return { accepted: true, messageId: message.id, sessionId: conversation.sessionId, conversationKey: key }
        })()
        idempotency.set(idempotencyKey, { pending })
        try {
          const result = await pending
          idempotency.set(idempotencyKey, { result })
          return result
        } catch (error) {
          idempotency.delete(idempotencyKey)
          throw error
        }
      }
      case 'prompt.steer': {
        const key = requireString(params, 'conversationKey', { maxLength: 200 })
        const text = requireString(params, 'text', { maxLength: 1_000_000 })
        const conversation = requireConversation(key)
        const message = createUserMessage(text)
        conversation.agent.steer(message)
        return { queued: true, messageId: message.id, conversationKey: key }
      }
      case 'prompt.abort': {
        const key = requireString(params, 'conversationKey', { maxLength: 200 })
        const reason = optionalString(params, 'reason') ?? 'client abort'
        const conversation = requireConversation(key)
        conversation.agent.cancel({ kind: 'user' })
        log.info?.(`kimi-channel: aborted ${conversation.sessionId}: ${reason}`)
        return { aborted: true, conversationKey: key }
      }
      case 'interaction.respond': {
        const interactionId = requireString(params, 'interactionId', { maxLength: 200 })
        const decision = requireString(params, 'decision', { maxLength: 32 })
        return broker.respond(interactionId, { decision, answer: params.answer })
      }
      case 'state.snapshot': {
        const key = optionalString(params, 'conversationKey')
        const conversation = key ? conversations.get(key) : undefined
        return {
          protocol: PROTOCOL_VERSION,
          lastSeq: buffer.lastSeq,
          clients: ws.connections.size,
          conversation: conversation ? conversationSummary(conversation) : null,
          lastFinal: conversation?.lastFinal ?? null,
          pendingInteractions: broker.list(key),
        }
      }
      case 'events.resume': {
        const since = optionalInteger(params, 'since') ?? 0
        const key = optionalString(params, 'conversationKey')
        const limit = optionalInteger(params, 'limit') ?? 500
        const events = buffer.since(since, { conversationKey: key, limit: Math.min(limit, buffer.capacity) })
        return { events, lastSeq: buffer.lastSeq, since }
      }
      default:
        throw new ChannelError('UNKNOWN_METHOD', `unknown method ${JSON.stringify(method)}`)
    }
  }

  // ------------------------------------------------------------- transport

  /** @param {import('node:http').IncomingMessage} request */
  const authorize = (request) => {
    const peer = request.socket?.remoteAddress
    if (!LOOPBACK_PEERS.has(peer)) {
      log.warn?.(`kimi-channel: rejected non-loopback peer ${peer}`)
      return { ok: false, status: 401, message: 'loopback connections only' }
    }
    const received = bearerToken(request)
    if (!received || !tokenMatches(token, received)) {
      log.warn?.(`kimi-channel: rejected connection with a bad token from ${peer}`)
      return { ok: false, status: 401, message: 'invalid token' }
    }
    return { ok: true }
  }

  const httpServer = http.createServer((request, response) => {
    if (request.method === 'GET' && (request.url === '/healthz' || request.url?.startsWith('/healthz?'))) {
      const peer = request.socket?.remoteAddress
      if (!LOOPBACK_PEERS.has(peer)) {
        response.writeHead(401).end('loopback connections only\n')
        return
      }
      const body = JSON.stringify({
        ok: true,
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        startedAt,
        clients: ws.connections.size,
      })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n')
  })
  const ws = attachWebSocketServer(httpServer, { authorize })

  httpServer.on('connection-accepted', (connection) => {
    connection.on('json', (frame) => {
      void handleFrame(connection, frame)
    })
    connection.on('bad-json', () => {
      connection.sendJson({ v: PROTOCOL_VERSION, t: 'res', id: null, ok: false, error: { code: 'BAD_FRAME', message: 'frame is not valid JSON' } })
    })
    connection.on('closing', (code) => {
      log.info?.(`kimi-channel: client disconnected (code ${code})`)
    })
    connection.sendJson({
      v: PROTOCOL_VERSION,
      t: 'evt',
      seq: buffer.lastSeq,
      event: 'ready',
      data: {
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        startedAt,
        lastSeq: buffer.lastSeq,
        conversations: [...conversations.values()].map((conversation) => conversationSummary(conversation)),
        autoAllowTools: config.autoAllowTools,
        interactionTimeoutMs: config.interactionTimeoutMs,
      },
    })
  })

  /**
   * Handle one client frame; protocol mistakes answer with a failure frame and
   * never tear the connection down (design §5).
   * @param {import('./ws.mjs').WsConnection} connection
   * @param {unknown} frame
   */
  const handleFrame = async (connection, frame) => {
    let request
    try {
      request = validateRequest(frame)
    } catch (error) {
      const id = typeof frame?.id === 'string' ? frame.id : null
      const protocolError = error instanceof ChannelError ? error.toProtocolError() : { code: 'BAD_FRAME', message: String(error) }
      connection.sendText(errorFrame(id, protocolError))
      return
    }
    try {
      const result = await dispatch(request.method, request.params, request.id)
      connection.sendText(successFrame(request.id, result))
    } catch (error) {
      const protocolError =
        error instanceof ChannelError
          ? error.toProtocolError()
          : { code: 'INTERNAL', message: errorMessage(error) }
      if (!(error instanceof ChannelError)) {
        log.warn?.(`kimi-channel: ${request.method} failed: ${errorMessage(error)}`)
      }
      connection.sendText(errorFrame(request.id, protocolError))
    }
  }

  httpServer.on('error', (error) => {
    log.warn?.(`kimi-channel: HTTP server error: ${error?.message ?? error}`)
  })
  httpServer.listen(config.port, config.host, () => {
    log.info?.(`kimi-channel: listening on ws://${config.host}:${config.port} (token ${config.tokenFile})`)
  })

  // ------------------------------------------------------------- lifecycle

  const disposers = []
  const on = (name, handler) => {
    if (typeof ctx?.on !== 'function') return
    const disposer = ctx.on(name, handler)
    if (typeof disposer === 'function') disposers.push(disposer)
  }
  on('session/event', onSessionEvent)
  on('agent/assistant-stream', onAssistantStream)
  on('agent/status', onAgentStatus)
  on('agent/error', onAgentError)
  on('approval/request', onApprovalRequest)
  on('user-questions/request', onQuestionRequest)

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch {
        /* contained */
      }
    }
    broker.dispose()
    ws.close()
    await new Promise((resolve) => {
      httpServer.close(() => resolve())
      setTimeout(resolve, 500).unref?.()
    })
    for (const conversation of conversations.values()) {
      if (conversation.handle?.dispose) {
        try {
          await conversation.handle.dispose()
        } catch (error) {
          log.warn?.(`kimi-channel: disposing ${conversation.sessionId} failed: ${error?.message ?? error}`)
        }
      }
    }
    conversations.clear()
    bySessionId.clear()
    log.info?.('kimi-channel: stopped')
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => dispose)
  } else if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      void dispose()
    })
  }

  return { dispose, config, emit, conversations }
}

/**
 * Mint a stable-looking session id for one conversation key.
 * @param {string} conversationKey
 * @returns {string}
 */
export function mintSessionId(conversationKey) {
  const digest = crypto.createHash('sha256').update(String(conversationKey)).digest('hex').slice(0, 8)
  return `kimi-${digest}-${Date.now().toString(36)}`
}

/**
 * Build the frozen user message the agent inbox accepts.
 * @param {string} text
 * @returns {{id: string, role: 'user', content: readonly object[], source: {kind: 'user'}}}
 */
export function createUserMessage(text) {
  if (typeof text !== 'string') throw new TypeError('prompt text must be a string')
  const content = Object.freeze([Object.freeze({ type: 'text', text })])
  return Object.freeze({
    id: `msg-${crypto.randomUUID()}`,
    role: 'user',
    content,
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * @param {object} ctx
 * @returns {{info?: (message: string) => void, warn?: (message: string) => void}}
 */
function loggerOf(ctx) {
  const logger = ctx?.logger
  if (logger && typeof logger.warn === 'function') return logger
  return { info: (message) => console.log(message), warn: (message) => console.warn(message) }
}
