export class QQStreamingReply {
    stream;
    text = '';
    constructor(stream) {
        this.stream = stream;
    }
    async append(delta) {
        this.text += delta;
        await this.stream.update(this.text);
    }
    async replace(message) {
        this.text = message.text ?? '';
        await this.stream.update(this.text);
    }
    async finish(message) {
        if (message?.text !== undefined && message.text !== this.text) {
            this.text = message.text;
            await this.stream.update(this.text);
        }
        await this.stream.complete();
    }
    async fail() {
        this.stream.cancel();
    }
}
//# sourceMappingURL=streaming-reply.js.map