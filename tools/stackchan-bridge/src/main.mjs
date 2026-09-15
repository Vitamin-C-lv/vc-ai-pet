import { readConfig } from './config.mjs'
import { mapPetStateToBodyContract } from './contract.mjs'
import { createStackChanBridgeServer } from './server.mjs'

const config = readConfig()
const server = createStackChanBridgeServer({
  upstreamUrl: config.upstreamUrl,
  upstreamTimeoutMs: config.upstreamTimeoutMs,
  stateMaxAgeMs: config.stateMaxAgeMs,
  mapPetStateToBodyContract,
})

server.listen(config.port, config.bindAddress, () => {
  console.log(`STACKCHAN_BRIDGE=http://${config.bindAddress}:${config.port}`)
  console.log(`UPSTREAM=${config.upstreamUrl}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
