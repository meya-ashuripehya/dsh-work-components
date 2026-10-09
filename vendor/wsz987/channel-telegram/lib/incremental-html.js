/**
 * Incremental HTML preview for streaming drafts/edits (channel-telegram draft-stream patch).
 * Closed markdown blocks → renderHtml; open tail escaped; unfinished ``` fences temp-closed.
 */
import { escapeHtml, renderHtml } from './render/html.js';

const HARD = 3800;

/** Count unpaired ``` fences (odd = currently inside a fence). */
export function openFenceCount(text) {
    const all = String(text).match(/```/g);
    return all ? all.length % 2 : 0;
}

/**
 * Split source into { closed, tail } where closed is safe to fully render.
 * Prefer last double-newline before HARD; else last single newline; else HARD chars.
 */
export function splitClosedTail(source, limit = HARD) {
    const text = String(source ?? '');
    if (text.length <= limit) return { closed: text, tail: '', overflow: false };
    // Find a split point near limit so the "current" message stays under HARD.
    let cut = limit;
    const window = text.slice(0, limit);
    const para = window.lastIndexOf('\n\n');
    const line = window.lastIndexOf('\n');
    if (para >= limit * 0.5) cut = para + 2;
    else if (line >= limit * 0.5) cut = line + 1;
    let closed = text.slice(0, cut);
    let tail = text.slice(cut);
    // Balance fences across the cut: if closed has an open fence, pull until next fence into closed or temp-close.
    if (openFenceCount(closed) === 1) {
        const next = tail.indexOf('```');
        if (next >= 0 && next < 800) {
            const end = next + 3;
            // include rest of fence line
            const nl = tail.indexOf('\n', end);
            const take = nl >= 0 ? nl + 1 : end;
            closed += tail.slice(0, take);
            tail = tail.slice(take);
        }
    }
    return { closed, tail, overflow: true };
}

/**
 * Build Telegram HTML for a streaming preview. Never throws; on render failure returns escaped plain.
 * @returns {{ html: string, plain: string, overflow: boolean, closedLength: number }}
 */
/**
 * [dsh-workbench patch] A GFM table at the live edge is still being written:
 * hold it back (shown as escaped plain text) until a following non-table line closes it.
 */
export function splitPendingTable(text) {
    const src = String(text ?? '');
    if (/\n\s*\n$/.test(src)) return { body: src, pending: '' };
    const lines = src.split('\n');
    let k = lines.length;
    while (k > 0 && /^\s*\|/.test(lines[k - 1])) k--;
    if (k === lines.length) return { body: src, pending: '' };
    // Not inside an open fence.
    const before = lines.slice(0, k).join('\n');
    if (openFenceCount(before) === 1) return { body: src, pending: '' };
    return { body: before + (k > 0 ? '\n' : ''), pending: lines.slice(k).join('\n') };
}
export function buildIncrementalHtml(source, limit = HARD) {
    const plain = String(source ?? '');
    const split = splitClosedTail(plain, limit);
    const { overflow } = split;
    let { closed, tail } = split;
    if (!tail) {
        const pend = splitPendingTable(closed);
        closed = pend.body;
        tail = pend.pending;
    }
    let body = closed;
    // Temp-close an open fence so renderHtml sees valid markdown.
    const tempClose = openFenceCount(body) === 1;
    if (tempClose) body += '\n```';
    let html;
    try {
        const chunks = renderHtml(body);
        html = chunks.join('\n\n');
        // If renderHtml split further, join only first chunk for preview; overflow handled by caller via closedLength.
    }
    catch {
        html = escapeHtml(body);
    }
    if (tempClose) {
        // Drop the synthetic closing fence display if render added it as a code fence end — keep as-is;
        // the next delta will re-render with more content.
    }
    if (tail) {
        // Append unparsed tail as escaped plain so tags never stay open across the live edge.
        html += (html ? '\n\n' : '') + escapeHtml(tail.length > 1500 ? tail.slice(-1500) : tail);
        // Cap total preview size roughly
        if (html.length > 4090) html = html.slice(0, 4090);
    }
    return { html, plain, overflow, closedLength: closed.length };
}

/**
 * Finalize full text as HTML chunks (each independently valid). Falls back to escaped plain on failure.
 */
export function buildFinalHtmlChunks(source) {
    try {
        return renderHtml(String(source ?? ''));
    }
    catch {
        const text = escapeHtml(String(source ?? ''));
        const out = [];
        for (let i = 0; i < text.length; i += 4096) out.push(text.slice(i, i + 4096));
        return out.length ? out : [''];
    }
}
