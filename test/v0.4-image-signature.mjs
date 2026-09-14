import assert from 'node:assert/strict'

import { imageSignatureOf } from '../src/runtime/pet-runtime.js'

/**
 * Image signature validation — the gate that keeps a corrupt asset from being
 * handed to the model.
 *
 * The store builds a data URL from the recorded mime type plus whatever bytes
 * are currently on disk, so the two can disagree after truncation or corruption.
 * These cases drive the validator directly, which is the only way to test a
 * mismatched mime/bytes pair (the upload path derives the mime from the bytes).
 */

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01])
const webp = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([0x56, 0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00]),
])
const garbage = Buffer.from('this is definitely not an image file')
const tiny = Buffer.from('tiny')

const url = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`

const cases = [
  ['PNG_VALID', url('image/png', png), true, null],
  ['JPEG_VALID', url('image/jpeg', jpeg), true, null],
  ['WEBP_VALID', url('image/webp', webp), true, null],
  ['PNG_MIME_JPEG_BYTES', url('image/png', jpeg), false, 'signature-mismatch'],
  ['JPEG_MIME_PNG_BYTES', url('image/jpeg', png), false, 'signature-mismatch'],
  ['WEBP_MIME_PNG_BYTES', url('image/webp', png), false, 'not-webp'],
  ['WEBP_MIME_JPEG_BYTES', url('image/webp', jpeg), false, 'not-webp'],
  ['PNG_MIME_TEXT', url('image/png', garbage), false, 'signature-mismatch'],
  ['JPEG_MIME_TEXT', url('image/jpeg', garbage), false, 'signature-mismatch'],
  ['TINY_PNG', url('image/png', tiny), false, 'file-too-small'],
  ['EMPTY_PNG', url('image/png', Buffer.alloc(0)), false, 'data-url-malformed'],
  ['MALFORMED_URL', 'data:image/png;base64,@@@not-base64@@@', false, 'data-url-malformed'],
  ['NO_PREFIX', png.toString('base64'), false, 'data-url-malformed'],
  ['UNSUPPORTED_MIME', url('image/gif', png), false, 'data-url-malformed'],
  ['EMPTY_INPUT', '', false, 'data-url-malformed'],
  ['NULL_INPUT', null, false, 'data-url-malformed'],
  ['UNDEFINED_INPUT', undefined, false, 'data-url-malformed'],
]

for (const [label, input, expectedOk, expectedReason] of cases) {
  const result = imageSignatureOf(input)
  assert.equal(result.ok, expectedOk, `${label}: ok=${result.ok} (${result.reason})`)
  if (!expectedOk) assert.equal(result.reason, expectedReason, `${label}: reason=${result.reason}`)
}

console.log(`SIGNATURE_MATRIX=PASS cases=${cases.length}`)
console.log('VC_AI_PET_V0_4_IMAGE_SIGNATURE=PASS')
