import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CardError } from './errors.mjs'

const NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']

const COPYLEFT = /GNU GENERAL PUBLIC LICENSE|GNU AFFERO|GNU LESSER GENERAL PUBLIC|Mozilla Public License|Commons Clause/i

/** 目录里是否有任一可识别的许可证文件（LICENSE、LICENSE.md 等）。 */
export function hasLicenseFile(dir) {
  return NAMES.some((name) => existsSync(join(dir, name)))
}

export function readLicenseText(dir) {
  for (const name of NAMES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    return readFileSync(file, 'utf8').slice(0, 8000)
  }
  return ''
}

/** 识别可接受的宽松许可证。与其它许可证混在同一份正文里时拒绝。 */
export function classifyLicense(text) {
  const body = String(text || '')
  if (!body.trim() || COPYLEFT.test(body)) return ''
  const mit = /MIT License/i.test(body) || /Permission is hereby granted, free of charge/i.test(body)
  const apache = /Apache License/i.test(body) && /Version 2\.0/i.test(body)
  const bsd = /BSD [23]-Clause/i.test(body) || /Redistribution and use in source and binary forms, with or without/i.test(body)
  const isc = /ISC License/i.test(body) || /Permission to use, copy, modify, and\/or distribute this software/i.test(body)
  const kinds = [mit && 'MIT', apache && 'Apache-2.0', bsd && 'BSD', isc && 'ISC'].filter(Boolean)
  if (kinds.length !== 1) return ''
  if (/All Rights Reserved/i.test(body) && kinds[0] !== 'MIT') return ''
  return kinds[0]
}

export function assertAcceptableLicense(dir, expected) {
  const text = readLicenseText(dir)
  const kind = classifyLicense(text)
  if (!kind) throw new CardError('该目录的 LICENSE 不是可接受的宽松许可证（MIT、BSD、ISC、Apache-2.0），已拒绝装载')
  if (expected && kind !== expected) throw new CardError(`该目录的许可证是 ${kind}，与要求的 ${expected} 不一致，已拒绝装载`)
  return text
}
