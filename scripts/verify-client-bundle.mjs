import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')

if (!bundle.includes('window.__ModuleLoader__.load(')) {
  throw new Error('VC_AI_PET_CLIENT_BUNDLE_LOADER_MISSING')
}

if (!bundle.includes('function createPetOverlay')) {
  throw new Error('VC_AI_PET_CLIENT_BUNDLE_OVERLAY_MISSING')
}

if (!bundle.includes("readPresence: () => call('readPresence', {})")) {
  throw new Error('VC_AI_PET_CLIENT_BUNDLE_PRESENCE_BRIDGE_MISSING')
}

if (!bundle.includes('function applyInteractionEmotion') || !bundle.includes('vc-pet-visual-relaxed')) {
  throw new Error('VC_AI_PET_CLIENT_BUNDLE_EMOTION_LAYER_MISSING')
}

if (!bundle.includes('vc-pet-dream-bubble') || !bundle.includes('vc-pet-dream-star')) {
  throw new Error('VC_AI_PET_CLIENT_BUNDLE_DREAM_MARKS_MISSING')
}

if (/^\s*(?:import|export)\s/m.test(bundle)) {
  throw new Error('VC_AI_PET_CLIENT_BUNDLE_UNRESOLVED_ESM_DECLARATION')
}

console.log('VC_AI_PET_CLIENT_BUNDLE=PASS')
