/**
 * 日历工具。render 只给模型文字；卡片走 presentationMeta.mm，kind 为 calendar。
 * 天气预报走 Open-Meteo，不读取高德 Key。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { CalendarError } from './day.mjs'
import { buildMonth } from './month.mjs'
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
 * @param {{ getConfig?: () => object }} options
 */
export function createCalendarTools(options = {}) {
  const getConfig = options.getConfig
  const dir = options.dir

  const show = defineTool({
    name: 'calendar_show',
    description: 'Show a month view with the Gregorian and Chinese lunar calendars, solar terms, China statutory holidays and make-up workdays, saved events, and the weather forecast. Defaults to the current month (Asia/Shanghai). Posts a calendar card in the chat; if the session is on Telegram, the channel also sends the same month as a separate message, so the reply need not paste the whole month table. Weather comes from Open-Meteo using the calendar city in settings, queried for the longest range the API provides; without a city, the calendar and events are still returned. Does not use Amap (高德) and does not read environment variables.',
    parameters: {
      month: { type: 'string', description: 'Month as YYYY-MM. Leave empty for the current month (Asia/Shanghai).' },
      city: { type: 'string', description: 'Optional. Overrides the weather forecast city from settings, e.g. Chengdu or 成都. Leave empty to use the city in settings.' },
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
        },
      },
      render: (_args, value) => textBlock(value),
      presentationMeta: (_args, value) => ({
        title: value.title,
        month: value.month,
        mm: mmCalendarBlock(value),
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const cfg = runtimeConfig(getConfig)
      return buildMonth(asText(args.month), {
        now: new Date(),
        dir,
        city: asText(args.city) || cfg.city,
        fetchImpl: options.fetchImpl,
      })
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
