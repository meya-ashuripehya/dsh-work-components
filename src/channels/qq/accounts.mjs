/** QQ v1：单账号 main；多 bot 以后再说。保持 accountId=main 以复用 ~/.dsh/dsh-channels/bindings.json 既有 qq:main:* 绑定。 */
export const MAIN_ACCOUNT = 'main'
export const DEFAULT_SECRET_REF = 'QQBOT_APP_SECRET'
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function secretRefOf(cfg) {
  const ref = String(cfg?.qqAppSecretRef || DEFAULT_SECRET_REF).trim()
  return REF_PATTERN.test(ref) ? ref : DEFAULT_SECRET_REF
}

export function accountRouteOf(cfg) {
  const preset = String(cfg?.qqPreset || '').trim()
  return preset ? { preset } : null
}
