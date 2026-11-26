/** Stand-in returned for a saved secret. Posting it back means "keep the saved value"; '' clears it. */
export const SECRET_MASK = '__dsh_secret_saved__'

/** Copy of settings safe to send to the browser: saved secrets become SECRET_MASK. */
export function maskSecretFields(value, secretKeys) {
  const out = { ...(value || {}) }
  for (const key of secretKeys || []) {
    if (typeof out[key] === 'string' && out[key] !== '') out[key] = SECRET_MASK
  }
  return out
}
