/**
 * 表情包工具：sticker_search / sticker_save / sticker_send。
 * 描述与参数名为英文；门闸：search/send ∈ OPEN_TOOLS，save 仅授权用户。
 * sticker_send 走与 mm_send_image 相同的 attachments.saveImage + image 块路径，
 * 以便 harness deliverTurnImages 在 QQ/Telegram 通道出站。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import {
  LIMITS,
  StickersError,
  loadLocalImage,
  readStickerBytes,
  resolveSendTarget,
  saveSticker,
  searchStickers,
  takeLatestRecent,
} from './store.mjs'

const OUTPUT_JSON = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function asText(value) {
  return String(value ?? '').trim()
}

function callerSessionId(exec) {
  return String(exec?.agent?.id || exec?.sessionId || '').trim()
}

function isAttachmentId(raw) {
  const s = asText(raw)
  return /^#?a[\w-]+$/i.test(s) || /^att_/i.test(s)
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

function imageRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

function mmImageBlock(image, opts = {}) {
  return {
    type: 'mm',
    kind: 'image',
    status: opts.status || 'ready',
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.caption === undefined ? {} : { caption: opts.caption }),
    asset: { attachment: imageRef(image) },
  }
}

/**
 * @param {{
 *   dir?: string,
 *   getAttachments?: () => any,
 *   getDefaultPackId?: () => string,
 * }} options
 */
