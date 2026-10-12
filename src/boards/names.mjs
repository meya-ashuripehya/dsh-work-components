/** 设置里的用户名。空白时用 user。 */
export function playerName(value) {
  const name = String(value ?? '').trim()
  return name || 'user'
}

/** 人落子后写进输入框的那一句。 */
export function humanMovePrompt(name, notation) {
  return `${playerName(name)}下在了${notation},现在是你的回合`
}
