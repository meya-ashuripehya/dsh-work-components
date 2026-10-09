/**
 * Small key/value storage handed to adapters for durable channel state
 * (e.g. cursor positions, dedup windows). The Harness bridge keeps its own
 * session-binding storage — adapters never touch that.
 */
/** Default in-memory storage (lost on restart). Adapters may provide a durable one. */
export class MemoryStorage {
    values = new Map();
    async get(key) {
        return this.values.get(key);
    }
    async set(key, value) {
        this.values.set(key, value);
    }
    async delete(key) {
        this.values.delete(key);
    }
}
//# sourceMappingURL=storage.js.map