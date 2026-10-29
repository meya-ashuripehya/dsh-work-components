package com.trix.gamebot.bridge.action;

import com.trix.gamebot.bridge.protocol.RateLimiter;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 按 (agent, request) 记账。每个 agent 单独限流、单独的挂起上限，同时只能有一个长动作。
 * 完成和取消都核对代际：旧连接的迟到结果不能结算新请求。
 */
public final class ActionLedger {
    public static final int PER_AGENT_LIMIT = 32;
    public static final int GLOBAL_LIMIT = 128;

    public enum Status {
        ACCEPTED,
        DUPLICATE,
        RATE_LIMITED,
        TOO_MANY,
        BUSY
    }

    public static final class Decision {
        public final Status status;
        public final String code;
        public final String message;

        private Decision(Status status, String code, String message) {
            this.status = status;
            this.code = code;
            this.message = message;
        }
    }

    public static final class Job {
        public final String agentId;
        public final String requestId;
        public final long generation;
        public final String action;
        public final boolean longAction;

        private Job(String agentId, String requestId, long generation, String action, boolean longAction) {
            this.agentId = agentId;
            this.requestId = requestId;
            this.generation = generation;
            this.action = action;
            this.longAction = longAction;
        }
    }

    private final Map<Key, Job> jobs = new LinkedHashMap<>();
    private final Map<String, RateLimiter> limiters = new LinkedHashMap<>();
    private int perSecond;

    public ActionLedger(int perSecond) {
        this.perSecond = Math.max(1, perSecond);
    }

    public synchronized void setPerSecond(int perSecond) {
        int next = Math.max(1, perSecond);
        if (next != this.perSecond) {
            this.perSecond = next;
            limiters.clear();
        }
    }

    public synchronized Decision accept(String agentId, String requestId, long generation, String action, boolean longAction, long nowMs) {
        if (agentId == null || agentId.isEmpty() || requestId == null || requestId.isEmpty() || action == null || action.isEmpty()) {
            return new Decision(Status.TOO_MANY, "invalid_params", "agent, request_id and action are required");
        }
        Key key = new Key(agentId, requestId);
        Job existing = jobs.get(key);
        if (existing != null) {
            if (existing.generation == generation) {
                return new Decision(Status.DUPLICATE, null, null);
            }
            jobs.remove(key);
        }
        if (longAction && hasLong(agentId)) {
            return new Decision(Status.BUSY, "busy", "this agent already has a long action in progress");
        }
        RateLimiter limiter = limiters.computeIfAbsent(agentId, ignored -> new RateLimiter(perSecond));
        if (!limiter.tryAcquire(nowMs)) {
            return new Decision(Status.RATE_LIMITED, "rate_limited", "too many actions");
        }
        if (count(agentId) >= PER_AGENT_LIMIT || jobs.size() >= GLOBAL_LIMIT) {
            return new Decision(Status.TOO_MANY, "action_rejected", "too many pending actions");
        }
        jobs.put(key, new Job(agentId, requestId, generation, action, longAction));
        return new Decision(Status.ACCEPTED, null, null);
    }

    /** 只取消这个 agent、这一代的请求。找不到就返回 null，不碰别人的动作。 */
    public synchronized Job cancel(String agentId, String requestId, long generation) {
        Job job = get(agentId, requestId, generation);
        return job;
    }

    public synchronized Job get(String agentId, String requestId, long generation) {
        Job job = jobs.get(new Key(agentId, requestId));
        if (job == null || job.generation != generation) {
            return null;
        }
        return job;
    }

    /** 代际不符或已经不在账上时返回 false，调用方不得据此回写结果。 */
    public synchronized boolean complete(String agentId, String requestId, long generation) {
        Job job = jobs.get(new Key(agentId, requestId));
        if (job == null || job.generation != generation) {
            return false;
        }
        jobs.remove(new Key(agentId, requestId));
        return true;
    }

    public synchronized List<Job> failAgent(String agentId, long generation) {
        List<Job> removed = new ArrayList<>();
        Iterator<Job> iterator = jobs.values().iterator();
        while (iterator.hasNext()) {
            Job job = iterator.next();
            if (agentId.equals(job.agentId) && job.generation == generation) {
                removed.add(job);
                iterator.remove();
            }
        }
        return removed;
    }

    public synchronized List<Job> failAll() {
        List<Job> removed = new ArrayList<>(jobs.values());
        jobs.clear();
        return removed;
    }

    /** 只读副本，不摘账。代际是否仍可结算仍由 complete 判断。 */
    public synchronized List<Job> snapshot() {
        return new ArrayList<>(jobs.values());
    }

    public synchronized int pending(String agentId) {
        return count(agentId);
    }

    public synchronized int pending() {
        return jobs.size();
    }

    public synchronized boolean has(String agentId, String requestId, long generation) {
        return get(agentId, requestId, generation) != null;
    }

    private boolean hasLong(String agentId) {
        for (Job job : jobs.values()) {
            if (agentId.equals(job.agentId) && job.longAction) {
                return true;
            }
        }
        return false;
    }

    private int count(String agentId) {
        int count = 0;
        for (Job job : jobs.values()) {
            if (agentId.equals(job.agentId)) {
                count++;
            }
        }
        return count;
    }

    private record Key(String agentId, String requestId) {
    }
}
