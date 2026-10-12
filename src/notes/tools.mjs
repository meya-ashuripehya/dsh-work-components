/**
 * 笔记工具：模型自行沉淀并复用要点与新知识。
 * 召回只走工具：系统提示与每回合上下文都不注入笔记内容；查询返回有界的摘要与 id，全文按需 note_get。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import {
  browse, deleteCategory, deleteNote, getNote, LIMITS, NotesError, saveCategory, saveNote, search,
} from './store.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const asText = (value) => String(value ?? '').trim()

function guard(fallback) {
  return (error) => {
    if (error instanceof NotesError) throw error
    throw new NotesError(fallback)
  }
}

/** @param {{ dir?: string }} options 测试时传临时数据目录。 */
export function createNotesTools(options = {}) {
  const dir = options.dir

  const browseTool = defineTool({
    name: 'note_browse',
    description: '逐级浏览笔记库。笔记库用于沉淀你在任务中总结出的要点、经验，以及知识库中没有的新知识，供后续任务复用。共三级：第一级为知识点类型（如 知识、技巧、规则），第二级为细分类别（如 知识 › 数学），第三级为笔记。开始与已有经验相关的任务前，先浏览或检索；返回的是摘要与 id，全文用 note_get 读取。',
    parameters: {
      categoryId: { type: 'string', description: '留空列出第一级类型；传第一级 id 列出其下的细分类别；传第二级 id 列出其下的笔记摘要（按更新时间倒序）。' },
      limit: { type: 'integer', description: '每页条数，默认 30，最多 100。' },
      offset: { type: 'integer', description: '从第几条开始，用于翻页；结果里有 nextOffset 时表示还有下一页。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return browse(asText(args.categoryId), { limit: args.limit, offset: args.offset }, dir)
    },
  })

  const searchTool = defineTool({
    name: 'note_search',
    description: '按关键词检索笔记（标题、内容、标签、类别路径），也会返回名称匹配的类别。返回摘要与 id，全文用 note_get 读取。保存新笔记前先检索，避免重复。',
    parameters: {
      query: { type: 'string', description: '关键词；空格分隔的多个词须全部命中。仅按 tag 或 categoryId 筛选时可留空。' },
      categoryId: { type: 'string', description: '可选。只在该类别（含其子类别）内检索。' },
      tag: { type: 'string', description: '可选。只返回带有该标签的笔记。' },
      limit: { type: 'integer', description: '最多返回的笔记数，默认 10，最多 30。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return search(asText(args.query), { categoryId: asText(args.categoryId), tag: asText(args.tag), limit: args.limit }, dir)
    },
  })

  const getTool = defineTool({
    name: 'note_get',
    description: '按 id 读取一条笔记的全文、标签与时间。',
    parameters: { id: { type: 'string', required: true, description: '笔记 id。' } },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return getNote(asText(args.id), dir)
    },
  })

  const saveTool = defineTool({
    name: 'note_save',
    description: '新建或修改一条笔记。在完成任务、纠正错误或获得用户反馈后，把可复用的要点、做法与知识库中没有的新知识写成简洁的笔记；只记已经验证的内容，不记一次性细节、密钥或个人隐私。同一类别下标题不能重复：已有相近笔记时，传其 id 更新或用 append 追加，不要另建。',
    parameters: {
      id: { type: 'string', description: '要修改的笔记 id。留空则新建。' },
      categoryId: { type: 'string', description: '所属第二级类别的 id。新建时必填；修改时传入则移动到该类别。' },
      title: { type: 'string', description: '标题，不超过 ' + LIMITS.title + ' 字。新建时必填。' },
      content: { type: 'string', description: '要点正文，不超过 ' + LIMITS.content + ' 字，建议分条书写。修改时传入则整体替换。' },
      append: { type: 'string', description: '可选。追加到正文末尾的内容（另起一行），用于补充新要点。' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选。标签，最多 ' + LIMITS.tags + ' 个；修改时传入则整体替换。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return saveNote({
        id: asText(args.id),
        categoryId: asText(args.categoryId),
        title: args.title,
        content: args.content,
        append: args.append,
        tags: args.tags,
      }, dir).catch(guard('保存笔记失败'))
    },
  })

  const deleteTool = defineTool({
    name: 'note_delete',
    description: '按 id 删除一条笔记，删除后无法恢复。仅在笔记已过时、错误或与另一条重复时使用。',
    parameters: { id: { type: 'string', required: true, description: '笔记 id。' } },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return deleteNote(asText(args.id), dir)
    },
  })

  const categorySaveTool = defineTool({
    name: 'note_category_save',
    description: '新建或重命名一个类别。不传 parentId 为第一级知识点类型（如 知识、技巧、规则）；传第一级 id 为其下的细分类别（如 数学）。类别最多两级，笔记只能放在第二级。新建前先用 note_browse 查看已有类别，优先复用。',
    parameters: {
      id: { type: 'string', description: '要修改的类别 id。留空则新建。修改时不能改变层级。' },
      name: { type: 'string', description: '类别名称，不超过 ' + LIMITS.name + ' 字。新建时必填。' },
      parentId: { type: 'string', description: '新建第二级类别时填所属第一级类别的 id；新建第一级时留空。' },
      description: { type: 'string', description: '可选。类别说明，不超过 ' + LIMITS.description + ' 字。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return saveCategory({
        id: asText(args.id),
        name: args.name,
        ...(asText(args.parentId) ? { parentId: asText(args.parentId) } : {}),
        description: args.description,
      }, dir).catch(guard('保存类别失败'))
    },
  })

  const categoryDeleteTool = defineTool({
    name: 'note_category_delete',
    description: '删除一个类别及其子类别。类别下没有笔记时直接删除；仍有笔记时不会删除，而是返回 needsConfirm 和笔记数量。',
    parameters: {
      id: { type: 'string', required: true, description: '类别 id。' },
      confirm: { type: 'boolean', description: '确认连同其下所有笔记一并删除。只有在收到 needsConfirm 并征得用户同意后才传 true。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return deleteCategory(asText(args.id), { confirm: args.confirm === true }, dir)
    },
  })

  return [browseTool, searchTool, getTool, saveTool, deleteTool, categorySaveTool, categoryDeleteTool]
}
