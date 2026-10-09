const MESSAGES = {
    CHANNEL_ERROR: 'channel error',
    CHANNEL_START_FAILED: 'channel failed to start',
    CHANNEL_STOP_FAILED: 'channel failed to stop',
    CHANNEL_SEND_FAILED: 'channel failed to send message',
    CHANNEL_AUTH_FAILED: 'channel authentication failed',
    CHANNEL_DUPLICATE_ID: 'a channel adapter with this id is already registered',
    CHANNEL_NOT_STARTED: 'channel adapter is not started',
    CHANNEL_UNSUPPORTED: 'operation not supported by this channel adapter',
};
/** Base channel error. */
export class ChannelError extends Error {
    code;
    constructor(code = 'CHANNEL_ERROR', message, options) {
        super(message ?? MESSAGES[code], options);
        this.name = 'ChannelError';
        this.code = code;
    }
}
export class ChannelStartError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_START_FAILED', message, options);
        this.name = 'ChannelStartError';
    }
}
export class ChannelStopError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_STOP_FAILED', message, options);
        this.name = 'ChannelStopError';
    }
}
export class ChannelSendError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_SEND_FAILED', message, options);
        this.name = 'ChannelSendError';
    }
}
export class ChannelAuthError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_AUTH_FAILED', message, options);
        this.name = 'ChannelAuthError';
    }
}
export class ChannelDuplicateError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_DUPLICATE_ID', message, options);
        this.name = 'ChannelDuplicateError';
    }
}
export class ChannelNotStartedError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_NOT_STARTED', message, options);
        this.name = 'ChannelNotStartedError';
    }
}
export class ChannelUnsupportedError extends ChannelError {
    constructor(message, options) {
        super('CHANNEL_UNSUPPORTED', message, options);
        this.name = 'ChannelUnsupportedError';
    }
}
/** Whether an error is a channel error with the given code. */
export function isChannelError(error, code) {
    if (!(error instanceof ChannelError))
        return false;
    return code === undefined || error.code === code;
}
/** Normalize an unknown thrown value into a ChannelError with a stable code. */
export function toChannelError(error, code, fallback) {
    if (error instanceof ChannelError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    return new ChannelError(code, fallback ?? message);
}
/**
 * Cordis throws its own errors (e.g. `CordisError`); keep a stable code for
 * them without depending on cordis internals at call sites.
 */
export function normalizeError(error) {
    if (error instanceof Error)
        return error;
    if (typeof error === 'string')
        return new Error(error);
    return new Error(String(error));
}
//# sourceMappingURL=errors.js.map