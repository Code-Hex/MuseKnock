import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importDeviceRecord } from '../src/device-import.ts'

test('browser import exports only device fields and accepts either authorization format', () => {
  const sdk = 'mgst_' + 'A'.repeat(43)
  assert.deepEqual(
    importDeviceRecord({
      sdk_token: sdk,
      session: { refresh_token: 'private-user-token' },
      device: { device_id: 'gadget-abc123', refresh_token: 'device-token', access_token: 'unused' },
    }),
    { MUSE_NODE_ID: 'gadget-abc123', MUSE_REFRESH_TOKEN: 'device-token', MUSE_SDK_TOKEN: sdk },
  )
  assert.deepEqual(
    importDeviceRecord({
      token_type: 'device',
      node_id: 'gadget-abc123',
      refresh_token: 'paired',
    }),
    { MUSE_NODE_ID: 'gadget-abc123', MUSE_REFRESH_TOKEN: 'paired' },
  )
  assert.throws(
    () => importDeviceRecord({ token_type: 'user', refresh_token: 'secret-to-redact' }),
    (e: Error) => !e.message.includes('secret-to-redact'),
  )
})
