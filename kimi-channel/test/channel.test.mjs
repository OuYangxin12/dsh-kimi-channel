/**
 * Integration test for the channel runtime against a fake Cordis host.
 *
 * Covers M1 (loopback WebSocket + token auth + protocol), M2 (session bridge,
 * event projection, idempotency, replay) and M3 (approval/question bridging)
 * without booting a real DSH profile.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { startChannel } from '../lib/channel.mjs'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-channel-it-'))

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Minimal Cordis-shaped context that records listeners and fakes the agent services. */
function fakeHost() {
  const listeners = new Map()
  const live = new Map()
  const prompts = []
  const steers = []
  const cancels = []
  const presets = {
    resolve: async (id) => ({ id: id ?? 'standard' }),
    mount: async () => {},
  }
  const agent = (sessionId) => ({
    id: sessionId,
    status: 'idle',
    followup: (message) => prompts.push(message),
    steer: (message) => steers.push(message),
    cancel: (cause) => cancels.push(cause),
  })
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, handler) {
      const bucket = listeners.get(name) ?? []
      bucket.push(handler)
      listeners.set(name, bucket)
      return () => {
        const index = bucket.indexOf(handler)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    effect(setup) {
      return setup()
    },
    get(name) {
      if (name === 'agentPresets') return presets
      return undefined
    },
    agents: {
      get: (id) => live.get(id),
      create: async ({ sessionId, meta, setup }) => {
        assert.ok(meta?.cwd)
        const created = agent(sessionId)
        if (setup) await setup({}, created)
        live.set(sessionId, created)
        return {
          agent: created,
          dispose: async () => {
            live.delete(sessionId)
          },
        }
      },
      resume: async () => {
        throw new Error('not persisted')
      },
    },
  }
  return {
    ctx,
    prompts,
    steers,
    cancels,
    live,
    /** Invoke every listener registered for one event. */
    async fire(name, ...args) {
      const bucket = listeners.get(name) ?? []
      const results = []
      for (const handler of bucket) results.push(await handler(...args))
      return results
    },
  }
}

/** Buffered WebSocket client used as the test peer. */
class TestClient {
  constructor(url) {
    this.frames = []
    this.waiters = []
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      this.frames.push(frame)
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(frame)
        }
      }
    })
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('websocket error')))
    })
  }

  /** @param {(frame: object) => boolean} predicate */
  next(predicate, timeoutMs = 3000) {
    const existing = this.frames.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve }
      this.waiters.push(waiter)
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
          reject(new Error('timed out waiting for a frame'))
        }
      }, timeoutMs)
    })
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame))
  }

  request(id, method, params = {}) {
    this.send({ v: 1, t: 'req', id, method, params })
    return this.next((frame) => frame.t === 'res' && frame.id === id)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
  }
}

/** Boot a channel with a temporary home and return a connected client. */
async function boot() {
  const dir = tempDir()
  const port = await freePort()
  const host = fakeHost()
  const channel = startChannel(host.ctx, {
    port,
    tokenFile: path.join(dir, 'token'),
    sessionMapFile: path.join(dir, 'sessions.json'),
    allowCwdRoots: [dir],
    defaultCwd: dir,
    autoAllowTools: ['read'],
    interactionTimeoutMs: 400,
    agentPreset: 'standard',
  })
  assert.ok(channel, 'channel should start')
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()
  const client = new TestClient(`ws://127.0.0.1:${port}/?token=${token}`)
  await client.opened
  await client.next((frame) => frame.event === 'ready')
  return { dir, port, token, host, channel, client }
}

/** Emit one session event through the fake host. */
async function sessionEvent(host, sessionId, event) {
  await host.fire('session/event', { id: sessionId }, event)
}