export function createStickersTools(options = {}) {
  const dir = options.dir
  const getAttachments = options.getAttachments || (() => null)
  const getDefaultPackId = options.getDefaultPackId || (() => '')

  const searchTool = defineTool({
    name: 'sticker_search',
    description: 'Search the local sticker library by tag, alias, pack name, emoji, or free text. Returns id, pack, tags, aliases, path, and dimensions. Does not send anything. Prefer this before sticker_send when unsure which id to use.',
    parameters: {
      query: { type: 'string', description: 'Optional keywords; whitespace = AND; matches tags/aliases/pack/emoji/id.' },
      pack: { type: 'string', description: 'Optional pack id or pack name filter.' },
      tag: { type: 'string', description: 'Optional exact tag filter.' },
      limit: { type: 'integer', description: 'Max results, default 10, max 30.' },
    },
    output: OUTPUT_JSON,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        return await searchStickers({
          query: asText(args.query),
          pack: asText(args.pack),
          tag: asText(args.tag),
          limit: args.limit,
        }, dir)
      } catch (error) {
        if (error instanceof StickersError) throw error
        throw new StickersError('sticker_search failed')
      }
    },
  })

  const saveTool = defineTool({
    name: 'sticker_save',
    description: 'Save an image into the local sticker library. Source is either an absolute local path, or omit source to use the most recent inbound image in this session (if any). Optional tags/aliases/pack/emoji. Owner-authorized turns only on channels. Does not fetch remote URLs. Chatroom attachment ids (#a…) are not supported in this version — use a local path.',
    parameters: {
      source: { type: 'string', description: 'Absolute local image path; omit to use the most recent inbound image for this session.' },
      pack: { type: 'string', description: 'Pack id or name; default pack if omitted.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags, at most ' + LIMITS.tags + '.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Optional aliases, at most ' + LIMITS.aliases + '.' },
      emoji: { type: 'string', description: 'Optional emoji label.' },
    },
    output: OUTPUT_JSON,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const source = asText(args.source)
        const pack = asText(args.pack) || asText(getDefaultPackId())
        if (source && isAttachmentId(source)) {
          throw new StickersError('Chatroom attachment ids are not supported yet; pass an absolute local path or omit source for recent inbound')
        }
        let input
        if (source) {
          const loaded = loadLocalImage(source)
          input = {
            data: loaded.data,
            mediaType: loaded.mediaType,
            originalName: loaded.name,
            pack,
            tags: args.tags,
            aliases: args.aliases,
            emoji: args.emoji,
            source: { channel: 'desktop', originalName: loaded.name },
          }
        } else {
          const recent = await takeLatestRecent(callerSessionId(exec), dir)
          input = {
            data: recent.data,
            mediaType: recent.mediaType,
            originalName: recent.originalName,
            pack,
            tags: args.tags,
            aliases: args.aliases,
            emoji: args.emoji,
            source: recent.source,
          }
        }
        const result = await saveSticker(input, dir)
        return {
          id: result.sticker.id,
          packId: result.sticker.packId,
          path: result.sticker.path,
          hash: result.sticker.hash,
          deduped: result.deduped,
          tags: result.sticker.tags,
          aliases: result.sticker.aliases,
        }
      } catch (error) {
        if (error instanceof StickersError) throw error
        throw new StickersError(String(error?.message || 'sticker_save failed'))
      }
    },
  })

  const sendTool = defineTool({
    name: 'sticker_send',
    description: 'Send a sticker from the local library to the current conversation surface. Resolve by id (preferred), alias, or (if unique) tag. On QQ/Telegram channel sessions this is delivered as an image (not a native Telegram sticker). On desktop it appears as an image card. Prefer sticker_search first when unsure which id to use. If alias/tag matches multiple stickers, nothing is sent — search first.',
    parameters: {
      id: { type: 'string', description: 'Sticker id (preferred).' },
      alias: { type: 'string', description: 'Exact alias; if multiple stickers share it, search first.' },
      tag: { type: 'string', description: 'Tag only if exactly one sticker matches.' },
      caption: { type: 'string', description: 'Optional caption where the surface supports it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          id: { type: 'string' },
          path: { type: 'string' },
          surface: { type: 'string' },
          note: { type: 'string' },
          candidates: { type: 'array' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => {
        if (!value.delivered) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        }
        const title = value.id || value.path || 'sticker'
        const dims = value.image
          ? (value.image.mediaType + ', ' + value.image.width + 'x' + value.image.height + ' px, ' + value.image.bytes + ' bytes.')
          : ''
        const blocks = [{
          type: 'text',
          text: 'Sent sticker "' + title + '"' + (dims ? (': ' + dims) : '') + (value.note ? (' ' + value.note) : ''),
        }]
        if (value.image?.attachmentId) {
          blocks.push({ type: 'image', attachment: imageRef(value.image) })
        }
        return blocks
      },
      presentationMeta: (_args, value) => {
        if (!value.delivered || !value.image) return { delivered: false }
        const title = value.id || value.image.name || 'sticker'
        const caption = value.caption
          || (value.image.mediaType + ', ' + value.image.width + 'x' + value.image.height + ' px')
        return {
          id: value.id,
          path: value.path,
          surface: value.surface,
          title,
          ...(value.caption ? { caption: value.caption } : {}),
          mm: mmImageBlock(value.image, { status: 'ready', title, caption }),
        }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const resolved = await resolveSendTarget({
          id: asText(args.id),
          alias: asText(args.alias),
          tag: asText(args.tag),
        }, dir)
        if (!resolved.ok) {
          return {
            delivered: false,
            note: resolved.reason === 'ambiguous_alias'
              ? 'Multiple stickers share this alias; call sticker_search and send by id.'
              : 'Multiple stickers share this tag; call sticker_search and send by id.',
            candidates: (resolved.candidates || []).map((s) => ({
              id: s.id,
              packName: s.packName,
              tags: s.tags,
              aliases: s.aliases,
              emoji: s.emoji,
            })),
          }
        }
        const { sticker, data } = await readStickerBytes(resolved.sticker.id, dir)
        const attachments = getAttachments()
        if (!attachments || typeof attachments.saveImage !== 'function') {
          throw new StickersError('no attachment service is mounted', 500)
        }
        const name = basename(sticker.file) || (sticker.id + '.webp')
        const ref = await attachments.saveImage({
          data,
          mediaType: sticker.mediaType,
          name,
        })
        const width = Number(ref.width ?? sticker.width ?? 0) || 0
        const height = Number(ref.height ?? sticker.height ?? 0) || 0
        const captionRaw = asText(args.caption)
        return {
          delivered: true,
          id: sticker.id,
          path: sticker.path,
          surface: 'desktop',
          note: 'Delivered as image (MmCard / channel photo). Native Telegram stickers are not used in v1.',
          ...(captionRaw ? { caption: captionRaw } : {}),
          image: {
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType || sticker.mediaType,
            bytes: ref.bytes ?? data.length,
            width,
            height,
            name: ref.name || name,
          },
        }
      } catch (error) {
        if (error instanceof StickersError) throw error
        throw new StickersError(String(error?.message || 'sticker_send failed'))
      }
    },
  })

  return [searchTool, saveTool, sendTool]
}

export { StickersError, loadLocalImage, readFileSync }
