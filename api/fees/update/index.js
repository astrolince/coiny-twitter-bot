// require libs
const trae = require('trae')
const { promisify } = require('util')

// require and config db
const redis = require('redis')
const redisPort = process.env.REDIS_PORT
const redisHost = process.env.REDIS_HOST
const redisPass = process.env.REDIS_PASS
const redisClient = redis.createClient(redisPort, redisHost)
redisClient.auth(redisPass)
redisClient.on('error', (err) => {
  console.error('Error ' + err)
})
const redisGet = promisify(redisClient.get).bind(redisClient)
const redisSet = promisify(redisClient.set).bind(redisClient)

// sort fees object
const sortFees = (unsortedFees) => {
  const blocks = Object.keys(unsortedFees).sort((a, b) => a - b) // sort target numbers lower to higher
  const fees = Object.keys(unsortedFees).sort((a, b) => unsortedFees[b] - unsortedFees[a]) // sort target numbers by higher to lower fee

  // recreate fees object by matching sorted blocks with sorted fees
  let response = {}
  for (let b in blocks) {
    response[blocks[b]] = Math.ceil(unsortedFees[fees[b]])
  }
  return response
}

// convert bitgo fees to satoshis
const convertToSats = (fees) => {
  const keys = Object.keys(fees)

  let response = {}
  for (let k in keys) {
    response[keys[k]] = fees[keys[k]] / 1000
  }
  return response
}

// request bitgo api fees
const getFees = async () => {
  try {
    const _bitGo = await trae.get('https://www.bitgo.com/api/v1/tx/fee')
    const _bitGoSats = await convertToSats(_bitGo.data.feeByBlockTarget)
    const bitGoFees = await sortFees(_bitGoSats)
    const _blockstream = await trae.get('https://blockstream.info/api/fee-estimates')
    const blockstreamFees = await sortFees(_blockstream.data)
    const rawFees = { ...bitGoFees, ...blockstreamFees }
    return rawFees
  } catch (err) {
    console.error('Error ' + err)
    throw err
  }
}

// select fee for specific block target
const feeFor = async (unsortedTargets, unparsedFees) => {
  const targets = unsortedTargets.sort() // sort from lowest to highest
  const fees = JSON.parse(unparsedFees)
  const feesBlocks = Object.keys(fees).sort((a, b) => b - a) // sort from highest to lowest
  const minTarget = parseInt(feesBlocks.slice(-1)[0]) // take last 'feesBlocks' block

  let response = {}
  for (let t in targets) {
    const target = (targets[t] < minTarget) ? minTarget : targets[t]
    for (let b in feesBlocks) {
      if (target >= feesBlocks[b]) {
        response[targets[t]] = fees[feesBlocks[b]]
        break
      }
    }
  }
  return response
}

// export api
module.exports = async (req, res) => {
  try {
    // check last time updated
    const redisReplyFeesTimeGet = await redisGet('fees:time')

    const TEN_MINUTES = 10 * 60 * 1000
    const currentTime = Date.now()

    // if fees:time is empty, just run the update
    const keyTime = ((redisReplyFeesTimeGet == null) ? (currentTime - TEN_MINUTES) : redisReplyFeesTimeGet)

    // calc diff
    const timeDiff = currentTime - keyTime

    // if last time >= ten minutes, update it now
    if (timeDiff >= TEN_MINUTES) {
      const rawFees = JSON.stringify(await getFees())
      const targets = [2, 4, 6, 12, 24, 48, 144, 504, 1008]
      const fees = await feeFor(targets, rawFees)
      const currentTime = Date.now()

      // save fees
      const redisReplyFeesSet = await redisSet('fees', fees)
      console.log(redisReplyFeesSet)

      // save raw fees
      const redisReplyRawFeesSet = await redisSet('fees:raw', rawFees)
      console.log(redisReplyRawFeesSet)

      // save time of the update
      const redisReplyFeesTimeSet = await redisSet('fees:time', currentTime)
      console.log(redisReplyFeesTimeSet)

      res.end('Updated ' + fees)
      return
    } else {
      const timeRemaining = new Date(TEN_MINUTES - timeDiff)
      res.end(`Wait ${timeRemaining.getUTCMinutes()} minutes and ${timeRemaining.getUTCSeconds()} seconds`)
      return
    }
  } catch (err) {
    console.error('Error ' + err)
    res.end('Error.')
  }
}
