/**
 * Per-chat edit/draft throttle and 429 cooldown (channel-telegram draft-stream patch).
 * Token bucket: ~1 update/s per chat; groups also capped at 18/min.
 */
export class StreamThrottle {
    constructor({ isGroup = false, minIntervalMs = 1200, groupPerMinute = 18 } = {}) {
        this.minIntervalMs = Math.max(200, minIntervalMs);
        this.groupPerMinute = groupPerMinute;
        this.isGroup = isGroup;
        this.nextAt = 0;
        this.minuteWindow = [];
        this.cooldownUntil = 0;
        this.backoffMs = 0;
    }
    /** Milliseconds until the next update is allowed (0 = now). */
    waitMs(now = Date.now()) {
        this.prune(now);
        const until = Math.max(this.nextAt, this.cooldownUntil);
        return Math.max(0, until - now);
    }
    /** Record a successful update. */
    mark(now = Date.now()) {
        this.prune(now);
        this.nextAt = now + this.minIntervalMs;
        if (this.isGroup) this.minuteWindow.push(now);
        this.backoffMs = 0;
    }
    /** Honor Telegram 429 retry_after (seconds) with 10% jitter; escalate backoff up to 5s. */
    onRateLimit(retryAfterSec, now = Date.now()) {
        const hinted = Number.isFinite(retryAfterSec) ? Math.max(1, Math.ceil(retryAfterSec)) * 1000 : 1000;
        this.backoffMs = Math.min(5000, Math.max(this.backoffMs * 2 || hinted, hinted));
        const jitter = Math.floor(this.backoffMs * 0.1 * Math.random());
        this.cooldownUntil = Math.max(this.cooldownUntil, now + this.backoffMs + jitter);
        this.nextAt = Math.max(this.nextAt, this.cooldownUntil);
        return this.cooldownUntil - now;
    }
    prune(now) {
        if (!this.isGroup) return;
        const cut = now - 60_000;
        this.minuteWindow = this.minuteWindow.filter((t) => t >= cut);
        if (this.minuteWindow.length >= this.groupPerMinute) {
            const oldest = this.minuteWindow[0];
            this.nextAt = Math.max(this.nextAt, oldest + 60_000);
        }
    }
}
