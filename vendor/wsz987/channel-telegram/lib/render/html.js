import { toString } from 'mdast-util-to-string';
import { tokenizeMarkdown } from './markdown.js';
import { blockToPlain } from './plain.js';
import { splitByGraphemes } from './segment.js';
export function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function childrenToHtml(node) {
    return node.children.map(nodeToHtml).join('');
}
// [dsh-workbench patch] Telegram-friendly rendering of block markdown: tables, nested lists,
// fenced code language classes, rules. Telegram has no table entity.
const TABLE_MAX_COLS = 46;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Display width: CJK / full-width / emoji = 2, combining marks = 0, else 1. */
export function displayWidth(text) {
    let width = 0;
    for (const { segment } of GRAPHEMES.segment(String(text ?? ''))) {
        const cp = segment.codePointAt(0) ?? 0;
        if (/\p{Extended_Pictographic}/u.test(segment) || /\p{Regional_Indicator}/u.test(segment)) { width += 2; continue; }
        if (/^\p{M}+$/u.test(segment)) continue;
        if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
            || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
            || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)) { width += 2; continue; }
        width += 1;
    }
    return width;
}
function padTo(text, width, align) {
    const gap = Math.max(0, width - displayWidth(text));
    if (align === 'right') return ' '.repeat(gap) + text;
    if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(gap - Math.floor(gap / 2));
    return text + ' '.repeat(gap);
}
/** Plain text of a table cell: inline markdown stripped (code, emphasis, links → text). */
function cellText(cell) {
    return toString(cell).replace(/\s+/g, ' ').trim();
}
export function tableToHtml(node) {
    const rows = node.children.map((row) => row.children.map(cellText));
    if (!rows.length) return '';
    const cols = Math.max(...rows.map((r) => r.length));
    for (const r of rows) while (r.length < cols) r.push('');
    const align = node.align || [];
    const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...rows.map((r) => displayWidth(r[c]))));
    const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
    if (total <= TABLE_MAX_COLS) {
        const line = (r) => r.map((v, c) => padTo(v, widths[c], align[c])).join(' │ ').replace(/\s+$/, '');
        const sep = widths.map((w) => '─'.repeat(w)).join('─┼─');
        const out = [line(rows[0]), sep, ...rows.slice(1).map(line)];
        return `<pre>${escapeHtml(out.join('\n'))}</pre>`;
    }
    // Too wide: one record per row — bold first column, then 「列名：值」 lines.
    const header = rows[0];
    const records = rows.slice(1).map((r) => {
        const lines = [`<b>${escapeHtml(r[0] || header[0] || '')}</b>`];
        for (let c = 1; c < cols; c++) {
            if (!r[c]) continue;
            lines.push(`${escapeHtml(header[c] || `第${c + 1}列`)}：${escapeHtml(r[c])}`);
        }
        return lines.join('\n');
    });
    return records.join('\n\n');
}
function listToHtml(node, depth = 0) {
    const indent = '  '.repeat(depth);
    return node.children.map((item, index) => {
        const marker = node.ordered ? `${(node.start ?? 1) + index}.` : (depth % 2 ? '◦' : '•');
        const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
        const parts = [];
        let first = true;
        for (const child of item.children) {
            if (child.type === 'list') { parts.push(listToHtml(child, depth + 1)); continue; }
            const html = nodeToHtml(child);
            if (first) { parts.push(`${indent}${marker} ${check}${html}`); first = false; }
            else parts.push(`${indent}  ${html}`);
        }
        if (first) parts.unshift(`${indent}${marker} ${check}`.trimEnd());
        return parts.join('\n');
    }).join('\n');
}
function codeLanguage(lang) {
    // Only the first token of the info string, and only a sane identifier (fixes stray labels).
    const first = String(lang ?? '').trim().split(/\s+/)[0] || '';
    return /^[A-Za-z0-9_+#.-]{1,32}$/.test(first) ? first.toLowerCase() : '';
}
function nodeToHtml(node) {
    switch (node.type) {
        case 'text': return escapeHtml(node.value);
        case 'strong': return `<b>${childrenToHtml(node)}</b>`;
        case 'emphasis': return `<i>${childrenToHtml(node)}</i>`;
        case 'delete': return `<s>${childrenToHtml(node)}</s>`;
        case 'inlineCode': return `<code>${escapeHtml(node.value)}</code>`;
        case 'code': {
            const lang = codeLanguage(node.lang);
            return lang
                ? `<pre><code class="language-${escapeAttr(lang)}">${escapeHtml(node.value)}</code></pre>`
                : `<pre>${escapeHtml(node.value)}</pre>`;
        }
        case 'link': return `<a href="${escapeAttr(node.url)}">${childrenToHtml(node)}</a>`;
        case 'image': return escapeHtml(node.alt ?? node.url);
        case 'break': return '\n';
        case 'heading': return `<b>${childrenToHtml(node)}</b>`;
        case 'blockquote': return `<blockquote>${node.children.map(nodeToHtml).join('\n')}</blockquote>`;
        case 'paragraph': return childrenToHtml(node);
        case 'list': return listToHtml(node, 0);
        case 'listItem': return node.children.map(nodeToHtml).join('\n');
        case 'table': return tableToHtml(node);
        case 'tableRow': return node.children.map((cell) => cellText(cell)).join(' | ');
        case 'tableCell': return escapeHtml(cellText(node));
        case 'html': return escapeHtml(node.value);
        case 'thematicBreak': return '──────────';
        case 'footnoteDefinition': return childrenToHtml(node);
        case 'footnoteReference': return escapeHtml(node.label ?? node.identifier);
        case 'linkReference': return childrenToHtml(node);
        case 'imageReference': return escapeHtml(node.alt ?? node.label ?? node.identifier);
        case 'definition': return '';
        case 'yaml': return escapeHtml(node.value);
        case 'root': return node.children.map(nodeToHtml).join('\n\n');
        default: return node.children ? childrenToHtml(node) : escapeHtml(node.value ?? '');
    }
}
/** Kept as a public helper; parsing now happens through mdast rather than regex. */
export function inlineMarkdownToHtml(text) {
    const block = tokenizeMarkdown(text)[0];
    return block ? nodeToHtml(block.node) : '';
}
export function blockToHtml(block) {
    return nodeToHtml(block.node);
}
const HTML_MAX = 4096;
/**
 * Oversized generated HTML degrades to escaped text chunks. Every returned
 * chunk is independently valid Telegram HTML; no tag is left open across a
 * message boundary.
 */
export function safeHtmlSplit(html, maxLength = HTML_MAX) {
    if (html.length <= maxLength)
        return [html];
    const plain = html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const chunks = [];
    let current = '';
    for (const item of segmenter.segment(plain)) {
        const escaped = escapeHtml(item.segment);
        if (current && current.length + escaped.length > maxLength) {
            chunks.push(current);
            current = '';
        }
        current += escaped;
    }
    if (current)
        chunks.push(current);
    return chunks;
}
export function renderHtml(source, limit = HTML_MAX) {
    if (!source)
        return [];
    const messages = [];
    let buffer = '';
    const flush = () => {
        if (buffer)
            messages.push(buffer);
        buffer = '';
    };
    for (const block of tokenizeMarkdown(source)) {
        const html = blockToHtml(block);
        if (html.length > limit) {
            flush();
            messages.push(...splitByGraphemes(blockToPlain(block), limit).map(escapeHtml));
            continue;
        }
        if (buffer && buffer.length + html.length + 2 > limit)
            flush();
        buffer += `${buffer ? '\n\n' : ''}${html}`;
    }
    flush();
    return messages;
}
//# sourceMappingURL=html.js.map