/** @internal Install at most one provider tool hook, preferring the new name. */
export async function installAttachmentCompatibilityTools(provider, agentContext) {
    const install = provider.installCompatibilityTools ?? provider.installTools;
    await install?.call(provider, agentContext);
}
/**
 * Live view over the OPTIONAL attachment-provider seam.
 *
 * The provider is resolved through `resolve()` on EVERY call instead of being
 * captured once at bridge startup. The bundle's `channels-files` row starts
 * CONCURRENTLY with `channels-harness` (the Cordis entry group creates every
 * row through `Promise.allSettled`), so a startup snapshot is a race: the
 * harness fiber can apply first and permanently wire itself to “no provider”
 * while `channelFiles` mounts a moment later — which silently disables the
 * outbound attachment resolver (issue #7) and the inbound image mirror.
 *
 * Resolving live also keeps the documented contract of the extension honest:
 * deleting the `channels-files` row stays a supported configuration (absent
 * stays absent, nothing becomes a hard dependency).
 */
export function liveAttachmentProvider(resolve) {
    return {
        async store(context, part) {
            return resolve()?.store(context, part);
        },
        async resolveAttachment(attachmentId, sessionId) {
            const provider = resolve();
            if (!provider) {
                throw new Error('no channel attachment provider is mounted (the channelFiles service is unavailable)');
            }
            return provider.resolveAttachment(attachmentId, sessionId);
        },
        async storeImage(context, image) {
            return resolve()?.storeImage?.(context, image);
        },
        async installCompatibilityTools(agentContext) {
            const provider = resolve();
            if (!provider)
                return;
            await installAttachmentCompatibilityTools(provider, agentContext);
        },
    };
}
//# sourceMappingURL=file-provider.js.map