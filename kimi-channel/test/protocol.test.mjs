import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ChannelError,
  PROTOCOL_VERSION,
  errorFrame,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireString,
  successFrame,
  validateRequest,
} from '../lib/protocol.mjs'

test('accepts a well-formed request frame', () => {
  const request = validateRequest({ v: 1, t: 'req', id: 'r1', method: 'health', params: {} })
  assert.deepEqual(request, { id: 'r1', method: 'health', params: {} })
})

test('accepts a request without explicit frame type or params', () => {
  assert.deepEqual(validateRequest({ v: 1, id: 'a', method: 'state.snapshot' }), {
    id: 'a',
    method: 'state.snapshot',
    params: {},
  })
})

test('rejects a missing version with BAD_VERSION', () => {
  assert.throws(() => validateRequest({ id: 'a', method: 'health' }), (error) => error instanceof ChannelError && error.code === 'BAD_VERSION')
})

test('rejects a foreign version with BAD_VERSION mentioning the expected version', () => {
  try {
    validateRequest({ v: 2, id: 'a', method: 'health' })
    assert.fail('expected a throw')
  } catch (error) {
    assert.equal(error.code, 'BAD_VERSION')
    assert.equal(error.details.expected, PROTOCOL_VERSION)
  }
})

test('rejects a non-object frame, an empty id, and an unknown method', () => {
  assert.throws(() => validateRequest(null), (error) => error.code === 'BAD_FRAME')
  assert.throws(() => validateRequest([]), (error) => error.code === 'BAD_FRAME')
  assert.throws(() => validateRequest({ v: 1, id: '', method: 'health' }), (error) => error.code === 'BAD_FRAME')
  assert.throws(() => validateRequest({ v: 1, id: 'a', method: 'nope' }), (error) => error.code === 'UNKNOWN_METHOD')
})

test('rejects array params with BAD_PARAMS', () => {
  assert.throws(() => validateRequest({ v: 1, id: 'a', method: 'health', params: [] }), (error) => error.code === 'BAD_PARAMS')
})

test('builds success and failure frames', () => {
  assert.deepEqual(JSON.parse(successFrame('x', { ok: true })), { v: 1, t: 'res', id: 'x', ok: true, result: { ok: true } })
  assert.deepEqual(JSON.parse(errorFrame('x', { code: 'BAD_FRAME', message: 'bad' })), {
    v: 1,
    t: 'res',
    id: 'x',
    ok: false,
    error: { code: 'BAD_FRAME', message: 'bad' },
  })
})

test('parameter readers validate types and bounds', () => {
  assert.equal(requireString({ key: 'abc' }, 'key'), 'abc')
  assert.throws(() => requireString({}, 'key'), (error) => error.code === 'BAD_PARAMS')
  assert.throws(() => requireString({ key: 'abc' }, 'key', { maxLength: 2 }), (error) => error.code === 'BAD_PARAMS')
  assert.equal(optionalString({}, 'x'), undefined)
  assert.equal(optionalString({ x: 'y' }, 'x'), 'y')
  assert.throws(() => optionalString({ x: 1 }, 'x'), (error) => error.code === 'BAD_PARAMS')
  assert.equal(optionalBoolean({}, 'x'), undefined)
  assert.equal(optionalBoolean({ x: true }, 'x'), true)
  assert.throws(() => optionalBoolean({ x: 'yes' }, 'x'), (error) => error.code === 'BAD_PARAMS')
  assert.equal(optionalInteger({}, 'x'), undefined)
  assert.equal(optionalInteger({ x: 0 }, 'x'), 0)
  assert.throws(() => optionalInteger({ x: -1 }, 'x'), (error) => error.code === 'BAD_PARAMS')
})
