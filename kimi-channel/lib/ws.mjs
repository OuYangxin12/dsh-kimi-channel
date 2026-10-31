/**
 * Minimal RFC 6455 WebSocket server, limited deliberately to what the channel
 * needs: no extensions, no subprotocols, text frames, ping/pong, close, and
 * fragmented messages up to a fixed size. Keeping it dependency-free means the
 * plugin installs without a network fetch.
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa
const MAX_MESSAGE_BYTES = 1024 * 1024

/**
 * One upgraded connection: framing, message assembly, and JSON helpers.
 */
export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {import('node:http').IncomingMessage} request
   */
  constructor(socket, request) {
    super()
    this.socket = socket
    this.request = request
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentBytes = 0
    this.fragmentOpcode = undefined
    this.closeEmitted = false
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (error) => this.#fail(error))
    socket.on('end', () => this.#emitClose())
    socket.on('close', () => this.#emitClose())
  }

  /**
   * Send one JSON payload as a text frame.
   * @param {unknown} value
   */
  sendJson(value) {
    this.sendText(JSON.stringify(value))
  }

  /**
   * @param {string} text
   */
  sendText(text) {
    this.#sendFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'))
  }

  /**
   * Close the connection and stop reading.
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123)
    const payload = Buffer.alloc(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    try {
      this.#sendFrame(OPCODE_CLOSE, payload)
    } catch {
      /* socket already gone */
    }
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 250).unref?.()
  }

  /** Destroy without a handshake (used during plugin teardown). */
  destroy() {
    this.closed = true
    this.socket.destroy()
    this.#emitClose()
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  #sendFrame(opcode, payload) {
    if (this.closed && opcode !== OPCODE_CLOSE) return
    if (payload.length > MAX_MESSAGE_BYTES) throw new Error('kimi-channel: outbound frame too large')
    let header
    if (payload.length < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x80 | opcode
      header[1] = payload.length
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.socket.write(Buffer.concat([header, payload]))
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.#parseOne()) {
      /* keep parsing */
    }
  }

  /**
   * Parse one frame from the head of the buffer.
   * @returns {boolean} whether a full frame was consumed.
   */
  #parseOne() {
    const buffer = this.buffer
    if (buffer.length < 2) return false
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const rsv = first & 0x70
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (rsv !== 0) {
      this.close(1002, 'reserved bits are not supported')
      return false
    }
    if (length === 126) {
      if (buffer.length < offset + 2) return false
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return false
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.close(1009, 'frame too large')
        return false
      }
      length = Number(big)
      offset += 8
    }
    if (length > MAX_MESSAGE_BYTES) {
      this.close(1009, 'frame too large')
      return false
    }
    let maskKey
    if (masked) {
      if (buffer.length < offset + 4) return false
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return false
    let payload = buffer.subarray(offset, offset + length)
    this.buffer = buffer.subarray(offset + length)
    if (maskKey) {
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3]
    }
    this.#onFrame(fin, opcode, payload)
    return this.buffer.length >= 2
  }

  /**
   * @param {boolean} fin
   * @param {number} opcode
   * @param {Buffer} payload
   */
  #onFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE_PING:
        this.#sendFrame(OPCODE_PONG, payload)
        return
      case OPCODE_PONG:
        return
      case OPCODE_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        this.closed = true
        try {
          if (payload.length >= 2) this.#sendFrame(OPCODE_CLOSE, payload.subarray(0, 2))
        } catch {
          /* ignore */
        }
        this.socket.end()
        this.emit('closing', code)
        this.#emitClose()
        return
      }
      case OPCODE_TEXT:
      case OPCODE_BINARY:
        if (fin) {
          this.#deliver(opcode, payload)
          return
        }
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        this.fragmentBytes = payload.length
        return
      case OPCODE_CONTINUATION: {
        if (this.fragmentOpcode === undefined) {
          this.close(1002, 'continuation without an open message')
          return
        }
        this.fragments.push(payload)
        this.fragmentBytes += payload.length
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
          this.close(1009, 'message too large')
          return
        }
        if (fin) {
          const complete = Buffer.concat(this.fragments)
          const opcodeValue = this.fragmentOpcode
          this.fragments = []
          this.fragmentBytes = 0
          this.fragmentOpcode = undefined
          this.#deliver(opcodeValue, complete)
        }
        return
      }
      default:
        this.close(1002, `unsupported opcode ${opcode}`)
    }
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  #deliver(opcode, payload) {
    if (opcode === OPCODE_BINARY) {
      this.emit('binary', payload)
      return
    }
    const text = payload.toString('utf8')
    this.emit('message', text)
    try {
      this.emit('json', JSON.parse(text))
    } catch {
      this.emit('bad-json', text)
    }
  }

  /** @param {Error} error */
  #fail(error) {
    this.emit('error', error)
    this.#emitClose()
  }

  #emitClose() {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.closed = true
    this.emit('close')
  }
}

/**
 * Attach a WebSocket endpoint to an existing HTTP server's `upgrade` event.
 *
 * @param {import('node:http').Server} httpServer
 * @param {{authorize?: (request: import('node:http').IncomingMessage) => {ok: boolean, status?: number, message?: string}}} [options]
 * @returns {{connections: Set<WsConnection>, close: () => void}}
 */
export function attachWebSocketServer(httpServer, options = {}) {
  /** @type {Set<WsConnection>} */
  const connections = new Set()

  /** @param {import('node:net').Socket} socket @param {number} status @param {string} message */
  const reject = (socket, status, message) => {
    const body = `${message}\n`
    socket.write(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
    socket.destroy()
  }

  /** @param {import('node:http').IncomingMessage} request @param {import('node:net').Socket} socket @param {Buffer} head */
  const onUpgrade = (request, socket, head) => {
    const key = request.headers['sec-websocket-key']
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
    const version = String(request.headers['sec-websocket-version'] ?? '')
    if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') {
      reject(socket, 400, 'not a WebSocket upgrade request')
      return
    }
    const decision = options.authorize ? options.authorize(request) : { ok: true }
    if (!decision.ok) {
      reject(socket, decision.status ?? 401, decision.message ?? 'unauthorized')
      return
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (head && head.length > 0) socket.unshift(head)
    const connection = new WsConnection(socket, request)
    connections.add(connection)
    connection.once('close', () => connections.delete(connection))
    httpServer.emit('connection-accepted', connection)
  }

  httpServer.on('upgrade', onUpgrade)

  return {
    connections,
    close() {
      httpServer.off('upgrade', onUpgrade)
      for (const connection of connections) connection.destroy()
      connections.clear()
    },
  }
}

/**
 * Module-private aware helper for tests: encode one client (masked) text frame.
 * Not used by the server itself.
 * @param {string} text
 * @param {number} [opcode]
 * @returns {Buffer}
 */
export function encodeClientFrame(text, opcode = OPCODE_TEXT) {
  const payload = Buffer.from(text, 'utf8')
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3]
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

/**
 * Decode one server (unmasked) frame from a buffer. Test helper.
 * @param {Buffer} buffer
 * @returns {{opcode: number, text: string, length: number} | null}
 */
export function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (buffer.length < offset + length) return null
  return { opcode, text: buffer.subarray(offset, offset + length).toString('utf8'), length: offset + length }
}
