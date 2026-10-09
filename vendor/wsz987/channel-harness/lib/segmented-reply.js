/**
 * [dsh-workbench patch] Build process-segment HTML (expandable blockquote) and
 * manage per-step process/text reply handles for interleaved channel delivery.
 */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function toolStatusLabel(status) {
    if (status === 'running') return '进行中';
    if (status === 'error') return '失败';
    return '完成';
}

/** Build Telegram HTML for a process segment (reasoning + tool lines). */
export function buildProcessHtml({ reasoning, tools, sendReasoning, reasoningMaxChars }) {
    const lines = [];
    if (sendReasoning && reasoning) {
        let body = String(reasoning).trim();
        if (body.length > reasoningMaxChars) body = body.slice(-reasoningMaxChars);
        // Escape HTML special chars in reasoning body.
        body = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        lines.push('💭 思考');
        lines.push(body);
    }
    for (const t of tools) {
        const dur = t.endedAt && t.startedAt ? formatDuration(t.endedAt - t.startedAt) : '';
        const status = toolStatusLabel(t.status);
        const name = String(t.name || t.id || 'tool').replace(/&/g, '&amp;').replace(/</g, '&lt;');
        lines.push(dur ? `🔧 ${name} · ${status}（${dur}）` : `🔧 ${name} · ${status}`);
    }
    if (!lines.length) return '';
    return `<blockquote expandable>\n${lines.join('\n')}\n</blockquote>`;
}

/**
 * Decide whether a process segment should be shown.
 */
export function shouldShowProcess({ sendReasoning, showToolCalls, reasoning, tools }) {
    if (sendReasoning && reasoning && String(reasoning).trim()) return true;
    if (showToolCalls && tools && tools.length) return true;
    return false;
}
