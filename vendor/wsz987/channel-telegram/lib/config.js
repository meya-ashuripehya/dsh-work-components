/**
 * Telegram adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. The Bot API token is a secret: config carries only its
 * credential reference (`tokenRef`, default `TELEGRAM_BOT_TOKEN`); the real
 * value is resolved through `ctx.credentials` at startup and never lives in
 * profile config, logs, or fixtures.
 *
 * Migration note: legacy configs may still carry a plaintext `token`. The field
 * is deprecated and hidden; the plugin's apply() migrates it into
 * `ctx.credentials` under `tokenRef` exactly once and strips the plaintext.
 */
import Schema from '@deepseek-ai/schemastery';
/** Default credential reference name for the Telegram Bot API token. */
export const TELEGRAM_BOT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN';
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    accountId: Schema.string().default('main'),
    baseUrl: Schema.string().default('https://api.telegram.org'),
    // Credential reference name only — never the secret value itself.
    tokenRef: Schema.string().default(TELEGRAM_BOT_TOKEN_REF),
    // DEPRECATED migration-only legacy plaintext field: kept so old configs still
    // parse. apply() migrates its value to credentials once and deletes it.
    token: Schema.string().hidden(),
    timeoutMs: Schema.natural().default(30000),
    longPollTimeoutMs: Schema.natural().default(25000),
    reconnect: Schema.object({
        enabled: Schema.boolean().default(true),
        baseDelayMs: Schema.natural().default(1000),
        // [dsh-telegram-temp patch] capped backoff ceiling raised to 60 s; the
        // receive loop never gives up permanently any more.
        maxDelayMs: Schema.natural().default(60000),
        // [dsh-telegram-temp patch] retained for config compatibility only. It
        // no longer ends the receive loop; after this many consecutive failures
        // the retry log line is simply emitted at error level.
        maxRetries: Schema.natural().default(10),
    }),
    // [dsh-telegram-temp patch] per-update handling budget. When handing one
    // update to the agent bridge exceeds this, the update is marked read and
    // polling continues (the handler keeps running in the background).
    updateTimeoutMs: Schema.natural().default(90000),
    // [dsh-telegram-temp patch] receive-loop watchdog: restart polling when no
    // getUpdates call has completed for this long.
    watchdogStallMs: Schema.natural().default(180000),
    dedup: Schema.object({
        enabled: Schema.boolean().default(true),
        windowMs: Schema.natural().default(5000),
    }),
    streaming: Schema.object({
        enabled: Schema.boolean().default(true),
        placeholder: Schema.string().default('…'),
        // [dsh-workbench patch] auto = draft in DMs / edit elsewhere; draft = force sendMessageDraft; edit = force editMessageText.
        mode: Schema.union([Schema.const('auto'), Schema.const('draft'), Schema.const('edit')]).default('auto'),
    }),
    typing: Schema.object({
        enabled: Schema.boolean().default(true),
        refreshMs: Schema.natural().min(1000).default(4000),
    }),
    formatting: Schema.object({
        mode: Schema.union([
            Schema.const('auto'),
            Schema.const('rich-markdown'),
            Schema.const('html'),
            Schema.const('markdown-v2'),
            Schema.const('plain'),
        ]).default('auto'),
        fallback: Schema.const('plain').default('plain'),
    }),
    maxDownloadBytes: Schema.natural().default(20 * 1024 * 1024),
});
//# sourceMappingURL=config.js.map