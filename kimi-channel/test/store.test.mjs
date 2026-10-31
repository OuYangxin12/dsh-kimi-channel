import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { EventBuffer, IdempotencyTable, SessionMap } from '../lib/store.mjs'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-channel-store-'))

test('SessionMap persists, reloads, and stays 0600', () => {
  const dir = tempDir()
  const file = path.join(dir, 'sessions.json')
  const map = new SessionMap(file).load()
  assert.equal(map.get('conv-a'), undefined)
  map.set('conv-a', { sessionId: 'session-1', cwd: '/tmp' })
  const stat = fs.statSync(file)
  assert.equal(stat.mode & 0o777, 0o600)
  const reloaded = new SessionMap(file).load()
  assert.deepEqual(reloaded.get('conv-a'), { sessionId: 'session-1', cwd: '/tmp', createdAt: reloaded.get('conv-a').createdAt })
  assert.equal(reloaded.delete('conv-a'), true)
  assert.equal(new SessionMap(file).load().get('conv-a'), undefined)
})

test('SessionMap survives a corrupt file by starting empty', () => {
  const dir = tempDir()
  const file = path.join(dir, 'sessions.json')
  fs.writeFileSync(file, '{not json')
  const map = new SessionMap(file).load()
  assert.equal(map.corrupt, true)
  assert.equal(map.get('anything'), undefined)
})

test('EventBuffer assigns monotonic seq and replays after a given seq', () => {
  const buffer = new EventBuffer(3)
  assert.equal(buffer.lastSeq, 0)
  const first = buffer.push('text', { text: 'a' }, 'conv')
  const second = buffer.push('text', { text: 'b' }, 'conv')
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(buffer.push('text', { text: 'c' }, 'other').seq, 3)
  buffer.push('text', { text: 'd' }, 'conv')
  assert.equal(buffer.lastSeq, 4)
  // Capacity 3 keeps seq 2..4.
  assert.deepEqual(buffer.since(0).map((frame) => frame.seq), [2, 3, 4])
  assert.deepEqual(buffer.since(2).map((frame) => frame.seq), [3, 4])
  assert.deepEqual(buffer.since(1, { conversationKey: 'conv' }).map((frame) => frame.seq), [2, 4])
  assert.deepEqual(buffer.since(4), [])
})

test('EventBuffer honors the replay limit', () => {
  const buffer = new EventBuffer(10)
  for (let i = 0; i < 5; i += 1) buffer.push('text', { i })
  assert.equal(buffer.since(0, { limit: 2 }).length, 2)
})

test('IdempotencyTable bounds its size and evicts the oldest entry', () => {
  const table = new IdempotencyTable(2)
  table.set('a', { result: 1 })
  table.set('b', { result: 2 })
  table.set('c', { result: 3 })
  assert.equal(table.get('a'), undefined)
  assert.deepEqual(table.get('c'), { result: 3 })
  table.set('b', { result: 4 })
  assert.deepEqual(table.get('b'), { result: 4 })
})
