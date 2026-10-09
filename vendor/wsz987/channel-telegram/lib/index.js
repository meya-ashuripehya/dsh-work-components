/**
 * @wsz987/channel-telegram — Telegram Bot API channel adapter for DeepSeek
 * Harness.
 *
 * A fifth official channel built on the same Channel Contract as Weixin / QQ /
 * DingTalk / Lark. The Bot API token is resolved through `ctx.credentials`
 * (`tokenRef`, default `TELEGRAM_BOT_TOKEN`) — the secret value never lives in
 * profile config, logs, or fixtures.
 *
 * Lifecycle: when the Channel Control Plane (`ctx.channelControl`) is present,
 * apply() registers a `ChannelDefinition` ('telegram'); the control plane
 * decides when to instantiate/mount the adapter (headless auto-start). When it
 * is absent (standalone / older harness), apply() falls back to resolving the
 * token credential and mounting directly — never throwing when the channel is
 * merely unconfigured.
 *
 * Streaming is `edit`: one message is sent and then edited in place with
 * `editMessageText` as full-text previews arrive. Set
 * `config.streaming.enabled: false` to force the buffered send-once strategy.
 */
import {} from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mountChannelAdapter } from '@wsz987/channel-core';
import { Config, TELEGRAM_BOT_TOKEN_REF } from './config.js';
import { TelegramAdapter } from './adapter.js';
import { createTelegramDefinition } from './definition.js';
export const name = 'channel-telegram';
export const inject = ['channels', 'credentials'];
export { Config, TELEGRAM_BOT_TOKEN_REF };
export { TelegramAdapter } from './adapter.js';
export { createTelegramDefinition } from './definition.js';
export { InboundProcessor } from './inbound.js';
export { hydrateTelegramParts } from './media-hydrator.js';
export { OutboundSender, actionsToReplyMarkup } from './outbound.js';
export { TelegramStreamingReply, makePreview } from './streaming-reply.js';
export { TelegramRichStreamingReply } from './rich-streaming-reply.js';
export { TelegramApiError, classifyTelegramError, } from './api-error.js';
export { RICH_MESSAGE_MAX_UTF8, RICH_MESSAGE_MAX_BLOCKS, RICH_MESSAGE_MAX_NESTING, RICH_MESSAGE_MAX_MEDIA, RICH_MESSAGE_MAX_TABLE_COLUMNS, REGULAR_MESSAGE_MAX, CAPTION_MAX, } from './rich-message.js';
export * as render from './render/index.js';
export { renderMessage, sendWithFallback, resolveMode, isFormattingFailure, } from './render/index.js';
export { mapInbound, mapCallbackQuery, isCallbackQueryUpdate, dedupKey, simpleHash } from './mapper.js';
export { HttpTelegramUpstream, } from './upstream.js';
export { FetchTransport, } from './transport.js';
export { manifest } from './manifest.js';
/**
 * One-time legacy plaintext `config.token` -> credential reference migration.
 * The value is written to the credentials seam once, then the plaintext is
 * stripped from the in-memory config. The secret value is never logged.
 */
function migrateLegacyToken(ctx, config) {
    const legacy = config.token;
    if (typeof legacy !== 'string' || legacy.length === 0)
        return;
    const ref = config.tokenRef ?? TELEGRAM_BOT_TOKEN_REF;
    void ctx.credentials
        .set(credentialRef(ref), legacy)
        .then(() => {
        ctx.logger('channel-telegram').info(`[channel-telegram] legacy plaintext token migrated into credentials ref "${ref}"`);
    })
        .catch((error) => {
        ctx.logger('channel-telegram').warn('[channel-telegram] legacy plaintext token migration failed', error);
    });
    delete config.token;
}
export function apply(ctx, config, deps = {}) {
    const credentialsCtx = ctx;
    migrateLegacyToken(credentialsCtx, config);
    const ref = config.tokenRef ?? TELEGRAM_BOT_TOKEN_REF;
    const control = ctx.get('channelControl');
    if (control) {
        // Control plane present (doc §25/§27): register the definition EVEN when
        // disabled — the plane owns adapter instantiation + headless auto-start,
        // and a disabled definition must stay visible so the Web control plane can
        // re-enable it later (doc §19/§20).
        const settings = ctx.get('settings');
        const scope = settings?.register('channels-telegram', Config, { base: config });
        const effectiveConfig = scope?.get() ?? config;
        control.definitions.register(createTelegramDefinition({
            config: effectiveConfig,
            deps,
            credentials: {
                resolve: (name) => credentialsCtx.credentials.resolve(credentialRef(name)),
                describe: (name) => credentialsCtx.credentials.describe(credentialRef(name)),
                set: (name, value) => credentialsCtx.credentials.set(credentialRef(name), value),
            },
            persistEnabled: (enabled) => scope?.update({ enabled }) ?? Promise.resolve(),
        }));
        return;
    }
    // Legacy fallback (standalone, no control plane): mount directly. There is no
    // directory/control surface to re-enable a disabled channel, so the config
    // `enabled` gate still applies (doc §20). Unconfigured token must NOT throw
    // (doc §25) — log a warning and stay idle.
    if (!config.enabled)
        return;
    ctx.effect(async () => {
        const token = deps.token ?? (await credentialsCtx.credentials.resolve(credentialRef(ref)))?.value;
        if (!token) {
            ctx.logger('channel-telegram').warn(`[channel-telegram] telegram credential "${ref}" is not configured; adapter not mounted`);
            return () => { };
        }
        mountChannelAdapter(ctx, new TelegramAdapter(config, { ...deps, token }), (signal) => ctx.channels.createAdapterContext({ channelId: 'telegram', signal }));
        // The mount owns the adapter lifecycle; this outer effect only scopes the
        // async credential resolution, so its disposer is a no-op.
        return () => { };
    });
}
//# sourceMappingURL=index.js.map