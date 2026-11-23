import { copyFile, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir('dist/setup-assets/setup', { recursive: true })
await Promise.all([
  copyFile('browser/index.html', 'dist/setup-assets/setup/index.html'),
  copyFile('browser/style.css', 'dist/setup-assets/setup/style.css'),
  copyFile('browser/_headers', 'dist/setup-assets/_headers'),
  build({
    entryPoints: ['browser/setup.ts'],
    bundle: true,
    format: 'esm',
    minify: true,
    outfile: 'dist/setup-assets/setup/setup.js',
  }),
])
