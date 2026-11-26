/**
 * 用一次构建出的经纪人 exe 填写清单。只写调用方给出的输出路径，不改仓库里的模板。
 *
 *   node scripts/stage-broker-asset.mjs --exe <DSHDesktopBroker.exe> --out <broker-manifest.json>
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_ASSET_NAME = 'DSHDesktopBroker-win-x64.exe'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

export function digestFile(file) {
  return new Promise((ok, fail) => {
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    const stream = createReadStream(file)
    stream.on('error', fail)
    stream.on('data', (chunk) => {
      sha256.update(chunk)
      sha512.update(chunk)
    })
    stream.on('end', () => ok({
      bytes: statSync(file).size,
      sha256: sha256.digest('hex'),
      sha512: sha512.digest('hex'),
    }))
  })
}

export function fillManifest(template, digest, version = template.version) {
  const asset = template?.assets?.['win32-x64']
  if (!asset?.url) throw new Error('经纪人模板缺少 win32-x64.url')
  const url = new URL(asset.url)
  if (url.protocol !== 'https:') throw new Error('经纪人模板地址必须是 HTTPS')
  if (!url.pathname.endsWith('/' + RELEASE_ASSET_NAME)) throw new Error('经纪人模板地址文件名不对')
  if (!url.pathname.includes(`/v${version}/`)) throw new Error(`经纪人模板地址没有版本 v${version}`)
  return {
    ...template,
    version,
    status: 'ready',
    note: `Hashes are of ${RELEASE_ASSET_NAME} built in the same pack as this manifest (${digest.bytes} bytes).`,
    assets: {
      ...template.assets,
      'win32-x64': {
        ...asset,
        file: RELEASE_ASSET_NAME,
        bytes: digest.bytes,
        sha256: digest.sha256,
        sha512: digest.sha512,
      },
    },
  }
}

export async function writeHashedManifest({ exe, templatePath, outPath, version }) {
  if (!existsSync(exe)) throw new Error(`经纪人 exe 不存在：${exe}`)
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  const manifest = fillManifest(template, await digestFile(exe), version || template.version)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirect) {
  const exe = argValue('--exe')
  const outPath = argValue('--out')
  const templatePath = argValue('--template') || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'desktop', 'broker-manifest.json')
  if (!exe || !outPath) {
    console.error('usage: node scripts/stage-broker-asset.mjs --exe <file> --out <manifest.json>')
    process.exit(1)
  }
  const manifest = await writeHashedManifest({ exe: resolve(exe), templatePath, outPath: resolve(outPath), version: argValue('--version') || undefined })
  console.log(`staged broker manifest bytes=${manifest.assets['win32-x64'].bytes} sha256=${manifest.assets['win32-x64'].sha256}`)
}
