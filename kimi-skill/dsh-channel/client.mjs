#!/usr/bin/env node
/**
 * Kimi Code -> DSH channel client.
 *
 * Zero dependencies: uses Node's built-in WebSocket client and the loopback
 * control channel exposed by the `dsh-kimi-channel` DSH plugin.
 *
 * A manager-style caller usually works like this:
 *
 *   submit  -> hand one task brief to a DSH worker, return immediately
 *   watch   -> follow that worker's turn, answer approvals, wait for `final`
 *   steer   -> correct direction mid-turn without restarting the work
 *   abort   -> stop a turn that is going the wrong way
 *   report  -> read the worker's last final payload and pending interactions
 *
 * `run` is the one-shot convenience: submit + watch.
 *
 * Exit codes: 0 on a completed turn, 1 on error, timeout, or missing final.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_PORT = 8137
const PROTOCOL_VERSION = 1

function usage() {
  return `kimi-dsh client (manager mode)

Usage:
  node client.mjs run    --task "..." [--cwd PATH] [options]     one-shot: submit + watch
  node client.mjs submit --task "..." [--cwd PATH] [options]     hand a brief to a worker, return at once
  node client.mjs watch  --conversation KEY [--since N] [options] follow a worker's turn to final
  node client.mjs steer  --conversation KEY --text "..."          correct direction mid-turn
  node client.mjs abort  --conversation KEY [--reason "..."]      stop the current turn
  node client.mjs report --conversation KEY [--json]              last final payload + pending interactions
  node client.mjs status                                          live channel and conversation state
  node client.mjs health                                          channel reachability

Options:
  --task <text>            Task brief (required for run/submit)
  --text <text>            Steering text (required for steer)
  --reason <text>          Abort reason (abort)
  --cwd <path>             Working directory for the DSH session (default: current directory)
  --conversation <key>     Stable conversation key; one key = one DSH session/worker
  --dsh-home <path>        DSH home holding the token (default: $DSH_HOME or ~/.dsh)
  --port <number>          Channel port (default: config file value, else ${DEFAULT_PORT})
  --allow <tools>          Comma-separated tool names to auto-approve (e.g. write,edit,bash)
  --deny-all               Deny every non-whitelisted approval (default when --allow is absent)
  --answer <json>          Answers for ask_user_question, e.g. '{"q1":["A"]}'
  --timeout <ms>           Turn timeout for run/watch (default 600000)
  --since <seq>            Replay events after this seq before following live (watch)
  --report <path>          Write the final payload JSON to a file (run/watch)
  --stream-deltas          Ask the server for live text deltas
  --json                   Emit every frame as JSON lines on stdout
  --quiet                  Suppress progress on stderr
  -h, --help               Show this help
`
}

/**
 * @param {string[]} argv
 * @returns {{command: string, options: Record<string, unknown>}}
 */
function parseArgs(argv) {
  const options = { allow: [], denyAll: false, json: false, quiet: false, streamDeltas: false, timeout: 600_000 }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--task':
        options.task = argv[++i]
        break
      case '--text':
        options.text = argv[++i]
        break
      case '--reason':
        options.reason = argv[++i]
        break
      case '--cwd':
        options.cwd = argv[++i]
        break
      case '--conversation':
        options.conversation = argv[++i]
        break
      case '--dsh-home':
        options.dshHome = argv[++i]
        break
      case '--port':
        options.port = Number(argv[++i])
        break
      case '--allow':
        options.allow.push(...String(argv[++i] ?? '').split(',').filter(Boolean))
        break
      case '--deny-all':
        options.denyAll = true
        break
      case '--answer':
        options.answer = JSON.parse(String(argv[++i]))
        break
      case '--timeout':
        options.timeout = Number(argv[++i])
        break
      case '--since':
        options.since = Number(argv[++i])
        break
      case '--report':
        options.report = argv[++i]
        break
      case '--stream-deltas':
        options.streamDeltas = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
        positional.push(arg)
    }
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1)) {
    throw new Error('--port must be a positive integer')
  }
  if (options.since !== undefined && (!Number.isInteger(options.since) || options.since < 0)) {
    throw new Error('--since must be a non-negative integer')
  }
  if (options.timeout !== undefined && (!Number.isInteger(options.timeout) || options.timeout < 1)) {
    throw new Error('--timeout must be a positive integer')
  }
  return { command: positional[0] ?? (options.help ? 'help' : 'run'), options }
}

