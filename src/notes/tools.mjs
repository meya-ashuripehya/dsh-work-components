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
    description: 'Browse the notes library level by level. The library stores key points and lessons you distill during tasks, plus new knowledge not in the knowledge base, for reuse in later tasks. Three levels: level 1 is the knowledge type (e.g. 知识 knowledge, 技巧 techniques, 规则 rules), level 2 is a subcategory (e.g. 知识 › 数学 math), level 3 is notes. Before starting a task related to existing experience, browse or search first. Returns summaries and ids; read full text with note_get.',
    parameters: {
      categoryId: { type: 'string', description: 'Empty lists level-1 types; a level-1 id lists its subcategories; a level-2 id lists its note summaries (most recently updated first).' },
      limit: { type: 'integer', description: 'Items per page, default 30, max 100.' },
      offset: { type: 'integer', description: 'Starting index for paging; a nextOffset in the result means there is another page.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return browse(asText(args.categoryId), { limit: args.limit, offset: args.offset }, dir)
    },
  })

  const searchTool = defineTool({
    name: 'note_search',
    description: 'Search notes by keyword (title, content, tags, category path); categories whose names match are returned too. Returns summaries and ids; read full text with note_get. Search before saving a new note to avoid duplicates.',
    parameters: {
      query: { type: 'string', description: 'Keywords; multiple space-separated words must all match. May be empty when filtering only by tag or categoryId.' },
      categoryId: { type: 'string', description: 'Optional. Search only within this category (including its subcategories).' },
      tag: { type: 'string', description: 'Optional. Return only notes with this tag.' },
      limit: { type: 'integer', description: 'Maximum notes to return, default 10, max 30.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return search(asText(args.query), { categoryId: asText(args.categoryId), tag: asText(args.tag), limit: args.limit }, dir)
    },
  })

  const getTool = defineTool({
    name: 'note_get',
    description: 'Read a note\'s full text, tags, and timestamps by id.',
    parameters: { id: { type: 'string', required: true, description: 'Note id.' } },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return getNote(asText(args.id), dir)
    },
  })

  const saveTool = defineTool({
    name: 'note_save',
    description: 'Create or update a note. After finishing a task, correcting a mistake, or receiving user feedback, write reusable key points, methods, and new knowledge not in the knowledge base as a concise note. Record only verified content; never one-off details, secrets/keys, or personal private information. Titles must be unique within a category: if a similar note exists, pass its id to update it or use append, rather than creating a new one.',
    parameters: {
      id: { type: 'string', description: 'Id of the note to update. Leave empty to create a new one.' },
      categoryId: { type: 'string', description: 'Id of the level-2 category it belongs to. Required when creating; when updating, passing it moves the note to that category.' },
      title: { type: 'string', description: 'Title, at most ' + LIMITS.title + ' characters. Required when creating.' },
      content: { type: 'string', description: 'Body of key points, at most ' + LIMITS.content + ' characters; bullet points recommended. When updating, passing it replaces the whole body.' },
      append: { type: 'string', description: 'Optional. Text appended to the end of the body (on a new line), for adding new points.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional. Tags, at most ' + LIMITS.tags + '; when updating, passing them replaces all tags.' },
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
    description: 'Delete a note by id. Deletion is permanent. Use only when the note is outdated, wrong, or duplicates another.',
    parameters: { id: { type: 'string', required: true, description: 'Note id.' } },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return deleteNote(asText(args.id), dir)
    },
  })

  const categorySaveTool = defineTool({
    name: 'note_category_save',
    description: 'Create or rename a category. Without parentId it is a level-1 knowledge type (e.g. 知识, 技巧, 规则); with a level-1 id it is a subcategory under it (e.g. 数学). Categories have at most two levels, and notes can only go in level 2. Before creating, check existing categories with note_browse and prefer reusing them.',
    parameters: {
      id: { type: 'string', description: 'Id of the category to update. Leave empty to create. Updating cannot change its level.' },
      name: { type: 'string', description: 'Category name, at most ' + LIMITS.name + ' characters. Required when creating.' },
      parentId: { type: 'string', description: 'When creating a level-2 category, the id of its level-1 parent; leave empty when creating a level-1 type.' },
      description: { type: 'string', description: 'Optional. Category description, at most ' + LIMITS.description + ' characters.' },
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
    description: 'Delete a category and its subcategories. If it contains no notes it is deleted immediately; if it still has notes it is not deleted, and needsConfirm plus the note count are returned instead.',
    parameters: {
      id: { type: 'string', required: true, description: 'Category id.' },
      confirm: { type: 'boolean', description: 'Confirm deleting it together with all its notes. Pass true only after receiving needsConfirm and getting the user\'s consent.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return deleteCategory(asText(args.id), { confirm: args.confirm === true }, dir)
    },
  })

  return [browseTool, searchTool, getTool, saveTool, deleteTool, categorySaveTool, categoryDeleteTool]
}
