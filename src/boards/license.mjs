import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError } from './errors.mjs'

const NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']

export function readLicenseText(dir) {
  for (const name of NAMES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    return readFileSync(file, 'utf8').slice(0, 8000)
  }
  return ''
}

/** 只接受 MIT。正文里同时出现别的许可证标题时拒绝。 */
export function isMitLicense(text) {
  const body = String(text || '')
  if (!/MIT License/i.test(body) && !/Permission is hereby granted, free of charge/i.test(body)) return false
  if (/GNU GENERAL PUBLIC LICENSE|Apache License|Mozilla Public License|BSD License|All Rights Reserved/i.test(body)) return false
  return true
}

export function assertMitLicense(dir) {
  const text = readLicenseText(dir)
  if (!isMitLicense(text)) {
    throw new BoardError('该目录的 LICENSE 不是 MIT，已拒绝装载')
  }
  return text
}
