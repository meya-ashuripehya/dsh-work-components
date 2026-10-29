package com.trix.gamebot.bridge.action;

import net.minecraft.world.phys.Vec3;

/** In-flight navigation state for one locked candidate goal. */
public final class MovementSession {
    public final NavCandidate locked;
    public final double tolerance;
    public final MovementExclusions exclusions;
    public final long deadlineMs;
    public int replans;
    public int planChecks;
    public boolean awaitingStop;
    public long stopRequestedAtMs;
    String diagnosticAgentId;
    long diagnosticGeneration;
    String diagnosticRequestId;
    boolean diagnosticStopLogged;
    boolean diagnosticStopCompleteLogged;

    public MovementSession(NavCandidate locked, double tolerance, MovementExclusions exclusions, long deadlineMs) {
        this.locked = locked;
        this.tolerance = tolerance;
        this.exclusions = exclusions;
        this.deadlineMs = deadlineMs;
    }

    public Vec3 goal() {
        return new Vec3(locked.x(), locked.y(), locked.z());
    }

    void correlate(String agentId, long generation, String requestId) {
        this.diagnosticAgentId = agentId;
        this.diagnosticGeneration = generation;
        this.diagnosticRequestId = requestId;
    }
}
