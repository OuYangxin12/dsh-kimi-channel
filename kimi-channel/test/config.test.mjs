import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { isCwdAllowed, loadConfig } from '../lib/config.mjs'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-channel-config-'))

test('defaults bind loopback and keep the token under the DSH home', () => {
  const home = tempDir()
  const { config, sources } = loadConfig({}, { home, readFile: false })
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 8137)
  assert.equal(config.tokenFile, path.join(home, 'kimi-channel.token'))
  assert.equal(config.sessionMapFile, path.join(home, 'kimi-channel-sessions.json'))
  assert.ok(config.autoAllowTools.includes('read'))
  assert.ok(config.autoAllowTools.includes('glob'))
  assert.ok(!config.autoAllowTools.includes('write'))
  assert.deepEqual(sources, ['defaults'])
})

test('the JSON file overrides the row config', () => {
  const home = tempDir()
  fs.writeFileSync(
    path.join(home, 'kimi-channel.json'),
    JSON.stringify({ port: 9100, autoAllowTools: ['read', 'glob'], interactionTimeoutMs: 1000, agent: { provider: 'p', model: 'm' } }),
  )
  const { config, sources } = loadConfig({ port: 8137, host: '127.0.0.1' }, { home })
  assert.equal(config.port, 9100)
  assert.deepEqual([...config.autoAllowTools], ['read', 'glob'])
  assert.equal(config.interactionTimeoutMs, 1000)
  assert.deepEqual(config.agent, { provider: 'p', model: 'm' })
  assert.equal(sources.length, 3)
})

test('an invalid config throws with an actionable message', () => {
  const home = tempDir()
  assert.throws(() => loadConfig({ host: '0.0.0.0' }, { home, readFile: false }), /loopback/)
  assert.throws(() => loadConfig({ port: 0 }, { home, readFile: false }), /port/)
  assert.throws(() => loadConfig({ eventBufferSize: 0 }, { home, readFile: false }), /eventBufferSize/)
  fs.writeFileSync(path.join(home, 'kimi-channel.json'), '[]')
  assert.throws(() => loadConfig({}, { home }), /JSON object/)
})

test('isCwdAllowed accepts only directories under an allowed root', () => {
  const root = '/home/user/projects'
  assert.equal(isCwdAllowed('/home/user/projects', [root]), true)
  assert.equal(isCwdAllowed('/home/user/projects/app', [root]), true)
  assert.equal(isCwdAllowed('/home/user/projects-other', [root]), false)
  assert.equal(isCwdAllowed('/etc', [root]), false)
})
