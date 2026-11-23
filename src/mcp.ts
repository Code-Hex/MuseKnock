import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { identifier } from './identifiers.ts'
import { sideChatId } from './muse-device.ts'
import type { Inbox } from './inbox.ts'

type DeliveryControls = Pick<
  DurableObjectStub<Inbox>,
  | 'status'
  | 'sources'
  | 'setPaused'
  | 'setFilter'
  | 'listSideChats'
  | 'registerSideChat'
  | 'setActiveSideChat'
>

const name = z.string().regex(identifier)
const chatName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]*$/u)
  .describe('A case-sensitive name for this destination in MuseKnock.')
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
    'list_side_chats',
    {
      description:
        'List side chats registered with this Worker, their session IDs and the active webhook destination.',
      annotations: readOnly,
    },
    async () => result(await inbox.listSideChats()),
  )

  server.registerTool(
    'get_delivery_status',
    {
      description:
        'Look up a webhook delivery by its receipt ID. Sent means Muse acknowledged the chat post.',
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
      'register_side_chat',
      {
        description:
          'Save or update a named webhook destination using the exact session ID of an existing Muse side chat. Ask the user for the ID if it is unknown. The first destination becomes active. Updating an active destination affects future webhooks.',
        inputSchema: {
          name: chatName,
          sessionId: z
            .string()
            .regex(sideChatId)
            .describe('The existing Muse side chat session ID.'),
        },
        annotations: changeRule,
      },
      async ({ name, sessionId }) => result(await inbox.registerSideChat(name, sessionId)),
    )

    server.registerTool(
      'set_active_side_chat',
      {
        description:
          'Route future webhooks to a registered side chat by name. Already accepted webhooks keep their original destination.',
        inputSchema: { name: chatName },
        annotations: changeRule,
      },
      async ({ name }) => {
        const destinations = await inbox.setActiveSideChat(name)
        if (destinations) return result(destinations)
        return {
          isError: true,
          content: [{ type: 'text', text: 'No registered side chat has that name.' }],
        }
      },
    )

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
