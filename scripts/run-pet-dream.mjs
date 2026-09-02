import { homedir } from 'node:os'
import { join } from 'node:path'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const sandboxRoot = join(homedir(), '.local', 'share', 'vc-ai-pet', 'sandbox')
let runtime = null

try {
  runtime = new PetRuntime({ sandboxRoot })
  await runtime.initialize()
  const result = await runtime.runDreamNow()

  const report = {
    status: result?.status ?? 'unknown',
    reason: result?.reason ?? null,
    sourceCount: result?.sourceCount ?? 0,
    batchCount: result?.batchCount ?? 0,
    derivedCount: result?.derivedCount ?? 0,
    duplicateCount: result?.duplicateCount ?? 0,
    checkpoint: {
      before: result?.checkpointBefore ?? null,
      after: result?.checkpointAfter ?? result?.checkpoint ?? null,
    },
  }
  console.log(JSON.stringify(report))
  if (report.status === 'failed') process.exitCode = 1
} catch (error) {
  console.log(JSON.stringify({
    status: 'failed',
    sourceCount: 0,
    batchCount: 0,
    derivedCount: 0,
    duplicateCount: 0,
    checkpoint: { before: null, after: null },
    reason: typeof error?.code === 'string' ? error.code : 'dream-cli-failed',
  }))
  process.exitCode = 1
} finally {
  runtime?.close()
}
