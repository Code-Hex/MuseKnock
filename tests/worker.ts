import { build } from 'esbuild'
import { Miniflare, Response, convertV4MiniflareOptions, type V4ServiceDesignator } from 'miniflare'

export async function startWorker(
  outbound: V4ServiceDesignator = () => new Response(null, { status: 503 }),
  overrides: Record<string, string> = {},
) {
  const bundle = await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker'],
    external: ['cloudflare:*', 'node:*'],
    write: false,
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      script: bundle.outputFiles[0].text,
      modules: true,
      compatibilityDate: '2026-11-19',
      host: '127.0.0.1',
      port: 0,
      cf: false,
      durableObjects: { INBOX: { className: 'Inbox', useSQLite: true } },
      outboundService: outbound,
      bindings: {
        HOOK_TOKEN: 'HOOK_TOKEN-test',
        MUSE_NODE_ID: 'test-123abc',
        MUSE_SDK_TOKEN: 'mgst_' + 'A'.repeat(43),
        MUSE_REFRESH_TOKEN: 'test-initial-refresh',
        MUSE_SESSION_ID: 'same-chat',
        MCP_ADMIN_TOKEN: 'MCP_ADMIN_TOKEN-test',
        MCP_TOKEN: 'MCP_TOKEN-test',
        ...overrides,
      },
    }),
  )
  try {
    return { url: await runtime.ready, close: () => runtime.dispose() }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
