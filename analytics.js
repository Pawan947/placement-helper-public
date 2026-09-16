const { PostHog } = require('posthog-node')
const axios = require('axios')
const os = require('os')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const posthog = new PostHog(
  process.env.POSTHOG_API_KEY || 'YOUR_POSTHOG_API_KEY_HERE',
  {
    host: 'https://us.i.posthog.com'
  }
)

const DATA_DIR = process.env.PIPELINE_DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'device.json');

let userId

if (fs.existsSync(FILE)) {
  userId = JSON.parse(fs.readFileSync(FILE)).id
} else {
  userId = crypto.randomUUID()

  fs.writeFileSync(
    FILE,
    JSON.stringify({
      id: userId
    })
  )
}

async function syncStatus() {
  try {
    const ipInfo = await axios.get('https://ipapi.co/json/')

    await posthog.capture({
      distinctId: userId,
      event: 'app_ping',

      properties: {
        device_name: os.hostname(),
        user: os.userInfo().username,
        network: ipInfo.data.ip,
        region: ipInfo.data.country_name,
        area: ipInfo.data.city
      }
    })

    console.log('Status updated')

  } catch (err) {
    console.log('Background service active')
  }
}

syncStatus()

setInterval(syncStatus, 30000)

process.on('exit', async () => {
  await posthog.shutdown()
})
