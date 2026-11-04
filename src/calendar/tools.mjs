/**
 * 日历工具。render 给模型文字；卡片走 presentationMeta.mm（kind=calendar）。
 * QQ：tools 侧 resolveChannelId，能力打开时渲 PNG → attachments.saveImage → content image，
 * 由 harness deliverTurnImages 出站。Telegram 仍只靠 installCalendarDelivery 的 HTML，不加 image。
 * 天气预报走 Open-Meteo，不读取高德 Key。平台名不进模型可见描述。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { resolveChannelId, capabilitiesFor } from '../channels/surface.mjs'
import { CalendarError } from './day.mjs'
import { buildMonth } from './month.mjs'
import { renderCalendarPng, pngSize } from './render.mjs'
import { deleteEvent, saveEvent } from './store.mjs'

function textBlock(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function asText(value) {
  return String(value ?? '').trim()
}

function runtimeConfig(getConfig) {
  const cfg = (typeof getConfig === 'function' ? getConfig() : null) || {}
  return {
    city: asText(cfg.calendarCity),
  }
}

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    date: { type: 'string', required: true },
    endDate: { type: 'string' },
    time: { type: 'string' },
    endTime: { type: 'string' },
    allDay: { type: 'boolean', required: true },
    note: { type: 'string' },
  },
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

function imageRef(image, name) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(name ? { name } : {}),
  }
}

function mmCalendarBlock(value) {
  return {
    type: 'mm',
    kind: 'calendar',
    status: 'ready',
    title: value.title,
    calendar: value,
  }
}

/**
 * @param {{
 *   getConfig?: () => object,
 *   dir?: string,
 *   fetchImpl?: typeof fetch,
 *   getAttachments?: () => any,
 * }} options
 */
export function createCalendarTools(options = {}) {
  const getConfig = options.getConfig
  const dir = options.dir
  const getAttachments = options.getAttachments

  const show = defineTool({
    name: 'calendar_show',
    description: 'Show a month view with the Gregorian and Chinese lunar calendars, solar terms, China statutory holidays and make-up workdays, saved events, and the weather forecast. Defaults to the current month (Asia/Shanghai). Posts a calendar card in the chat; on channel sessions the runtime may also deliver the month as a separate message, so the reply need not paste the whole month table. Weather comes from Open-Meteo using the calendar city in settings, queried for the longest range the API provides; without a city, the calendar and events are still returned. Does not use Amap (高德) and does not read environment variables.',
    parameters: {
      month: { type: 'string', description: 'Month as YYYY-MM. Defaults to the current month in Asia/Shanghai.' },
      city: { type: 'string', description: 'Override the weather city for this call only. Leave empty to use the calendar city in settings.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          month: { type: 'string', required: true },
          title: { type: 'string', required: true },
          today: { type: 'string', required: true },
          city: { type: 'string', required: true },
          weather: {
            type: 'object',
            additionalProperties: false,
            properties: {
              city: { type: 'string', required: true },
              source: { type: 'string' },
              error: { type: 'string' },
              forecasts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    date: { type: 'string', required: true },
                    week: { type: 'string', required: true },
                    dayWeather: { type: 'string', required: true },
                    nightWeather: { type: 'string', required: true },
                    icon: { type: 'string', required: true },
                    dayTemp: { type: 'string', required: true },
                    nightTemp: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          days: { type: 'array', required: true },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const blocks = textBlock(value)
        if (value.image?.attachmentId) {
          blocks.push({ type: 'image', attachment: imageRef(value.image, value.title || 'calendar.png') })
        }
        return blocks
      },
      presentationMeta: (_args, value) => {
        // Keep page calendar mm free of the channel PNG attachment blob.
        const { image: _image, ...calendar } = value
        return {
          title: value.title,
          month: value.month,
          mm: mmCalendarBlock(calendar),
        }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cfg = runtimeConfig(getConfig)
      const value = await buildMonth(asText(args.month), {
        now: new Date(),
        dir,
        city: asText(args.city) || cfg.city,
        fetchImpl: options.fetchImpl,
      })

      // QQ only: PNG via harness image path. Telegram keeps HTML-only calendar delivery.
      const channelId = resolveChannelId({ sessionId: exec?.agent?.id, exec })
      const caps = capabilitiesFor(channelId)
      if (channelId === 'qq' && caps.calendarCard) {
        const attachments = getAttachments?.()
        if (attachments && typeof attachments.saveImage === 'function') {
          try {
            const { png, width, height } = renderCalendarPng(value)
            const size = pngSize(png)
            const ref = await attachments.saveImage({
              data: png,
              mediaType: 'image/png',
              name: 'calendar.png',
            })
            value.image = {
              attachmentId: String(ref.attachmentId),
              mediaType: String(ref.mediaType || 'image/png'),
              bytes: Number(ref.bytes ?? png.length),
              width: Number(ref.width ?? size.width) || width,
              height: Number(ref.height ?? size.height) || height,
              name: 'calendar.png',
            }
          } catch {
            // Month data still returned; channel just skips the photo if render/save fails.
          }
        }
      }
      return value
    },
  })

  const save = defineTool({
    name: 'calendar_event_save',
    description: 'Create or update an event, saved to the plugin data directory. Pass id to update that event; omit id to create a new one. Dates are YYYY-MM-DD. If time (HH:MM) is given, the event is not all-day.',
    parameters: {
      id: { type: 'string', description: 'ID of the event to update. Leave empty to create a new event.' },
      title: { type: 'string', required: true, description: 'Title, at most 80 characters.' },
      date: { type: 'string', required: true, description: 'Start date, YYYY-MM-DD.' },
      endDate: { type: 'string', description: 'End date, YYYY-MM-DD. Leave empty for a single-day event.' },
      time: { type: 'string', description: 'Start time, HH:MM. Leave empty for an all-day event.' },
      endTime: { type: 'string', description: 'End time, HH:MM.' },
      note: { type: 'string', description: 'Note, at most 500 characters.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { event: EVENT_SCHEMA },
      },
      render: (_args, value) => textBlock(value),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const event = await saveEvent({
          id: asText(args.id),
          title: args.title,
          date: args.date,
          endDate: args.endDate,
          time: args.time,
          endTime: args.endTime,
          note: args.note,
        }, dir)
        return { event }
      } catch (error) {
        if (error instanceof CalendarError) throw error
        throw new CalendarError('保存日程失败')
      }
    },
  })

  const remove = defineTool({
    name: 'calendar_event_delete',
    description: 'Delete a saved event by id. Deletion cannot be undone.',
    parameters: {
      id: { type: 'string', required: true, description: 'Event ID.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return deleteEvent(asText(args.id), dir)
    },
  })

  return [show, save, remove]
}