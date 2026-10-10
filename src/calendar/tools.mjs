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
    description: '查看某月的公历、农历、节气、中国法定节假日与调休、已保存的日程，以及最多 4 天的天气预报。默认本月（上海时区）。会在对话里发出日历卡片。天气来自 Open-Meteo，使用设置里的日历城市名；未填写城市时仍返回历法与日程。不使用高德，也不读取环境变量。',
    parameters: {
      month: { type: 'string', description: '月份，YYYY-MM。留空为本月（Asia/Shanghai）。' },
      city: { type: 'string', description: '可选。覆盖设置中的天气预报城市名，例如成都。留空用设置里的城市。' },
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
    description: '新建或修改一条日程，写入插件数据目录。传入 id 则修改该条；不传 id 则新建。日期为 YYYY-MM-DD。有 time（HH:MM）则为非全天日程。',
    parameters: {
      id: { type: 'string', description: '要修改的日程 id。留空则新建。' },
      title: { type: 'string', required: true, description: '标题，不超过 80 字。' },
      date: { type: 'string', required: true, description: '开始日期，YYYY-MM-DD。' },
      endDate: { type: 'string', description: '结束日期，YYYY-MM-DD。留空表示仅当天。' },
      time: { type: 'string', description: '开始时间，HH:MM。留空表示全天。' },
      endTime: { type: 'string', description: '结束时间，HH:MM。' },
      note: { type: 'string', description: '备注，不超过 500 字。' },
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
    description: '按 id 删除一条已保存的日程。删除后无法恢复。',
    parameters: {
      id: { type: 'string', required: true, description: '日程 id。' },
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
