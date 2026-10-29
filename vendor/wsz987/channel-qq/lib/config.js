/**
 * QQ adapter configuration (Schemastery).
 *
 * V1 consumes the official Tencent SDK `@tencent-connect/qqbot-nodejs`, which
 * owns Token acquisition/refresh, the WebSocket gateway (hello/identify/
 * heartbeat/RESUME/reconnect) and the OpenAPI REST surface. The adapter only
 * needs the AppId and behavioural tuning — no base URL, transport, reconnect
 * budget or QR auth config.
 *
 * The real AppSecret is **never** written into config / profile / git. Config
 * only carries its credential reference name (`appSecretRef`); the actual
 * secret is resolved at startup through `ctx.credentials` (v1.1 §6.2, QQ-R5).
 */
import Schema from '@deepseek-ai/schemastery';
export const QQ_APP_SECRET_REF = 'QQBOT_APP_SECRET';
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    accountId: Schema.string().default('main'),
    // Secret strings — never logged, never echoed into error messages.
    appId: Schema.string(),
    appSecretRef: Schema.string().default(QQ_APP_SECRET_REF),
    markdownSupport: Schema.boolean().default(false),
    streaming: Schema.object({
        enabled: Schema.boolean().default(true),
        throttleMs: Schema.natural().min(300).default(500),
    }),
    dedup: Schema.object({
        enabled: Schema.boolean().default(true),
        windowMs: Schema.natural().default(5000),
    }),
    startupTimeoutMs: Schema.natural().default(15000),
});
//# sourceMappingURL=config.js.map