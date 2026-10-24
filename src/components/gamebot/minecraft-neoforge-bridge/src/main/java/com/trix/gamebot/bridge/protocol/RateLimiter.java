package com.trix.gamebot.bridge.protocol;

import java.util.ArrayDeque;

/** 单连接滑动窗口限流。 */
public final class RateLimiter {
    private final int perSecond;
    private final ArrayDeque<Long> stamps = new ArrayDeque<>();

    public RateLimiter(int perSecond) {
        this.perSecond = Math.max(1, perSecond);
    }

    public synchronized boolean tryAcquire(long nowMs) {
        long cutoff = nowMs - 1000L;
        while (!stamps.isEmpty() && stamps.peekFirst() <= cutoff) {
            stamps.removeFirst();
        }
        if (stamps.size() >= perSecond) {
            return false;
        }
        stamps.addLast(nowMs);
        return true;
    }
}
