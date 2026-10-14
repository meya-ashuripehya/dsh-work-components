/**
 * GPT Image 2 生图工具：image_generate / image_edit。
 * - 生成的图片只写入插件数据目录 images/<YYYY-MM-DD>/（上海时区日期），不改动其它位置。
 * - 返回值是纯 JSON（文件路径、尺寸、字节数、attachmentId），图片本身经 attachments.saveImage
 *   交给宿主，render 里以 image 块（ImageContent）发给模型并显示在对话中。
 * - API Key 不进参数、不进返回值、不进日志。
 * - Telegram 授权闸门：两个工具都不在 OPEN_TOOLS 中，只有授权用户（所有者）触发的回合可用。
 *   image_edit 会读取本机任意路径的图片并上传到第三方；image_generate 会消耗 API 额度并写盘。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { imageSize } from 'image-size'
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import {
  BACKGROUND_OPTIONS,
  GptImageError,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  MAX_N,
  QUALITY_OPTIONS,
  editImages,
  generateImages,
  sniffImage,
} from './client.mjs'

const IMAGE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    attachmentId: { type: 'string' },
    // 宿主 saveImage 返回的原样引用。宿主可能把大图转码（如 3MB PNG → JPEG），
    // 读取时会逐项核对 mediaType / bytes / width / height，所以显示用的 image 块必须用它。
    attachment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    revisedPrompt: { type: 'string' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', required: true },
    size: { type: 'string', required: true },
    quality: { type: 'string', required: true },
    background: { type: 'string' },
    count: { type: 'integer', required: true },
    directory: { type: 'string', required: true },
    images: { type: 'array', required: true, items: IMAGE_ITEM_SCHEMA },
    usage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inputTokens: { type: 'integer' },
        outputTokens: { type: 'integer' },
        totalTokens: { type: 'integer' },
      },
    },
  },
}

const COMMON_PARAMS = {
  size: { type: 'string', description: 'Image size: "auto", "1024x1024", "1536x1024" (landscape) or "1024x1536" (portrait). Other WxH values are passed through if the model supports them. Defaults to the settings value.' },
  quality: { type: 'string', enum: QUALITY_OPTIONS, description: 'Rendering quality. Higher quality costs more and takes longer. Defaults to the settings value.' },
  n: { type: 'integer', description: `Number of images, 1-${MAX_N}. Default 1. Each image is billed.` },
  background: { type: 'string', enum: BACKGROUND_OPTIONS, description: 'Background: "transparent" for a PNG with alpha, "opaque", or "auto" (default).' },
}

const INPUT_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** 上海时区的 YYYY-MM-DD 与 HHmmss。 */
export function shanghaiStamp(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}${parts.minute}${parts.second}` }
}

function dims(buf) {
  try {
    const d = imageSize(buf)
    return { width: Number(d.width) || 0, height: Number(d.height) || 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

/** 读取一张本地输入图（image_edit 用），做扩展名、大小与格式校验。 */
export function loadInputImage(raw, label = '输入图片') {
  const p = String(raw ?? '').trim()
  if (!p) throw new GptImageError(`${label}路径为空。`)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) throw new GptImageError(`${label}须为本地文件路径，不支持网址：${p}`)
  const full = resolve(p)
  const mediaType = INPUT_EXT[extname(full).toLowerCase()]
  if (!mediaType) throw new GptImageError(`${label}仅支持 png / jpg / jpeg / webp：${full}`)
  let st
  try { st = statSync(full) } catch { throw new GptImageError(`${label}不存在或无法读取：${full}`) }
  if (!st.isFile()) throw new GptImageError(`${label}不是文件：${full}`)
  if (st.size > MAX_INPUT_IMAGE_BYTES) throw new GptImageError(`${label}过大（${st.size} 字节，上限 ${MAX_INPUT_IMAGE_BYTES} 字节）：${full}`)
  const data = readFileSync(full)
  const kind = sniffImage(data)
  if (!kind) throw new GptImageError(`${label}内容不是有效的 PNG / JPEG / WebP 图片：${full}`)
  return { data, mediaType: kind.mediaType, name: basename(full), full }
}

/** 显示用附件引用：优先宿主原样返回的 ref（与附件库存储一致），否则退回文件自身信息。 */
export function attachmentRefOf(img) {
  if (!img || !img.attachmentId) return null
  const a = img.attachment && img.attachment.attachmentId === img.attachmentId ? img.attachment : null
  return {
    attachmentId: img.attachmentId,
    mediaType: a ? a.mediaType : img.mediaType,
    bytes: a ? a.bytes : img.bytes,
    width: a ? a.width : img.width,
    height: a ? a.height : img.height,
    name: basename(img.path),
  }
}

function renderValue(label) {
  return (_args, value) => {
    const blocks = [{ type: 'text', text: label + JSON.stringify(value) }]
    for (const img of value.images) {
      const ref = attachmentRefOf(img)
      if (!ref) continue
      blocks.push({ type: 'image', attachment: ref })
    }
    return blocks
  }
}

function presentationMeta(_args, value) {
  const first = value.images.find((i) => i.attachmentId)
  if (!first) return { paths: value.images.map((i) => i.path) }
  const caption = `${value.model} · ${first.width}x${first.height}` + (value.images.length > 1 ? ` · 共 ${value.images.length} 张` : '')
  return {
    paths: value.images.map((i) => i.path),
    title: 'GPT Image 2 生图',
    caption,
    mm: {
      type: 'mm', kind: 'image', status: 'ready', title: 'GPT Image 2 生图', caption,
      asset: { attachment: attachmentRefOf(first) },
    },
  }
}

/**
 * @param {{ getSettings: () => { apiKey, baseUrl, model, size, quality, timeoutSec },
 *           getAttachments?: () => any, imagesRoot: () => string, fetchImpl?: Function, now?: () => Date }} deps
 */
export function createGptImageTools({ getSettings, getAttachments, imagesRoot, fetchImpl, now = () => new Date() }) {
  async function persist(result) {
    const { date, time } = shanghaiStamp(now())
    const dir = join(imagesRoot(), date)
    mkdirSync(dir, { recursive: true })
    const tag = randomBytes(3).toString('hex')
    const attachments = getAttachments?.()
    const images = []
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i]
      const file = join(dir, `${time}-${tag}-${i + 1}${img.ext}`)
      writeFileSync(file, img.data)
      const d = dims(img.data)
      const item = { path: file, mediaType: img.mediaType, bytes: img.data.length, width: d.width, height: d.height }
      if (attachments?.saveImage) {
        const ref = await attachments.saveImage({ data: img.data, mediaType: img.mediaType, name: basename(file) })
        item.attachmentId = String(ref.attachmentId)
        // 宿主可能转码/缩放；记下它的原样引用，显示与读取都以此为准（文件本身仍是原图）。
        item.attachment = {
          attachmentId: item.attachmentId,
          mediaType: String(ref.mediaType || img.mediaType),
          bytes: Number(ref.bytes) || img.data.length,
          width: Number(ref.width) || d.width,
          height: Number(ref.height) || d.height,
        }
      }
      if (img.revisedPrompt) item.revisedPrompt = img.revisedPrompt
      images.push(item)
    }
    return {
      model: result.model,
      size: result.size,
      quality: result.quality,
      ...(result.background ? { background: result.background } : {}),
      count: images.length,
      directory: dir,
      images,
      ...(result.usage ? { usage: result.usage } : {}),
    }
  }

  function common() {
    const s = getSettings() || {}
    const timeoutSec = Number(s.timeoutSec) > 0 ? Number(s.timeoutSec) : 300
    return {
      baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model,
      defaults: { size: s.size, quality: s.quality },
      timeoutMs: timeoutSec * 1000,
      fetchImpl,
    }
  }

  const generate = defineTool({
    name: 'image_generate',
    description: 'Generate images from a text prompt with the configured GPT Image model (OpenAI-compatible POST /images/generations). Each image is billed by the provider. Images are saved as files under the plugin data folder images/<date>/ and shown in the chat; the result lists the saved file paths. Only writes into the plugin data folder.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed description of the image to generate (any language).' },
      ...COMMON_PARAMS,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue('已生成图片：'), presentationMeta },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await generateImages({ ...common(), args })
      return persist(result)
    },
  })

  const edit = defineTool({
    name: 'image_edit',
    description: `Edit or combine existing local images with the configured GPT Image model (OpenAI-compatible POST /images/edits, multipart). Pass 1-${MAX_INPUT_IMAGES} local png/jpg/webp paths (each up to 50MB) and a prompt describing the change; optionally a PNG mask whose transparent area marks where to edit. The input files are uploaded to the provider. Results are saved under the plugin data folder images/<date>/ and shown in the chat. Billed by the provider.`,
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to change or produce from the input images.' },
      images: { type: 'array', required: true, items: { type: 'string' }, description: `Local image file paths (png/jpg/jpeg/webp), 1-${MAX_INPUT_IMAGES}. Not URLs.` },
      mask: { type: 'string', description: 'Optional local PNG mask path; transparent pixels mark the area to edit. Applies to the first image.' },
      ...COMMON_PARAMS,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue('已编辑图片：'), presentationMeta },
    isConcurrencySafe: () => true,
    async execute(args) {
      const list = Array.isArray(args.images) ? args.images : (args.images ? [args.images] : [])
      if (!list.length) throw new GptImageError('images 至少需要一张本地图片路径。')
      if (list.length > MAX_INPUT_IMAGES) throw new GptImageError(`images 最多 ${MAX_INPUT_IMAGES} 张。`)
      const inputs = list.map((p, i) => loadInputImage(p, `第 ${i + 1} 张输入图片`))
      let mask
      if (args.mask) {
        mask = loadInputImage(args.mask, '蒙版图片')
        if (mask.mediaType !== 'image/png') throw new GptImageError('蒙版图片须为 PNG（透明区域表示要编辑的位置）。')
      }
      const result = await editImages({ ...common(), args, inputs, mask })
      return persist(result)
    },
  })

  return [generate, edit]
}
