function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

export function isAllowedLanAddress(address) {
  const value = String(address ?? '').replace(/^::ffff:/iu, '')
  return value === '127.0.0.1' || value === '::1' || isPrivateIPv4(value)
}