/**
 * Resolve connection settings from the DSH home and the channel config file.
 * @param {Record<string, unknown>} options
 */
function resolveConnection(options) {
  const home = String(options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
  let fileConfig = {}
  try {
    fileConfig = JSON.parse(fs.readFileSync(path.join(home, 'kimi-channel.json'), 'utf8'))
  } catch {
    /* config file is optional */
  }
  const port = Number(options.port ?? fileConfig.port ?? DEFAULT_PORT)
  const host = String(fileConfig.host ?? '127.0.0.1')
  const tokenFile = path.resolve(
    String(fileConfig.tokenFile ?? path.join(home, 'kimi-channel.token')).replace(/^~(?=\/|$)/, os.homedir()),
  )
  let token
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim()
  } catch (error) {
    throw new Error(`cannot read channel token at ${tokenFile}: ${error.message}. Is the dsh-kimi-channel plugin running?`)
  }
  if (!token) throw new Error(`channel token file ${tokenFile} is empty`)
  return { host, port, token, tokenFile, home }
}

/** @param {{host: string, port: number, token: string}} connection */
function channelUrl(connection) {
  const host = connection.host === '::1' ? '[::1]' : connection.host
  return `ws://${host}:${connection.port}/?token=${encodeURIComponent(connection.token)}`
}

/** Request/notification transport over one WebSocket. */
class ChannelClient {
  /**
   * @param {{host: string, port: number, token: string}} connection
   * @param {{onEvent: (frame: object) => void}} handlers
   */
  constructor(connection, handlers) {
    this.connection = connection
    this.handlers = handlers
    this.socket = undefined
    this.pending = new Map()
    this.lastSeq = 0
    this.ready = undefined
  }

  /** @returns {Promise<object>} resolves after the server's ready frame */
  async connect() {
    const ready = new Promise((resolve, reject) => {
      this.ready = { resolve, reject }
    })
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(channelUrl(this.connection))
      this.socket = socket
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('channel connection error; is the token fresh and the port correct?')))
      socket.addEventListener('message', (event) => this.#onMessage(event))
      socket.addEventListener('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('channel connection closed'))
        }
        this.pending.clear()
      })
    })
    return ready
  }

  /** @param {object} event */
  #onMessage(event) {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (frame.t === 'res') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.result)
      else {
        pending.reject(
          Object.assign(new Error(frame.error?.message ?? 'request failed'), {
            code: frame.error?.code,
            details: frame.error?.details,
          }),
        )
      }
      return
    }
    if (frame.t === 'evt') {
      if (typeof frame.seq === 'number' && frame.seq > this.lastSeq) this.lastSeq = frame.seq
      if (frame.event === 'ready') this.ready?.resolve(frame.data)
      this.handlers.onEvent(frame)
    }
  }

  /**
   * @param {string} method
   * @param {object} params
   * @param {string} [id]
   * @returns {Promise<any>}
   */
  request(method, params = {}, id) {
    const requestId = id ?? `${method}-${crypto.randomUUID()}`
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'req', id: requestId, method, params }))
    })
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      /* ignore */
    }
  }
}

/** @param {string} message */
function progress(options, message) {
  if (!options.quiet) process.stderr.write(`${message}\n`)
}

/**
 * Build the event consumer shared by `run` and `watch`.
 * @param {ChannelClient} client
 * @param {Record<string, unknown>} options
 */
