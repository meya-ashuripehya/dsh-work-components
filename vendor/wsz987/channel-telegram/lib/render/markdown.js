import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';
import { RICH_MESSAGE_MAX_BLOCKS, RICH_MESSAGE_MAX_NESTING, RICH_MESSAGE_MAX_TABLE_COLUMNS, RICH_MESSAGE_MAX_UTF8, } from '../rich-message.js';
import { splitByUtf8Graphemes, utf8Length } from './segment.js';
export function parseMarkdown(source) {
    return fromMarkdown(source, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
    });
}
function serializeNode(node) {
    return toMarkdown({ type: 'root', children: [node] }, { extensions: [gfmToMarkdown()] }).trimEnd();
}
function tableCells(row) {
    return row.children.map((cell) => toString(cell));
}
function sourceMarkdown(source, node) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined)
        return source.slice(start, end).trimEnd();
    return serializeNode(node);
}
function asBlock(source, node) {
    const markdown = sourceMarkdown(source, node);
    switch (node.type) {
        case 'code':
            return { kind: 'code', lang: node.lang ?? '', code: node.value, node, markdown };
        case 'heading':
            return { kind: 'heading', level: node.depth, text: toString(node), node, markdown };
        case 'table':
            return {
                kind: 'table',
                header: node.children[0] ? tableCells(node.children[0]) : [],
                rows: node.children.slice(1).map(tableCells),
                node,
                markdown,
            };
        case 'blockquote':
            return { kind: 'blockquote', content: toString(node), node, markdown };
        case 'list':
            return {
                kind: 'list',
                ordered: node.ordered === true,
                items: node.children.map((item) => toString(item)),
                node,
                markdown,
            };
        default:
            return { kind: 'paragraph', text: toString(node) || markdown, node, markdown };
    }
}
export function tokenizeMarkdown(source) {
    if (!source)
        return [];
    return parseMarkdown(source).children.map((node) => asBlock(source, node));
}
export function renderBlock(block) {
    return block.markdown;
}
function nodeStats(node) {
    let count = 0;
    let maxDepth = 0;
    const visit = (value, depth) => {
        if (!value || typeof value !== 'object')
            return;
        count += 1;
        maxDepth = Math.max(maxDepth, depth);
        const children = value.children;
        for (const child of children ?? [])
            visit(child, depth + 1);
    };
    visit(node, 1);
    return { count, depth: maxDepth };
}
const MARKDOWN_LITERAL = /[\\`*_[\]{}()<>#+\-.!|>~=]/;
/** Escape literal text and pack complete escape sequences under a byte limit. */
function literalChunks(value, limit) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const chunks = [];
    let current = '';
    let bytes = 0;
    for (const item of segmenter.segment(value)) {
        const escaped = MARKDOWN_LITERAL.test(item.segment) ? `\\${item.segment}` : item.segment;
        const size = utf8Length(escaped);
        if (current && bytes + size > limit) {
            chunks.push(current);
            current = '';
            bytes = 0;
        }
        current += escaped;
        bytes += size;
    }
    if (current)
        chunks.push(current);
    return chunks;
}
function splitCode(node, limit) {
    const bodyBudget = Math.max(1, limit - utf8Length(node.lang ?? '') - 16);
    const result = [];
    for (const value of splitByUtf8Graphemes(node.value, bodyBudget)) {
        const markdown = serializeNode({ ...node, value });
        if (utf8Length(markdown) <= limit)
            result.push(markdown);
        else
            result.push(...literalChunks(value, limit));
    }
    return result;
}
function splitTable(node, limit) {
    if (node.children.length === 0 || node.children[0].children.length > RICH_MESSAGE_MAX_TABLE_COLUMNS) {
        return literalChunks(toString(node), limit);
    }
    const header = node.children[0];
    const chunks = [];
    let rows = [];
    const flush = () => {
        if (rows.length === 0)
            return;
        chunks.push(serializeNode({ ...node, children: [header, ...rows] }));
        rows = [];
    };
    for (const row of node.children.slice(1)) {
        const candidate = serializeNode({ ...node, children: [header, ...rows, row] });
        if (utf8Length(candidate) <= limit) {
            rows.push(row);
            continue;
        }
        flush();
        const single = serializeNode({ ...node, children: [header, row] });
        if (utf8Length(single) <= limit)
            chunks.push(single);
        else
            chunks.push(...literalChunks(toString(row), limit));
    }
    flush();
    return chunks.length > 0 ? chunks : [serializeNode(node)];
}
function splitBlock(block, limit) {
    if (block.node.type === 'code')
        return splitCode(block.node, limit);
    if (block.node.type === 'table')
        return splitTable(block.node, limit);
    return literalChunks(toString(block.node) || block.markdown, limit);
}
/** Segment parsed blocks under Telegram's byte, block-count, and depth limits. */
export function segmentRich(blocks, limit = RICH_MESSAGE_MAX_UTF8) {
    const messages = [];
    let current = [];
    let bytes = 0;
    let blocksInMessage = 0;
    const flush = () => {
        if (current.length > 0)
            messages.push(current.join('\n\n'));
        current = [];
        bytes = 0;
        blocksInMessage = 0;
    };
    for (const block of blocks) {
        const stats = nodeStats(block.node);
        const rendered = block.markdown;
        const renderedBytes = utf8Length(rendered);
        const separator = current.length > 0 ? 2 : 0;
        const unsafeStructure = stats.depth > RICH_MESSAGE_MAX_NESTING || stats.count > RICH_MESSAGE_MAX_BLOCKS;
        if (unsafeStructure || renderedBytes > limit) {
            flush();
            messages.push(...splitBlock(block, limit));
            continue;
        }
        if (bytes + separator + renderedBytes > limit ||
            blocksInMessage + stats.count > RICH_MESSAGE_MAX_BLOCKS)
            flush();
        current.push(rendered);
        bytes += (current.length > 1 ? 2 : 0) + renderedBytes;
        blocksInMessage += stats.count;
    }
    flush();
    return messages;
}
export function renderRichMarkdown(source, limit = RICH_MESSAGE_MAX_UTF8) {
    return segmentRich(tokenizeMarkdown(source), limit);
}
export { tokenizeMarkdown as tokenize };
//# sourceMappingURL=markdown.js.map