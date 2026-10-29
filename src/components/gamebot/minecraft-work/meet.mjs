/** 双向会合合成一个点和两个相邻落点。到达后对方再挪一格不再追。 */
export function mergeMeets(a, b) {
  if (a.target !== b.member || b.target !== a.member) return { ok: false, error: '不是双向会合' }
  const x = Math.floor((a.pos.x + b.pos.x) / 2)
  const y = Math.min(a.pos.y, b.pos.y)
  const z = Math.floor((a.pos.z + b.pos.z) / 2)
  return {
    ok: true,
    point: { x, y, z },
    stands: [{ x, y, z }, { x: x + 1, y, z }],
  }
}

export function shouldChase(arrived, shift) {
  if (!arrived) return true
  const span = Math.abs(shift.x || 0) + Math.abs(shift.y || 0) + Math.abs(shift.z || 0)
  return span > 1
}
