import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { test } from 'node:test'

import { attachWebSocketServer, decodeServerFrame, encodeClientFrame } from '../lib/ws.mjs'

/** Start a loopback HTTP server with the WebSocket upgrade attached. */
async function startServer(options = {}) {
  const server = http.createServer((request, response) => response.writeHead(404).end())
  const ws = attachWebSocketServer(server, options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { server, ws, port }
}

/** Perform the opening handshake and return the accepted connection plus socket. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let raw = Buffer.alloc(0)
    const onData = (chunk) => {
      raw = Buffer.concat([raw, chunk])
      const end = raw.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const header = raw.subarray(0, end).toString('utf8')
      assert.match(header, /101 Switching Protocols/)
      assert.match(header, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)
      socket.rest = raw.subarray(end + 4)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

/** Read one complete server frame from a socket, using buffered leftovers. */
function readFrame(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs)
    const tryParse = () => {
      const frame = decodeServerFrame(socket.rest)
      if (!frame) return false
      socket.rest = socket.rest.subarray(frame.length)
      clearTimeout(timer)
      resolve(frame)
      return true
    }
    if (tryParse()) return
    const onData = (chunk) => {
      socket.rest = Buffer.concat([socket.rest, chunk])
      if (tryParse()) socket.off('data', onData)
    }
    socket.on('data', onData)
  })
}

/** Wait for the next accepted connection, registered before the handshake. */
function nextConnection(server) {
  return once(server, 'connection-accepted').then(([connection]) => connection)
}

test('rejects an upgrade without the expected headers', async () => {
  const { server, ws, port } = await startServer()
  try {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'))
    let raw = ''
    await new Promise((resolve) => {
      socket.on('data', (chunk) => {
        raw += chunk.toString('utf8')
        if (raw.includes('\r\n\r\n')) {
          socket.destroy()
          resolve()
        }
      })
    })
    assert.match(raw, /400 Bad Request/)
  } finally {
    ws.close()
    server.close()
  }
})

test('rejects an upgrade refused by authorize', async () => {
  const { server, ws, port } = await startServer({ authorize: () => ({ ok: false, status: 401, message: 'nope' }) })
  try {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let raw = ''
    await new Promise((resolve) => {
      socket.on('data', (chunk) => {
        raw += chunk.toString('utf8')
        if (raw.includes('\r\n\r\n')) {
          socket.destroy()
          resolve()
        }
      })
    })
    assert.match(raw, /401 Unauthorized/)
    assert.match(raw, /nope/)
  } finally {
    ws.close()
    server.close()
  }
})

test('accepts a valid upgrade and exchanges masked text frames', async () => {
  const { server, ws, port } = await startServer()
  try {
    const accepted = nextConnection(server)
    const socket = await connect(port)
    const connection = await accepted
    const nextJson = once(connection, 'json')
    socket.write(encodeClientFrame(JSON.stringify({ v: 1, id: 'x', method: 'health' })))
    const [frame] = await nextJson
    assert.equal(frame.id, 'x')
    connection.sendJson({ v: 1, t: 'res', id: 'x', ok: true, result: { ok: true } })
    const response = await readFrame(socket)
    assert.equal(response.opcode, 1)
    assert.deepEqual(JSON.parse(response.text), { v: 1, t: 'res', id: 'x', ok: true, result: { ok: true } })
    socket.destroy()
  } finally {
    ws.close()
    server.close()
  }
})

test('reassembles fragmented messages and answers ping with pong', async () => {
  const { server, ws, port } = await startServer()
  try {
    const accepted = nextConnection(server)
    const socket = await connect(port)
    const connection = await accepted
    const nextJson = once(connection, 'json')
    // First frame: text, FIN=0; second: continuation, FIN=1.
    const first = encodeClientFrame('{"a":', 0x1)
    first[0] &= 0x7f
    const second = encodeClientFrame('1}', 0x0)
    socket.write(Buffer.concat([first, second]))
    const [frame] = await nextJson
    assert.deepEqual(frame, { a: 1 })
    // A ping must produce a pong.
    const ping = encodeClientFrame('', 0x9)
    socket.write(ping)
    const pong = await readFrame(socket)
    assert.equal(pong.opcode, 0xa)
    socket.destroy()
  } finally {
    ws.close()
    server.close()
  }
})

test('echoes the close handshake and removes the connection', async () => {
  const { server, ws, port } = await startServer()
  try {
    const accepted = nextConnection(server)
    const socket = await connect(port)
    const connection = await accepted
    const closed = once(connection, 'close')
    socket.write(encodeClientFrame('', 0x8))
    await closed
    assert.equal(ws.connections.size, 0)
    socket.destroy()
  } finally {
    ws.close()
    server.close()
  }
})
