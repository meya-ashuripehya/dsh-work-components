/** Derive the reply strategy from the adapter's streaming capability. */
export function replyStrategyFromCapabilities(capabilities) {
    return capabilities.streaming;
}
/**
 * Generic accumulate-and-flush reply for platforms without native or
 * editable streaming. Deltas accumulate into a buffer; `finish()` delivers
 * once, `fail()` discards without delivery.
 */
export class BufferedReply {
    options;
    buffer = '';
    finished = false;
    failed = false;
    constructor(options) {
        this.options = options;
    }
    async append(delta) {
        if (this.finished || this.failed)
            return;
        this.buffer += delta;
        await this.options.onDelta?.(this.buffer);
    }
    async replace(message) {
        if (this.finished || this.failed)
            return;
        if (message.text === undefined)
            return;
        this.buffer = message.text;
        await this.options.onDelta?.(this.buffer);
    }
    async finish(message) {
        if (this.finished || this.failed)
            return;
        this.finished = true;
        const text = message?.text ?? this.buffer;
        if (text) {
            await this.options.deliver(text);
        }
    }
    async fail() {
        this.failed = true;
        this.buffer = '';
    }
}
//# sourceMappingURL=reply.js.map