function createTurnStream(client, options) {
  const policy = approvalPolicy(options)
  const state = {
    lastSeq: 0,
    sessionId: undefined,
    finalPayload: undefined,
    failure: undefined,
    interactions: 0,
  }
  const emitJson = (frame) => {
    if (options.json) process.stdout.write(`${JSON.stringify(frame)}\n`)
  }
  /** @param {object} frame */
  const handle = async (frame) => {
    state.lastSeq = frame.seq
    emitJson(frame)
    const data = frame.data ?? {}
    switch (frame.event) {
      case 'session':
        state.sessionId = data.sessionId
        progress(options, `[session] ${data.sessionId} cwd=${data.cwd}${data.fresh ? ' (new)' : ''}`)
        break
      case 'turn_start':
        progress(options, `[turn ${data.turn}] started`)
        break
      case 'thinking':
        progress(options, `[thinking] ${truncate(data.text, 300)}`)
        break
      case 'text':
        progress(options, `[assistant] ${truncate(data.text, 400)}`)
        break
      case 'text_delta':
        process.stderr.write(data.text)
        break
      case 'tool_call':
        progress(options, `[tool] ${data.name} ${truncate(JSON.stringify(data.arguments), 300)}`)
        break
      case 'tool_result':
        progress(options, `[tool_result] ${data.ok ? 'ok' : 'error'} ${truncate(data.text, 300)}`)
        break
      case 'interaction':
        state.interactions += 1
        await respondToInteraction(client, frame, policy, options)
        break
      case 'error':
        progress(options, `[error] ${data.code}: ${data.message}`)
        break
      case 'turn_end':
        progress(options, `[turn ${data.turn}] ended: ${reasonText(data.reason)}`)
        break
      case 'final':
        state.finalPayload = data
        break
      default:
        break
    }
  }
  return { state, handle }
}

/**
 * Wait for the current turn to settle, print the final answer, and report.
 * @param {ChannelClient} client
 * @param {string} conversationKey
 * @param {ReturnType<typeof createTurnStream>} stream
 * @param {Record<string, unknown>} options
 * @param {string} [sessionId]
 */