test('rejects a connection with a wrong token', async () => {
  const dir = tempDir()
  const port = await freePort()
  const host = fakeHost()
  const channel = startChannel(host.ctx, {
    port,
    tokenFile: path.join(dir, 'token'),
    sessionMapFile: path.join(dir, 'sessions.json'),
    allowCwdRoots: [dir],
    defaultCwd: dir,
  })
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=nope`)
    const outcome = await new Promise((resolve) => {
      socket.addEventListener('open', () => resolve('open'))
      socket.addEventListener('error', () => resolve('error'))
    })
    assert.equal(outcome, 'error')
    socket.close()
  } finally {
    await channel.dispose()
  }
})

test('session.ensure creates an agent, submit is idempotent, events project, resume replays', async () => {
  const { dir, host, client, channel } = await boot()
  const cwd = path.join(dir, 'work')
  fs.mkdirSync(cwd, { recursive: true })
  try {
    const ensured = await client.request('ensure-1', 'session.ensure', { conversationKey: 'conv', cwd })
    assert.equal(ensured.t, 'res')
    assert.equal(ensured.ok, true)
    const sessionId = ensured.result.sessionId
    assert.match(sessionId, /^kimi-/)
    assert.equal(ensured.result.cwd, cwd)
    assert.equal(ensured.result.fresh, true)

    // A second ensure reuses the live agent instead of creating another.
    const again = await client.request('ensure-2', 'session.ensure', { conversationKey: 'conv' })
    assert.equal(again.result.sessionId, sessionId)
    assert.equal(again.result.fresh, false)

    const submitted = await client.request('submit-1', 'prompt.submit', { conversationKey: 'conv', text: 'hello' })
    assert.equal(submitted.result.accepted, true)
    assert.equal(host.prompts.length, 1)
    assert.equal(host.prompts[0].content[0].text, 'hello')
    assert.equal(host.prompts[0].source.kind, 'user')

    // The same request id must not enqueue a second user message.
    const duplicate = await client.request('submit-1', 'prompt.submit', { conversationKey: 'conv', text: 'hello' })
    assert.equal(duplicate.result.messageId, submitted.result.messageId)
    assert.equal(host.prompts.length, 1)

    // Steer and abort reach the agent.
    await client.request('steer-1', 'prompt.steer', { conversationKey: 'conv', text: 'also this' })
    assert.equal(host.steers.length, 1)
    await client.request('abort-1', 'prompt.abort', { conversationKey: 'conv', reason: 'test' })
    assert.deepEqual(host.cancels, [{ kind: 'user' }])

    // Project one full turn.
    await sessionEvent(host, sessionId, { type: 'turn/start', data: { turn: 1 } })
    await sessionEvent(host, sessionId, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'why' }] } },
    })
    await sessionEvent(host, sessionId, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"x"}' } })
    await sessionEvent(host, sessionId, {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'body' }] } },
    })
    await sessionEvent(host, sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    const text = await client.next((frame) => frame.event === 'text')
    assert.equal(text.data.text, 'answer')
    const thinking = await client.next((frame) => frame.event === 'thinking')
    assert.equal(thinking.data.text, 'why')
    const toolCall = await client.next((frame) => frame.event === 'tool_call')
    assert.equal(toolCall.data.name, 'read')
    assert.deepEqual(toolCall.data.arguments, { file_path: 'x' })
    const toolResult = await client.next((frame) => frame.event === 'tool_result')
    assert.equal(toolResult.data.ok, true)
    assert.equal(toolResult.data.text, 'body')
    const final = await client.next((frame) => frame.event === 'final')
    assert.equal(final.data.turn, 1)
    assert.equal(final.data.text, 'answer')
    assert.equal(final.data.trajectory.length, 3)
    assert.equal(final.data.eventCount, 3)
    assert.deepEqual(
      final.data.trajectory.map((entry) => entry.type),
      ['assistant', 'tool_call', 'tool_result'],
    )

    // Event seq is monotonic across the connection.
    const seqs = client.frames.filter((frame) => frame.t === 'evt' && frame.event !== 'ready').map((frame) => frame.seq)
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} must exceed ${seqs[i - 1]}`)

    // Replay after a chosen seq is contiguous and filtered by conversation.
    const resumed = await client.request('resume-1', 'events.resume', { since: 0, conversationKey: 'conv' })
    const replayed = resumed.result.events
    assert.ok(replayed.length > 0)
    for (let i = 1; i < replayed.length; i += 1) assert.equal(replayed[i].seq, replayed[i - 1].seq + 1)
    const partial = await client.request('resume-2', 'events.resume', { since: replayed[1].seq, conversationKey: 'conv' })
    assert.ok(partial.result.events.every((frame) => frame.seq > replayed[1].seq))

    // Snapshot exposes the conversation and the replay cursor.
    const snapshot = await client.request('snap-1', 'state.snapshot', { conversationKey: 'conv' })
    assert.equal(snapshot.result.conversation.sessionId, sessionId)
    assert.equal(snapshot.result.lastSeq, resumed.result.lastSeq)
    assert.equal(snapshot.result.lastFinal.turn, 1)
    assert.equal(snapshot.result.lastFinal.text, 'answer')
    assert.equal(snapshot.result.lastFinal.trajectory.length, 3)
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('assistant stream deltas reach a client that asked for them', async () => {
  const { dir, host, client, channel } = await boot()
  try {
    const ensured = await client.request('e-stream', 'session.ensure', { conversationKey: 'stream', cwd: dir, streamDeltas: true })
    const agent = host.live.get(ensured.result.sessionId)
    await host.fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hel' } },
    })
    const delta = await client.next((frame) => frame.event === 'text_delta')
    assert.equal(delta.data.text, 'hel')
    assert.equal(delta.data.turn, 1)
    await host.fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'why' } },
    })
    const thinking = await client.next((frame) => frame.event === 'thinking_delta')
    assert.equal(thinking.data.text, 'why')
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('unknown methods and bad frames keep the connection alive', async () => {
  const { client, channel } = await boot()
  try {
    client.send({ v: 1, t: 'req', id: 'bad-1', method: 'nope' })
    const badMethod = await client.next((frame) => frame.t === 'res' && frame.id === 'bad-1')
    assert.equal(badMethod.error.code, 'UNKNOWN_METHOD')

    client.send({ v: 99, t: 'req', id: 'bad-2', method: 'health' })
    const badVersion = await client.next((frame) => frame.t === 'res' && frame.id === 'bad-2')
    assert.equal(badVersion.error.code, 'BAD_VERSION')

    client.send({ id: 'no-version', method: 'health' })
    const missing = await client.next((frame) => frame.t === 'res' && frame.id === 'no-version')
    assert.equal(missing.error.code, 'BAD_VERSION')

    // Still usable after every rejected frame.
    const healthy = await client.request('ok-1', 'health')
    assert.equal(healthy.result.ok, true)
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('approval whitelist grants read-only tools and forwards writes', async () => {
  const { dir, host, client, channel } = await boot()
  try {
    const ensured = await client.request('e-1', 'session.ensure', { conversationKey: 'c', cwd: dir })
    const sessionId = ensured.result.sessionId
    const agent = host.live.get(sessionId)

    const allowRead = await host.fire('approval/request', { agent, toolName: 'read', callId: 'r1' }, async () => 'unavailable')
    assert.deepEqual(allowRead, ['allowed-once'])
    const auto = await client.next((frame) => frame.event === 'interaction' && frame.data.auto === true)
    assert.equal(auto.data.toolName, 'read')

    // A write waits for the client decision.
    let nextCalled = false
    const outcomePromise = host.fire(
      'approval/request',
      { agent, toolName: 'write', callId: 'w1', reason: 'needs approval' },
      async () => {
        nextCalled = true
        return 'unavailable'
      },
    )
    const interaction = await client.next((frame) => frame.event === 'interaction' && frame.data.auto === false)
    assert.equal(interaction.data.toolName, 'write')
    assert.equal(interaction.data.reason, 'needs approval')
    await client.request('respond-1', 'interaction.respond', { interactionId: interaction.data.id, decision: 'deny' })
    const [outcome] = await outcomePromise
    assert.equal(outcome, 'rejected')
    assert.equal(nextCalled, false)

    // Denying an unknown interaction id is a protocol error, not a crash.
    const missing = await client.request('respond-2', 'interaction.respond', { interactionId: 'nope', decision: 'allow' })
    assert.equal(missing.error.code, 'NOT_FOUND')
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('approval for a foreign agent delegates to the next answerer', async () => {
  const { client, channel, host } = await boot()
  try {
    let nextCalled = false
    const results = await host.fire(
      'approval/request',
      { agent: { id: 'someone-else' }, toolName: 'write' },
      async () => {
        nextCalled = true
        return 'unavailable'
      },
    )
    assert.equal(nextCalled, true)
    assert.deepEqual(results, ['unavailable'])
    assert.equal(client.frames.some((frame) => frame.event === 'interaction'), false)
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('questions forward to the client and answer batches flow back', async () => {
  const { dir, host, client, channel } = await boot()
  try {
    const ensured = await client.request('e-2', 'session.ensure', { conversationKey: 'q', cwd: dir })
    const agent = host.live.get(ensured.result.sessionId)
    const pending = host.fire(
      'user-questions/request',
      { agent, questions: [{ id: 'pick', question: 'Which one?' }], wait: { callId: 'ask-1' } },
      async () => 'fallback',
    )
    const interaction = await client.next((frame) => frame.event === 'interaction' && frame.data.kind === 'question')
    assert.equal(interaction.data.callId, 'ask-1')
    await client.request('respond-q', 'interaction.respond', {
      interactionId: interaction.data.id,
      decision: 'answer',
      answer: { answers: [{ id: 'pick', selected: ['A'] }] },
    })
    const [answer] = await pending
    assert.deepEqual(answer, { answers: [{ id: 'pick', selected: ['A'] }] })
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('interaction timeout fails closed', async () => {
  const { dir, host, client, channel } = await boot()
  try {
    const ensured = await client.request('e-3', 'session.ensure', { conversationKey: 't', cwd: dir })
    const agent = host.live.get(ensured.result.sessionId)
    const [outcome] = await host.fire('approval/request', { agent, toolName: 'bash' }, async () => 'unavailable')
    assert.equal(outcome, 'rejected')
    const resolved = await client.next((frame) => frame.event === 'interaction_resolved' && frame.data.outcome === 'timeout')
    assert.ok(resolved)
  } finally {
    client.close()
    await channel.dispose()
  }
})

test('cwd outside allowCwdRoots is rejected', async () => {
  const { client, channel } = await boot()
  try {
    const rejected = await client.request('cwd-1', 'session.ensure', { conversationKey: 'x', cwd: '/etc' })
    assert.equal(rejected.error.code, 'CWD_NOT_ALLOWED')
  } finally {
    client.close()
    await channel.dispose()
  }
})
