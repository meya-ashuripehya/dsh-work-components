/**
 * HTTP transport boundary.
 *
 * The transport is the single injection point for tests: the adapter is built
 * against `HttpTransport`, and a fake transport replaces the network without
 * touching driver logic. Timeouts abort the underlying fetch; an external
 * `signal` is combined with the request timeout.
 *
 * Credential hygiene (§23): bearer-style path segments — the Telegram Bot API
 * embeds the token in the request path (`/bot<token>/...`) — are redacted
 * from error messages so a token can never reach logs.
 */
import { ChannelError } from '@wsz987/channel-core';
/** Redact bearer-style path segments (e.g. `/bot<token>` / `/file/bot<token>`) from messages. */
function redactPath(path) {
    return path.replace(/\/bot[^/?#]+/g, '/bot<redacted>');
}
/** Default transport backed by the standard `fetch`. */
export class FetchTransport {
    timeoutMs;
    fetchImpl;
    constructor(baseUrl, options) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.timeoutMs = options.timeoutMs;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }
    baseUrl;
    async request(path, init = {}, signal) {
        // [dsh-telegram-temp patch] the timeout covers headers AND body read.
        return this.withResponse(path, init, signal, async (response) => {
            const text = await response.text();
            if (!text) {
                if (!response.ok) {
                    throw new ChannelError('CHANNEL_ERROR', `telegram http ${response.status} on ${redactPath(path)}`);
                }
                return undefined;
            }
            try {
                return JSON.parse(text);
            }
            catch (error) {
                throw new ChannelError('CHANNEL_ERROR', `telegram http returned invalid JSON on ${redactPath(path)}`, { cause: error });
            }
        });
    }
    async requestBinary(path, init = {}, signal) {
        // [dsh-telegram-temp patch] the timeout covers headers AND body read.
        return this.withResponse(path, init, signal, async (response) => {
            if (!response.ok) {
                throw new ChannelError('CHANNEL_ERROR', `telegram http ${response.status} on ${redactPath(path)}`);
            }
            const buffer = await response.arrayBuffer();
            return {
                data: new Uint8Array(buffer),
                contentType: response.headers.get('content-type') ?? undefined,
                contentDisposition: response.headers.get('content-disposition') ?? undefined,
            };
        });
    }
    /**
     * [dsh-telegram-temp patch] Run fetch + `consume(response)` (body read)
     * under ONE AbortController, so a stalled body can no longer hang forever:
     * the request timeout and the outer signal both abort the body stream too.
     */
    async withResponse(path, init, signal, consume) {
        const controller = new AbortController();
        const timeoutMs = init.timeoutMs ?? this.timeoutMs;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const onOuterAbort = () => controller.abort();
        if (signal?.aborted)
            controller.abort();
        else
            signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
            const response = await this.fetchWith(path, init, controller);
            try {
                return await consume(response);
            }
            catch (error) {
                if (error instanceof ChannelError)
                    throw error;
                const aborted = error?.name === 'AbortError' || controller.signal.aborted;
                throw new ChannelError('CHANNEL_ERROR', aborted
                    ? `telegram http ${timedOut ? 'timed out' : 'aborted'} reading body on ${redactPath(path)}`
                    : `telegram http body read failed on ${redactPath(path)}`, { cause: error });
            }
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuterAbort);
        }
    }
    /** Issue the fetch on an existing controller (no timer handling here). */
    async fetchWith(path, init, controller) {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
                    ...init.headers,
                },
                body: init.body instanceof FormData
                    ? init.body
                    : init.body !== undefined
                        ? JSON.stringify(init.body)
                        : undefined,
                signal: controller.signal,
            });
            return response;
        }
        catch (error) {
            if (error instanceof ChannelError)
                throw error;
            const aborted = error?.name === 'AbortError' || controller.signal.aborted;
            throw new ChannelError('CHANNEL_ERROR', aborted ? `telegram http aborted on ${redactPath(path)}` : `telegram http failed on ${redactPath(path)}`, { cause: error });
        }
    }
    /**
     * Fetch one response under the request timeout + outer signal (headers
     * only). Kept for API compatibility; internal callers use withResponse.
     */
    async requestResponse(path, init = {}, signal) {
        const controller = new AbortController();
        const timeoutMs = init.timeoutMs ?? this.timeoutMs;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onOuterAbort = () => controller.abort();
        signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
                    ...init.headers,
                },
                body: init.body instanceof FormData
                    ? init.body
                    : init.body !== undefined
                        ? JSON.stringify(init.body)
                        : undefined,
                signal: controller.signal,
            });
            return response;
        }
        catch (error) {
            if (error instanceof ChannelError)
                throw error;
            const aborted = error?.name === 'AbortError' || controller.signal.aborted;
            throw new ChannelError('CHANNEL_ERROR', aborted ? `telegram http aborted on ${redactPath(path)}` : `telegram http failed on ${redactPath(path)}`, { cause: error });
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuterAbort);
        }
    }
}
//# sourceMappingURL=transport.js.map