async function awaitTurn(client, conversationKey, stream, options, sessionId) {
  const state = stream.state
  if (state.sessionId === undefined) state.sessionId = sessionId
  const timeoutMs = Number(options.timeout ?? 600_000)
  const timer = setTimeout(() => {
    void client.request('prompt.abort', { conversationKey, reason: 'client timeout' }).catch(() => {})
    state.failure = state.failure ?? new Error(`turn timed out after ${timeoutMs}ms`)
  }, timeoutMs)
  timer.unref?.()
  const completed = await waitFor(timeoutMs + 5_000, () => state.finalPayload !== undefined || state.failure !== undefined)
  clearTimeout(timer)
  if (!completed) throw new Error('timed out waiting for the turn to finish')
  if (state.failure) throw state.failure
  const finalPayload = state.finalPayload
  if (!finalPayload) throw new Error('the turn ended without a final payload')

  if (!options.json) {
    const finalText = finalPayload.text && finalPayload.text.length > 0 ? finalPayload.text : '(no assistant text)'
    process.stdout.write(`${finalText}\n`)
  } else {
    process.stdout.write(`${JSON.stringify({ type: 'final', sessionId: state.sessionId, conversationKey, ...finalPayload })}\n`)
  }
  if (typeof options.report === 'string' && options.report.length > 0) {
    const target = path.resolve(String(options.report))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify({ sessionId: state.sessionId, conversationKey, ...finalPayload }, null, 2)}\n`)
    progress(options, `[report] ${target}`)
  }
  progress(
    options,
    `[done] turn=${finalPayload.turn} reason=${reasonText(finalPayload.reason)} events=${finalPayload.eventCount} interactions=${state.interactions} session=${state.sessionId}`,
  )
  return failedReason(finalPayload.reason) ? 1 : 0
}

/** @param {unknown} reason */
function failedReason(reason) {
  return reason === 'error' || (reason && typeof reason === 'object' && reason.kind === 'error')
}

/**
 * Decide one forwarded interaction according to the CLI policy.
 * @param {ChannelClient} client
 * @param {object} frame
 * @param {{allow: string[], denyAll: boolean}} policy
 * @param {Record<string, unknown>} options
 */
async function respondToInteraction(client, frame, policy, options) {
  const data = frame.data ?? {}
  if (data.auto) {
    progress(options, `[approval] auto-allowed ${data.toolName}`)
    return
  }
  if (data.kind === 'approval') {
    const allowed = policy.allow.includes(data.toolName) || policy.allow.includes('*')
    const decision = allowed && !policy.denyAll ? 'allow' : 'deny'
    progress(
      options,
      `[approval] ${data.toolName}${data.callId ? ` (${data.callId})` : ''} -> ${decision}${allowed ? '' : ` (pass --allow ${data.toolName} to grant)`}`,
    )
    await client.request('interaction.respond', { interactionId: data.id, decision })
    return
  }
  if (data.kind === 'question') {
    const answer = answerFor(data.questions, options.answer)
    if (answer) {
      progress(options, `[question] answered ${JSON.stringify(answer)}`)
      await client.request('interaction.respond', { interactionId: data.id, decision: 'answer', answer: { answers: answer } })
    } else {
      progress(options, '[question] no --answer supplied; delegating to the DSH UI')
      await client.request('interaction.respond', { interactionId: data.id, decision: 'deny' })
    }
  }
}

/**
 * @param {Array<{id: string, question: string}> | undefined} questions
 * @param {Record<string, string[]> | undefined} answers
 */
function answerFor(questions, answers) {
  if (!Array.isArray(questions) || !answers) return undefined
  const out = []
  for (const question of questions) {
    const selected = answers[question.id]
    if (!Array.isArray(selected) || selected.length === 0) return undefined
    out.push({ id: question.id, selected })
  }
  return out.length > 0 ? out : undefined
}

/** @param {Record<string, unknown>} options */
function approvalPolicy(options) {
  const allow = Array.isArray(options.allow) ? options.allow.map(String) : []
  return { allow, denyAll: options.denyAll === true }
}

/**
 * Poll until `predicate` returns true or the deadline passes.
 * @param {number} timeoutMs
 * @param {() => boolean} predicate
 */
function waitFor(timeoutMs, predicate) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** @param {unknown} text @param {number} limit */
function truncate(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

/** @param {unknown} reason */
function reasonText(reason) {
  if (reason === undefined || reason === null) return 'unknown'
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return JSON.stringify(reason)
}

/** @param {string} value */
function shortHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8)
}

/** @param {Record<string, unknown>} options */
function conversationKeyOf(options, { required = false } = {}) {
  if (typeof options.conversation === 'string' && options.conversation.length > 0) return options.conversation
  if (required) throw new Error('--conversation is required for this command')
  const cwd = path.resolve(String(options.cwd ?? process.cwd()))
  return `kc-${path.basename(cwd)}-${shortHash(cwd)}`
}

// ------------------------------------------------------------------ commands

/** @param {Record<string, unknown>} options @returns {Promise<number>} */
async function commandRun(options) {
  if (typeof options.task !== 'string' || options.task.trim().length === 0) throw new Error('--task is required')
  const cwd = path.resolve(String(options.cwd ?? process.cwd()))
  const conversationKey = conversationKeyOf(options)
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  const stream = createTurnStream(client, options)
  client.handlers.onEvent = (frame) => void stream.handle(frame)
  await client.connect()
  try {
    const ensured = await client.request('session.ensure', {
      conversationKey,
      cwd,
      streamDeltas: options.streamDeltas === true,
    })
    progress(options, `[session] ${ensured.sessionId} cwd=${ensured.cwd}`)
    await client.request(
      'prompt.submit',
      { conversationKey, text: String(options.task) },
      `submit-${crypto.randomUUID()}`,
    )
    return await awaitTurn(client, conversationKey, stream, options, ensured.sessionId)
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandSubmit(options) {
  if (typeof options.task !== 'string' || options.task.trim().length === 0) throw new Error('--task is required')
  const cwd = path.resolve(String(options.cwd ?? process.cwd()))
  const conversationKey = conversationKeyOf(options)
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  await client.connect()
  try {
    const ensured = await client.request('session.ensure', {
      conversationKey,
      cwd,
      streamDeltas: options.streamDeltas === true,
    })
    const submitted = await client.request(
      'prompt.submit',
      { conversationKey, text: String(options.task) },
      `submit-${crypto.randomUUID()}`,
    )
    const result = {
      command: 'submitted',
      conversationKey,
      sessionId: ensured.sessionId,
      cwd: ensured.cwd,
      messageId: submitted?.messageId,
      lastSeq: client.lastSeq,
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    progress(options, `[submitted] conversation=${conversationKey} session=${ensured.sessionId} message=${submitted?.messageId}`)
    return 0
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandWatch(options) {
  const conversationKey = conversationKeyOf(options, { required: true })
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  const stream = createTurnStream(client, options)
  client.handlers.onEvent = (frame) => void stream.handle(frame)
  await client.connect()
  try {
    if (Number.isInteger(options.since)) {
      const resumed = await client.request('events.resume', { since: Number(options.since), conversationKey })
      progress(options, `[resume] ${resumed.events.length} event(s) after seq ${options.since}; lastSeq=${resumed.lastSeq}`)
    }
    const snapshot = await client.request('state.snapshot', { conversationKey })
    if (snapshot?.conversation) {
      progress(
        options,
        `[session] ${snapshot.conversation.sessionId} status=${snapshot.conversation.status} turn=${snapshot.conversation.turn}`,
      )
    } else {
      progress(options, `[session] no live session for conversation ${conversationKey}`)
    }
    return await awaitTurn(client, conversationKey, stream, options, snapshot?.conversation?.sessionId)
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandSteer(options) {
  const conversationKey = conversationKeyOf(options, { required: true })
  if (typeof options.text !== 'string' || options.text.trim().length === 0) throw new Error('--text is required')
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  await client.connect()
  try {
    const result = await client.request('prompt.steer', { conversationKey, text: String(options.text) })
    process.stdout.write(`${JSON.stringify({ command: 'steer', conversationKey, ...result })}\n`)
    progress(options, `[steer] queued for ${conversationKey}`)
    return 0
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandAbort(options) {
  const conversationKey = conversationKeyOf(options, { required: true })
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  await client.connect()
  try {
    const result = await client.request('prompt.abort', {
      conversationKey,
      reason: typeof options.reason === 'string' ? options.reason : 'manager abort',
    })
    process.stdout.write(`${JSON.stringify({ command: 'abort', conversationKey, ...result })}\n`)
    progress(options, `[abort] ${conversationKey}`)
    return 0
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandReport(options) {
  const conversationKey = conversationKeyOf(options, { required: true })
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  await client.connect()
  try {
    const snapshot = await client.request('state.snapshot', { conversationKey })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
      return 0
    }
    const final = snapshot.lastFinal
    if (!final) {
      process.stdout.write('no final payload for this conversation yet\n')
    } else {
      process.stdout.write(`${final.text && final.text.length > 0 ? final.text : '(no assistant text)'}\n`)
      process.stderr.write(
        `\n[final] turn=${final.turn} reason=${reasonText(final.reason)} events=${final.eventCount}\n`,
      )
      for (const entry of final.trajectory ?? []) {
        if (entry.type === 'tool_call') {
          process.stderr.write(`[call] ${entry.name} ${JSON.stringify(entry.arguments)}\n`)
        } else if (entry.type === 'tool_result') {
          process.stderr.write(`[result] ${entry.ok ? 'ok' : 'error'} ${String(entry.text).replace(/\s+/g, ' ').slice(0, 300)}\n`)
        }
      }
    }
    if (Array.isArray(snapshot.pendingInteractions) && snapshot.pendingInteractions.length > 0) {
      process.stderr.write(`[pending] ${snapshot.pendingInteractions.length} interaction(s) waiting\n`)
    }
    return 0
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandStatus(options) {
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  await client.connect()
  try {
    const health = await client.request('health')
    const snapshot = await client.request('state.snapshot', {})
    process.stdout.write(`${JSON.stringify({ health, snapshot }, null, 2)}\n`)
    return 0
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandResume(options) {
  const client = new ChannelClient(resolveConnection(options), {
    onEvent: (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
  })
  await client.connect()
  try {
    const since = Number.isInteger(options.since) ? Number(options.since) : 0
    const result = await client.request('events.resume', { since })
    process.stderr.write(`[resume] ${result.events.length} event(s) after seq ${since}; lastSeq=${result.lastSeq}\n`)
    return 0
  } finally {
    client.close()
  }
}

/** @param {Record<string, unknown>} options */
async function commandHealth(options) {
  const client = new ChannelClient(resolveConnection(options), { onEvent: () => {} })
  await client.connect()
  try {
    const health = await client.request('health')
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`)
    return health.ok === true ? 0 : 1
  } finally {
    client.close()
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (options.help || command === 'help') {
    process.stdout.write(usage())
    return 0
  }
  switch (command) {
    case 'run':
      return commandRun(options)
    case 'submit':
      return commandSubmit(options)
    case 'watch':
      return commandWatch(options)
    case 'steer':
      return commandSteer(options)
    case 'abort':
      return commandAbort(options)
    case 'report':
      return commandReport(options)
    case 'status':
      return commandStatus(options)
    case 'resume':
      return commandResume(options)
    case 'health':
      return commandHealth(options)
    default:
      throw new Error(`unknown command ${command}`)
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`kimi-dsh: ${error?.message ?? error}\n`)
    process.exitCode = 1
  })
