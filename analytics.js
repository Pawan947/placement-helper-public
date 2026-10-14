const { PostHog } = require('posthog-node')
const os = require('os')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

require('dotenv').config({ path: path.join(__dirname, '.env') })

const posthogKey = process.env.POSTHOG_API_KEY

if (!posthogKey) {
  console.log('Analytics disabled (POSTHOG_API_KEY is not set)')
} else {
  const posthog = new PostHog(posthogKey, {
    host: 'https://us.i.posthog.com'
  })

  const dataDir = process.env.PIPELINE_DATA_DIR || __dirname
  const file = path.join(dataDir, 'device.json')
  fs.mkdirSync(dataDir, { recursive: true })

  let userId
  try {
    userId = JSON.parse(fs.readFileSync(file, 'utf8')).id
  } catch {
    userId = crypto.randomUUID()
    fs.writeFileSync(file, JSON.stringify({ id: userId }))
  }

  async function syncStatus() {
    try {
      await posthog.capture({
        distinctId: userId,
        event: 'app_ping',
        properties: {
          platform: os.platform(),
          architecture: os.arch()
        }
      })
    } catch {
      console.log('Analytics delivery failed')
    }
  }

  syncStatus()
  const interval = setInterval(syncStatus, 30 * 60 * 1000)

  process.on('beforeExit', async () => {
    clearInterval(interval)
    await posthog.shutdown()
  })
}
