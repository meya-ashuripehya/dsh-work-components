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

    public MovementSession(NavCandidate locked, double tolerance, MovementExclusions exclusions, long deadlineMs) {
        this.locked = locked;
        this.tolerance = tolerance;
        this.exclusions = exclusions;
        this.deadlineMs = deadlineMs;
    }

    public Vec3 goal() {
        return new Vec3(locked.x(), locked.y(), locked.z());
    }
}
