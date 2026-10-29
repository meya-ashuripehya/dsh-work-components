/**
 * QQ upstream compatibility manifest (Tencent official SDK).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy: 'sdk' — the adapter consumes the official
 * `@tencent-connect/qqbot-nodejs` SDK (Token, WebSocket gateway, media,
 * streaming). No in-source gateway protocol and no OpenClaw runtime
 * dependency.
 *
 * Status 'tested' is justified by the Channel Contract + fixture tests plus
 * the offline adapter/mapper/outbound/streaming/lifecycle/E2E suites (Fake
 * QQSdkClient) passing — fully offline. Live verification against a real QQ
 * app (AppId/AppSecret) is a manual step.
 */
import pkg from '../package.json' with { type: 'json' };
/** Current manifest: Tencent official `qqbot-nodejs` SDK @ 1.0.4. */
export const manifest = {
    id: 'qq',
    adapterVersion: pkg.version,
    upstream: {
        reference: 'tencent-connect/qqbot-nodejs (https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)',
        testedVersion: '1.0.4',
        versionRange: '1.0.4',
        strategy: 'sdk',
    },
    sdk: {
        package: '@tencent-connect/qqbot-nodejs',
        testedVersion: '1.0.4',
    },
    status: 'tested',
    lastVerifiedDate: '2026-08-14',
};
//# sourceMappingURL=manifest.js.map