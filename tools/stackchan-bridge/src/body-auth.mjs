import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const HEADER = 'x-lihuahua-body-key'

export async function loadBodyKey(path) {
  if (!path) return null
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value.length >= 32 ? value : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function bodyKeyHeaderName() { return HEADER }

export function hasValidBodyKey(req, expected) {
  if (!expected) return true
  const supplied = req?.headers?.[HEADER]
  if (typeof supplied !== 'string') return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
