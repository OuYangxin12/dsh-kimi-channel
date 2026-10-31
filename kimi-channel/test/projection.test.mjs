import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TurnRecorder, buildFinal, flattenContent, parseArguments, projectSessionEvent } from '../lib/projection.mjs'

test('projects a full turn into text, tool, and final events', () => {
  const recorder = new TurnRecorder()
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'let me look' }, { type: 'text', text: 'Reading files.' }] },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' } },
    {
      seq: 4,
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'contents' }], toolCallId: 'c1' } },
    },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: 'stop' } },
  ]
  const projected = events.flatMap((event) => projectSessionEvent(event, recorder))
  assert.deepEqual(
    projected.map((item) => item.event),
    ['turn_start', 'thinking', 'text', 'status', 'tool_call', 'tool_result', 'turn_end', 'final'],
  )
  assert.equal(projected[1].data.text, 'let me look')
  assert.equal(projected[2].data.text, 'Reading files.')
  assert.deepEqual(projected[4].data.arguments, { path: 'a.txt' })
  assert.equal(projected[5].data.ok, true)
  assert.equal(projected[5].data.text, 'contents')
  const final = projected[7].data
  assert.equal(final.turn, 1)
  assert.equal(final.reason, 'stop')
  assert.equal(final.text, 'Reading files.')
  assert.equal(final.trajectory.length, 3)
  assert.deepEqual(final.usage, { inputTokens: 10, outputTokens: 5 })
  assert.equal(final.eventCount, 3)
})

test('a second turn starts from a clean recorder', () => {
  const recorder = new TurnRecorder()
  projectSessionEvent({ type: 'turn/start', data: { turn: 1 } }, recorder)
  projectSessionEvent(
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'one' }] } } },
    recorder,
  )
  projectSessionEvent({ type: 'turn/end', data: { turn: 1, reason: 'stop' } }, recorder)
  const second = projectSessionEvent({ type: 'turn/start', data: { turn: 2 } }, recorder)
  assert.deepEqual(second, [{ event: 'turn_start', data: { turn: 2 } }])
  assert.equal(recorder.trajectory.length, 0)
  assert.equal(recorder.texts.length, 0)
})

test('tool failures are projected with ok=false and the error detail', () => {
  const recorder = new TurnRecorder()
  recorder.start(1)
  projectSessionEvent(
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', content: [{ type: 'text', text: 'boom' }], toolCallId: 'c9', isError: true },
        error: { name: 'ToolError', code: 'E_TOOL', reason: 'no access' },
      },
    },
    recorder,
  )
  const final = buildFinal(recorder, { turn: 1, reason: 'error' })
  assert.equal(final.trajectory[0].ok, false)
  assert.equal(final.trajectory[0].text, 'boom')
  assert.deepEqual(final.trajectory[0].error, { name: 'ToolError', code: 'E_TOOL', reason: 'no access' })
})

test('interrupted assistant output is surfaced as an error event', () => {
  const recorder = new TurnRecorder()
  const projected = projectSessionEvent(
    {
      type: 'assistant/message',
      data: {
        turn: 3,
        step: 2,
        interrupted: true,
        message: { content: [{ type: 'text', text: 'partial' }] },
      },
    },
    recorder,
  )
  assert.deepEqual(
    projected.map((item) => item.event),
    ['text', 'error'],
  )
  assert.equal(projected[1].data.code, 'INTERRUPTED')
})

test('ignores unrelated session events', () => {
  const recorder = new TurnRecorder()
  assert.deepEqual(projectSessionEvent({ type: 'user/message', data: {} }, recorder), [])
  assert.deepEqual(projectSessionEvent({ type: 'request/header', data: {} }, recorder), [])
  assert.deepEqual(projectSessionEvent(null, recorder), [])
})

test('parseArguments keeps non-JSON input verbatim', () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 })
  assert.equal(parseArguments('not json'), 'not json')
  assert.deepEqual(parseArguments(''), {})
})

test('flattenContent joins text blocks and marks non-text blocks', () => {
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(flattenContent([{ type: 'image' }, { type: 'tool-call', name: 'x' }]), '[image]\n[tool call x]')
  assert.equal(flattenContent('plain'), 'plain')
  assert.equal(flattenContent(undefined), '')
})
