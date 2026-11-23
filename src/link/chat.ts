import type { Outcome } from '../delivery.ts'
import { sideChatId } from '../muse-device.ts'
import { startNoise } from './noise.ts'
import {
  bodyEnvelope,
  ControlMessages,
  controlMessage,
  fragments,
  requestEnvelope,
  ResponseFrames,
} from './wire.ts'

type Vm = { noiseHost: string; vmId: string; vmToken: string }

function readPackets(socket: WebSocket, signal: AbortSignal) {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      start(controller) {
        let stopped = false
        function stop() {
          if (stopped) return
          stopped = true
          controller.error(new Error('Muse Link connection ended'))
        }
        socket.addEventListener('message', ({ data }) => {
          if (stopped) return
          if (
            !(data instanceof ArrayBuffer) ||
            data.byteLength < 16 ||
            data.byteLength > 65_535 ||
            (controller.desiredSize ?? 0) <= 0
          ) {
            stop()
            return
          }
          controller.enqueue(new Uint8Array(data))
        })
        socket.addEventListener('close', () => {
          if (stopped) return
          stopped = true
          controller.close()
        })
        socket.addEventListener('error', stop)
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
      },
    },
    { highWaterMark: 32 },
  )
  const reader = stream.getReader()
  return async () => {
    const { value, done } = await reader.read()
    if (done) throw new Error('Muse Link connection closed')
    return value
  }
}

export async function sendOverLink(
  socket: WebSocket,
  nodeId: string,
  sessionId: string,
  message: string,
  signal: AbortSignal,
): Promise<Outcome> {
  let failure: Outcome = 'not_sent'
  try {
    socket.binaryType = 'arraybuffer'
    const receive = readPackets(socket, signal)
    function send(data: Uint8Array<ArrayBuffer>) {
      signal.throwIfAborted()
      socket.send(data)
    }
    const handshake = await startNoise()
    send(handshake.message1)
    const keys = await handshake.finish(await receive())
    send(keys.message3)

    async function write(envelope: Uint8Array, startsChat = false) {
      for (const part of fragments(envelope)) {
        const packet = await keys.encrypt(part)
        signal.throwIfAborted()
        if (startsChat) failure = 'unknown'
        send(packet)
      }
    }
    const registration = crypto.randomUUID()
    await write(requestEnvelope(1, '/link-control', []))
    await write(
      bodyEnvelope(
        1,
        controlMessage({
          type: 'req',
          id: registration,
          method: 'link.register',
          params: {
            node_id: nodeId,
            display_name: 'MuseKnock',
            platform: 'linux',
            version: '0.1.0',
            device_family: 'gadget',
            model_id: 'museknock',
            metadata: { model_name: 'MuseKnock' },
            is_wakeup_supported: false,
            commands_v2: {},
          },
        }),
      ),
    )

    const messages = new ControlMessages()
    const frames = new ResponseFrames()
    let registered = false
    let chatStatus: number | undefined
    let chatBytes = 0
    let acknowledgement = ''
    const decoder = new TextDecoder('utf-8', { fatal: true })
    while (true) {
      const frame = frames.push(await keys.decrypt(await receive()))
      if (!frame) continue
      if (frame.stream === 1) {
        if (
          frame.ended ||
          (frame.status !== undefined && (frame.status < 200 || frame.status >= 300))
        ) {
          throw new Error('Muse closed the control stream')
        }
        for (const reply of messages.push(frame.body)) {
          if (reply.event === 'link.unpaired' || reply.event === 'node.unpaired')
            throw new Error('Device unpaired')
          if (registered || reply.id !== registration || reply.method !== undefined) continue
          if (reply.error || reply.ok === false)
            throw new Error('Muse rejected gadget registration')
          registered = true
          const headers: [string, string][] = [
            ['Content-Type', 'application/json'],
            ['x-request-id', crypto.randomUUID()],
            ['x-app-id', 'musegadget'],
          ]
          const body = new TextEncoder().encode(
            JSON.stringify({
              message,
              output_modality: 'text',
              device_id: nodeId,
              session_id: sessionId,
            }),
          )
          if (body.length <= 64 * 1024) {
            await write(requestEnvelope(2, '/chat/stream', headers, body), true)
          } else {
            await write(requestEnvelope(2, '/chat/stream', headers), true)
            for (let start = 0; start < body.length; start += 16 * 1024) {
              const end = Math.min(start + 16 * 1024, body.length)
              await write(bodyEnvelope(2, body.subarray(start, end), end === body.length))
            }
          }
        }
      } else if (frame.stream === 2 && registered) {
        if (frame.status !== undefined) {
          if (chatStatus !== undefined || frame.status < 100 || frame.status > 599)
            throw new Error('Invalid Muse response status')
          chatStatus = frame.status
        }
        chatBytes += frame.body.length
        if (chatStatus === undefined || chatBytes > 1024 * 1024)
          throw new Error('Invalid Muse response body')
        acknowledgement += decoder.decode(frame.body, { stream: !frame.ended })
        if (frame.ended) {
          if (chatStatus < 200 || chatStatus >= 300) return 'unknown'
          const reply: unknown = JSON.parse(acknowledgement)
          return reply !== null && typeof reply === 'object' && !Array.isArray(reply)
            ? 'sent'
            : 'unknown'
        }
      }
    }
  } catch {
    return failure
  }
}

export async function sendSideChat(
  vm: Vm,
  nodeId: string,
  sessionId: string,
  message: string,
): Promise<Outcome> {
  if (!nodeId || !sideChatId.test(sessionId)) return 'not_sent'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 75_000)
  let socket: (WebSocket & { accept(): void }) | undefined
  try {
    const url = new URL('https://' + vm.noiseHost + '/v1/noise')
    url.searchParams.set('vm_id', vm.vmId)
    const response = await fetch(url, {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer ' + vm.vmToken },
      redirect: 'manual',
      signal: controller.signal,
    })
    socket = (response as Response & { webSocket?: typeof socket }).webSocket
    if (response.status !== 101 || !socket) {
      await response.body?.cancel()
      return 'not_sent'
    }
    socket.accept()
    return await sendOverLink(socket, nodeId, sessionId, message, controller.signal)
  } catch {
    return 'not_sent'
  } finally {
    clearTimeout(timer)
    controller.abort()
    try {
      if (socket && socket.readyState < 2) socket.close(1000)
    } catch {
      // The peer may have closed while this Worker was finishing the receipt.
    }
  }
}
