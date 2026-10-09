/**
 * Secret store handed to adapters.
 *
 * Adapters never receive credentials from plugin config in plaintext logs;
 * they resolve them through this interface. The default in-memory
 * implementation keeps values out of logs and debug dumps.
 */
/** Default in-memory secret store used when an adapter config provides none. */
export class MemorySecretStore {
    values = new Map();
    constructor(options = {}) {
        if (options.initial) {
            for (const [name, value] of Object.entries(options.initial)) {
                this.values.set(name.toLowerCase(), value);
            }
        }
    }
    async get(name) {
        return this.values.get(name.toLowerCase());
    }
    async set(name, value) {
        this.values.set(name.toLowerCase(), value);
    }
    async delete(name) {
        this.values.delete(name.toLowerCase());
    }
}
//# sourceMappingURL=secrets.js.map