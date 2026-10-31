import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DELEGATE, InteractionBroker, isAutoAllowed, normalizeAnswers } from '../lib/interactions.mjs'

function makeBroker(options = {}) {
  const events = []
  const broker = new InteractionBroker({
    emit: (event, data) => events.push({ event, data }),
    timeoutMs: options.timeoutMs ?? 2000,
    autoAllowTools: options.autoAllowTools ?? ['read', 'glob'],
  })
  return { broker, events }
}

test('isAutoAllowed matches exact names and prefix wildcards', () => {
  assert.equal(isAutoAllowed('read', ['read']), true)
  assert.equal(isAutoAllowed('write', ['read']), false)
  assert.equal(isAutoAllowed('tools.read', ['tools.*']), true)
  assert.equal(isAutoAllowed('', ['read']), false)
})

test('whitelisted read-only tools are granted and the grant is announced', async () => {
  const { broker, events } = makeBroker()
  const outcome = await broker.handleApproval('conv', { toolName: 'read', callId: 'c1' })
  assert.equal(outcome, 'allowed-once')
  assert.equal(events[0].event, 'interaction')
  assert.equal(events[0].data.auto, true)
  assert.equal(events[1].event, 'interaction_resolved')
  assert.equal(events[1].data.outcome, 'allowed-once')
})

test('a write tool waits for a client decision and forwards allow', async () => {
  const { broker, events } = makeBroker()
  const pending = broker.handleApproval('conv', { toolName: 'write', callId: 'c2' })
  const interaction = events.find((item) => item.event === 'interaction').data
  assert.equal(interaction.auto, false)
  assert.equal(interaction.toolName, 'write')
  assert.equal(broker.list('conv').length, 1)
  broker.respond(interaction.id, { decision: 'allow' })
  assert.equal(await pending, 'allowed-once')
  assert.equal(broker.list('conv').length, 0)
})

test('deny and cancel map to rejected and cancelled', async () => {
  const { broker, events } = makeBroker()
  const first = broker.handleApproval('conv', { toolName: 'bash' })
  broker.respond(events.find((item) => item.event === 'interaction').data.id, { decision: 'deny' })
  assert.equal(await first, 'rejected')

  const second = broker.handleApproval('conv', { toolName: 'bash' })
  broker.respond(events.filter((item) => item.event === 'interaction').at(-1).data.id, { decision: 'cancel' })
  assert.equal(await second, 'cancelled')
})

test('a timeout fails closed with rejected', async () => {
  const { broker } = makeBroker({ timeoutMs: 30 })
  const outcome = await broker.handleApproval('conv', { toolName: 'write' })
  assert.equal(outcome, 'rejected')
  assert.equal(broker.list().length, 0)
})

test('an aborted request settles as cancelled', async () => {
  const { broker } = makeBroker()
  const controller = new AbortController()
  const pending = broker.handleApproval('conv', { toolName: 'write', signal: controller.signal })
  controller.abort()
  assert.equal(await pending, 'cancelled')
})

test('unknown interaction ids and bad decisions are rejected', () => {
  const { broker } = makeBroker()
  assert.throws(() => broker.respond('missing', { decision: 'allow' }), (error) => error.code === 'NOT_FOUND')
  const pending = broker.handleApproval('conv', { toolName: 'write' })
  const id = broker.list()[0].id
  assert.throws(() => broker.respond(id, { decision: 'maybe' }), (error) => error.code === 'BAD_PARAMS')
  broker.respond(id, { decision: 'deny' })
  return pending
})

test('questions forward the question payload and accept an answer batch', async () => {
  const { broker, events } = makeBroker()
  const pending = broker.handleQuestion('conv', {
    questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }],
    wait: { callId: 'call-9' },
  })
  const interaction = events.find((item) => item.event === 'interaction').data
  assert.equal(interaction.kind, 'question')
  assert.equal(interaction.callId, 'call-9')
  assert.equal(interaction.questions[0].id, 'q1')
  broker.respond(interaction.id, { decision: 'answer', answer: { answers: [{ id: 'q1', selected: ['A'] }] } })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['A'] }] })
})

test('question timeout and deny delegate to the next answerer', async () => {
  const { broker } = makeBroker({ timeoutMs: 20 })
  assert.equal(await broker.handleQuestion('conv', { questions: [] }), DELEGATE)

  const { broker: second, events } = makeBroker()
  const pending = second.handleQuestion('conv', { questions: [] })
  second.respond(events.find((item) => item.event === 'interaction').data.id, { decision: 'deny' })
  assert.equal(await pending, DELEGATE)
})

test('normalizeAnswers tolerates both payload shapes and drops junk', () => {
  assert.deepEqual(normalizeAnswers({ answers: [{ id: 'a', selected: ['x'] }] }), [{ id: 'a', selected: ['x'] }])
  assert.deepEqual(normalizeAnswers([{ id: 'b', selected: [], custom: 'typed' }]), [{ id: 'b', selected: [], custom: 'typed' }])
  assert.deepEqual(normalizeAnswers({ answers: [{ selected: ['x'] }, null, { id: '', selected: [] }] }), [])
  assert.deepEqual(normalizeAnswers(undefined), [])
})

test('dispose cancels every pending interaction', async () => {
  const { broker } = makeBroker({ timeoutMs: 10_000 })
  const pending = broker.handleApproval('conv', { toolName: 'bash' })
  broker.dispose()
  assert.equal(await pending, 'cancelled')
  assert.equal(broker.list().length, 0)
})
