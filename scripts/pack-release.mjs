/**
 * 从当前目录打一个发布 tarball。
 * 发布清单里去掉 scripts：仓库里的 prepare 只服务 Git 安装，打进包会指向不存在的 scripts/prepare.mjs。
 * 不在这个脚本里重新构建；调用方先在候选树上 npm run build。
 * --broker-asset <exe> 只改暂存目录里的清单，把这次 exe 的字节数和哈希写进去。
 * 不传时清单保持仓库里的无哈希模板，安装会拒绝下载。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeHashedManifest } from './stage-broker-asset.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFlag = process.argv.indexOf('--out')
const outDir = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : join(root, 'release-artifacts'))
const assetFlag = process.argv.indexOf('--broker-asset')
const brokerAsset = assetFlag >= 0 ? resolve(process.argv[assetFlag + 1] || '') : null

function npm(args, cwd) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: process.env })
}

const dry = npm(['pack', '--dry-run', '--json', '--ignore-scripts'], root)
if (dry.status !== 0) {
  console.error(dry.stderr || dry.stdout)
  process.exit(dry.status || 1)
}
const listed = JSON.parse(dry.stdout.slice(dry.stdout.search(/[[{]/)))
const entry = Array.isArray(listed) ? listed[0] : listed
const files = (entry.files || []).map((file) => file.path)
if (!files.length) {
  console.error('npm pack --dry-run returned no files')
  process.exit(1)
}

const stage = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
try {
  for (const rel of files) {
    const from = join(root, rel)
    const to = join(stage, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
  const pkgPath = join(stage, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  delete pkg.scripts
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  const manifestRel = join('src', 'components', 'desktop', 'broker-manifest.json')
  if (brokerAsset) {
    await writeHashedManifest({
      exe: brokerAsset,
      templatePath: join(root, manifestRel),
      outPath: join(stage, manifestRel),
      version: pkg.version,
    })
    console.log(`broker manifest bound to ${brokerAsset}`)
  } else {
    console.log('broker manifest left as the unhashed template')
  }
  mkdirSync(outDir, { recursive: true })
  const packed = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', outDir], stage)
  if (packed.status !== 0) {
    console.error(packed.stderr || packed.stdout)
    process.exit(packed.status || 1)
  }
  const result = JSON.parse(packed.stdout.slice(packed.stdout.search(/[[{]/)))
  const filename = (Array.isArray(result) ? result[0] : result).filename
  const tgz = join(outDir, filename)
  writeFileSync(join(outDir, 'tgz-path.txt'), tgz + '\n')
  console.log(`packed ${files.length} paths from ${relative(root, stage) || stage}`)
  console.log(`TGZ ${tgz}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
