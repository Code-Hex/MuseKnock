import { setTimeout as delay } from 'node:timers/promises'
import { deliverOne, readConfig } from './relay.ts'

async function run() {
  const config = readConfig(process.env)
  console.info('MuseKnock ブリッジを開始しました。投稿先: ' + config.sessionId)
  let backoff = 5_000
  while (true) {
    try {
      const outcome = await deliverOne(config)
      if (outcome === 'idle' || outcome === 'sent') {
        backoff = 5_000
        if (outcome === 'idle') await delay(10_000)
        continue
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'ブリッジでエラーが発生しました。')
    }
    await delay(backoff)
    backoff = Math.min(60_000, backoff * 2)
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'ブリッジを起動できませんでした。')
  process.exitCode = 1
})
