import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { identifier } from './identifiers.ts'
import type { Inbox } from './store.ts'

type DeliveryControls = Pick<
  DurableObjectStub<Inbox>,
  'status' | 'sources' | 'setPaused' | 'setFilter'
>

const name = z.string().regex(identifier)
const readOnly = { readOnlyHint: true, openWorldHint: false }
const changeRule = { readOnlyHint: false, idempotentHint: true, openWorldHint: false }

function result(data: object): CallToolResult {
  return { structuredContent: { ...data }, content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export async function handleMcp(
  request: Request,
  inbox: DeliveryControls,
  canWrite: boolean,
): Promise<Response> {
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new Response('Forbidden origin', { status: 403 })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  const server = new McpServer({ name: 'museknock', version: '0.1.0' })
  server.registerTool(
    'list_sources',
    {
      description:
        'List webhook sources, their pause settings, and allowed event types. An empty list of types allows all types.',
      annotations: readOnly,
    },
    async () => result({ sources: await inbox.sources() }),
  )

  server.registerTool(
    'get_delivery_status',
    {
      description:
        'Look up a webhook delivery by its receipt ID. Sent means the gadget accepted the message.',
      inputSchema: { id: z.uuid() },
      annotations: readOnly,
    },
    async ({ id }) => {
      const delivery = await inbox.status(id)
      if (!delivery) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'No delivery found for this receipt ID.' }],
        }
      }
      return result(delivery)
    },
  )

  if (canWrite) {
    server.registerTool(
      'set_source_paused',
      {
        description:
          "Pause or resume a webhook source at the user's request. A delivery already in progress may still arrive.",
        inputSchema: { source: name, paused: z.boolean() },
        annotations: changeRule,
      },
      async ({ source, paused }) => result(await inbox.setPaused(source, paused)),
    )

    server.registerTool(
      'set_event_filter',
      {
        description:
          "Replace the event types allowed for one source at the user's request. An empty list allows all event types.",
        inputSchema: { source: name, types: z.array(name).max(64) },
        annotations: changeRule,
      },
      async ({ source, types }) => result(await inbox.setFilter(source, types)),
    )
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: 32 * 1024,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
