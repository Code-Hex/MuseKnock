import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

export async function startWorker() {
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
      bindings: {
        HOOK_TOKEN: 'HOOK_TOKEN-test',
        BRIDGE_TOKEN: 'BRIDGE_TOKEN-test',
        MCP_ADMIN_TOKEN: 'MCP_ADMIN_TOKEN-test',
        MCP_TOKEN: 'MCP_TOKEN-test',
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
