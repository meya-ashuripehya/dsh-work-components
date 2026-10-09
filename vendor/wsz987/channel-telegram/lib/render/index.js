import { renderRichMarkdown } from './markdown.js';
import { renderHtml } from './html.js';
import { renderMarkdownV2, renderPlain, renderPlainCaption } from './plain.js';
/** Resolve the default renderer for the adapter's Bot API 10.2 baseline. */
export function resolveMode(mode) {
    if (mode === 'auto')
        return 'rich-markdown';
    return mode;
}
/**
 * Render Markdown source to a plan for the given mode.
 *
 * - `plain`:   plain fallback, 4096 (or 1024 caption) grapheme segments.
 * - `html`:    Telegram-safe HTML, 4096, tags/entities never split.
 * - `markdown-v2`: fully escaped MarkdownV2, 4096.
 * - `rich-markdown`: block-aware Rich Message markdown, 32768 UTF-8 bytes.
 * - `auto`: Rich Markdown (the adapter requires Bot API 10.2 or newer).
 */
export function renderMessage(source, options) {
    const mode = resolveMode(options.mode);
    if (mode === 'plain') {
        const texts = options.forCaption ? renderPlainCaption(source) : renderPlain(source);
        return { kind: 'regular', mode: 'plain', chunks: texts };
    }
    if (mode === 'html') {
        return { kind: 'regular', mode: 'html', parseMode: 'HTML', chunks: renderHtml(source) };
    }
    if (mode === 'markdown-v2') {
        return {
            kind: 'regular',
            mode: 'markdown-v2',
            parseMode: 'MarkdownV2',
            chunks: renderMarkdownV2(source),
        };
    }
    // rich-markdown
    return { kind: 'rich', mode: 'rich-markdown', texts: renderRichMarkdown(source) };
}
/**
 * Whether an error is a formatting failure that warrants a one-shot plain
 * fallback. Only `format`-kind `TelegramApiError`s qualify; everything else
 * (401/403 / 429 / network / 5xx) propagates (plan §20.9).
 */
export function isFormattingFailure(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.kind === 'format');
}
/**
 * Send a rendered plan with exactly-once formatting fallback:
 *
 * - try the requested mode;
 * - if it throws a `format`-kind error and the requested mode was not already
 *   plain, retry the SAME content once as plain text;
 * - any other error, or a format error on the plain retry, rethrows unchanged.
 *
 * This guarantees the fallback runs at most once and can never enter an
 * infinite rich→plain→rich loop.
 */
export async function sendWithFallback(source, options, send) {
    const requested = resolveMode(options.mode);
    const first = renderMessage(source, options);
    try {
        return await send(first);
    }
    catch (error) {
        if (!isFormattingFailure(error))
            throw error;
        // Only downgrade if we weren't already plain.
        if (requested === 'plain')
            throw error;
        const plain = renderMessage(source, { ...options, mode: 'plain' });
        return await send(plain);
    }
}
//# sourceMappingURL=index.js.map