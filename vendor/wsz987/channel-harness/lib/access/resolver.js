import { accessPolicyStorageKey, channelAccessPolicySchema } from '@wsz987/channel-core';
/**
 * Default resolver backed by the shared ChannelStorage (production wiring is
 * `ctx.channels.resources.storage`). Lazily resolves storage via a getter so it
 * stays decoupled from the Cordis context / ChannelService lifecycle.
 */
export class StoredChannelAccessPolicyResolver {
    getStorage;
    constructor(getStorage) {
        this.getStorage = getStorage;
    }
    async resolve(channelId, accountId) {
        const storage = this.getStorage();
        const raw = await storage.get(accessPolicyStorageKey(channelId, accountId));
        if (raw === undefined)
            return { state: 'missing' };
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return { state: 'invalid', error: 'malformed policy JSON' };
        }
        const result = channelAccessPolicySchema.safeParse(parsed);
        if (!result.success) {
            return { state: 'invalid', error: `policy schema validation failed: ${result.error.message}` };
        }
        return { state: 'present', policy: result.data };
    }
}
//# sourceMappingURL=resolver.js.map