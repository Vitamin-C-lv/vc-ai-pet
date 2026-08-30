import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFile(join(root, path), 'utf8');
const [engine, sprites, overlay, adapter, css, pkg] = await Promise.all([
  read('src/core/pet-state-engine.js'),
  read('src/client/sprite-catalog.js'),
  read('src/client/pet-overlay.js'),
  read('src/dsh/client-plugin.js'),
  read('src/client/pet.css'),
  read('package.json')
]);

const engineBody = engine
  .replace('export const DEFAULT_STATE', 'const DEFAULT_STATE')
  .replaceAll('export function ', 'function ');
const spriteBody = sprites.replace('export const SPRITES', 'const SPRITES');
const overlayBody = overlay
  .replace("import React from'react';import{advanceState,createInitialState,interact,chooseVisual}from'../core/pet-state-engine.js';import{SPRITES}from'./sprite-catalog.js';", '')
  .replace('export function createPetOverlay', 'function createPetOverlay');
const adapterBody = adapter
  .replace("import { createPetOverlay } from '../client/pet-overlay.js';", '')
  .replace('export const inject', 'const inject')
  .replace('export function apply', 'function apply')
  .replace('__VC_AI_PET_CSS__', JSON.stringify(css));

const bundle = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(JSON.parse(pkg).name)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n    var React = require("react");\n${indent(engineBody)}\n${indent(spriteBody)}\n${indent(overlayBody)}\n${indent(adapterBody)}\n    exports.inject = inject;\n    exports.apply = apply;\n    return module.exports;\n  }\n});\n`;

await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib/client.js'), bundle, 'utf8');
console.log(`built lib/client.js (${bundle.length} bytes)`);

function indent(source) {
  return source.split('\n').map((line) => line ? `    ${line}` : '').join('\n');
}
