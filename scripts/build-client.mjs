import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path) => readFile(join(root, path), 'utf8')
const [engine, sprites, visualState, environment, spriteMap, animation, overlay, adapter, css, pkg] = await Promise.all([
  read('src/core/pet-state-engine.js'),
  read('src/client/sprite-catalog.js'),
  read('src/client/pet-visual-state.js'),
  read('src/client/pet-environment.js'),
  read('src/client/pet-sprite-map.js'),
  read('src/client/pet-animation.js'),
  read('src/client/pet-overlay.js'),
  read('src/dsh/client-plugin.js'),
  read('src/client/pet.css'),
  read('package.json'),
])

const engineBody = engine
  .replace('export const DEFAULT_STATE', 'const DEFAULT_STATE')
  .replaceAll('export function ', 'function ')
const spriteBody = sprites.replace('export const SPRITES', 'const SPRITES')
const stripImports = (source) => source.replace(/^import[^\n]*\n/gm, '')
const visualStateBody = stripImports(visualState).replaceAll('export ', '')
const environmentBody = stripImports(environment).replaceAll('export ', '')
const spriteMapBody = stripImports(spriteMap).replaceAll('export ', '')
const animationBody = stripImports(animation).replaceAll('export ', '')
const overlayBody = stripImports(overlay).replace('export function createPetOverlay', 'function createPetOverlay')
const adapterBody = stripImports(adapter)
  .replace('export const inject', 'const inject')
  .replace('export function apply', 'function apply')
  .replace('__VC_AI_PET_CSS__', JSON.stringify(css))

const bundle = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(JSON.parse(pkg).name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    var React = require("react");',
  indent(engineBody),
  indent(spriteBody),
  indent(visualStateBody),
  indent(environmentBody),
  indent(spriteMapBody),
  indent(animationBody),
  indent(overlayBody),
  indent(adapterBody),
  '    exports.inject = inject;',
  '    exports.apply = apply;',
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib/client.js'), bundle, 'utf8')
console.log(`built lib/client.js (${bundle.length} bytes)`)

function indent(source) {
  return source.split('\n').map((line) => line ? `    ${line}` : '').join('\n')
}
