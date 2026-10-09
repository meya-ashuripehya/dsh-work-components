/**
 * AgentManager — the single place that touches `ctx.agents`.
 *
 * Ownership model (doc H0.4/H0.7):
 * - `ctx.agents.get()` returns a live agent the bridge does NOT own — it is
 *   never disposed here.
 * - `ctx.agents.create()` / `ctx.agents.resume()` return an `AgentHandle`;
 *   the bridge MUST hold every handle it created/resumed and dispose it on
 *   plugin unload. Owned handles live in `owned` and are disposed exactly
 *   once by `disposeAll()`.
 *
 * Routing is expressed as an `AgentRouteSpec`, never an `agentId` (the
 * Harness Agent identity is the `SessionId`). `create` and `resume` receive
 * the SAME route so provider/model/maxTokens stay identical on both paths
 * (doc H0.5 route parity).
 *
 * Create-vs-resume is decided by the CALLER (the bridge), not by error-regex
 * fallback. Persistence is an OPTIONAL capability resolved LIVE at the use
 * site: `canResume()` tells the caller whether a sessionPersistence service
 * is currently mounted, `exists()` probes membership via the live service,
 * and `probePersisted()` answers the atomic unavailable/present/missing
 * question in one resolver call (no canResume/exists TOCTOU across a
 * persistence HMR) — corruption / unsupported-format / backend failures
 * propagate loudly rather than being misread as "no persistence".
 *
 * Global concurrency gate: at most `maxConcurrency` `create()`/`resume()` calls
 * are in flight at once across all sessions; `get()` (a live lookup) is never
 * limited.
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets';
/** Persistence was configured for the binding, but is unavailable right now. */
export class PersistenceUnavailableError extends Error {
    sessionId;
    bindingKey;
    constructor(sessionId, bindingKey) {
        super(`persistence is temporarily unavailable for session '${sessionId}'` +
            (bindingKey ? ` (binding '${bindingKey}')` : '') +
            '; refusing to recreate a durable channel session');
        this.sessionId = sessionId;
        this.bindingKey = bindingKey;
        this.name = 'PersistenceUnavailableError';
    }
}
/**
 * A durable binding references a persisted session that no longer exists
 * (session-not-found, aligned with the official Host's
 * "persisted identity missing -> session-not-found"). With a
 * sessionPersistence service mounted, a missing persisted session behind an
 * existing binding is a binding/session durability inconsistency — NEVER a
 * first create — so resolution fails loudly instead of silently
 * blank-recreating the same session id. Deployments WITHOUT persistence
 * explicitly ephemeral bindings never throw this: they recreate on the recorded id.
 */
export class SessionNotFoundError extends Error {
    sessionId;
    bindingKey;
    constructor(sessionId, bindingKey) {
        super(`session '${sessionId}' not found in persistence: the binding` +
            (bindingKey ? ` '${bindingKey}'` : '') +
            ` references a durable session that no longer exists (binding/session ` +
            `durability inconsistency); refusing to silently recreate it. Restore ` +
            `the session or clear/repair the binding.`);
        this.sessionId = sessionId;
        this.bindingKey = bindingKey;
        this.name = 'SessionNotFoundError';
    }
}
/** Filter out undefined optional agentOptions fields (route parity helper). */
export function optionsFor(route) {
    const options = {};
    if (route.provider)
        options.provider = route.provider;
    if (route.model)
        options.model = route.model;
    if (route.maxTokens !== undefined)
        options.maxTokens = route.maxTokens;
    return Object.keys(options).length > 0 ? options : undefined;
}
/**
 * Resolve a route's provider/model, falling back to Harness's default model
 * selection when the route leaves the model unset.
 *
 * `{{model}}` (the persona variable that fails with "prompt variable has no
 * value") depends only on `model`, so a route that already pins a model —
 * with or without a provider — is left untouched. Only a missing model is
 * filled from the default (and the default's provider rides along when the
 * route also left provider unset).
 *
 * The default model is read live (per agent creation), so new channel sessions
 * follow the user's Harness-wide default while sessions pinned to an explicit
 * route keep their own provider/model.
 */
export function resolveRoute(route, defaultSelection) {
    if (route.model)
        return route;
    if (!defaultSelection?.model)
        return route;
    return {
        ...route,
        model: defaultSelection.model,
        provider: route.provider ?? defaultSelection.provider,
    };
}
/**
 * Probe a persisted session's existence through the persistence service's
 * `list()` membership. A session that is absent returns `false`; any backend
 * failure (corruption, unsupported format, connectivity) propagates loudly.
 *
 * The persistence service is resolved LIVE on every call (a resolver, not a
 * startup snapshot): a sessionPersistence mounted/unmounted/replaced after
 * the bridge started is observed on the next probe — reversible Cordis
 * lifecycle parity, since `ctx.get` only returns currently active providers.
 */
export class PersistenceMembershipProbe {
    resolvePersistence;
    constructor(resolvePersistence) {
        this.resolvePersistence = resolvePersistence;
    }
    async exists(sessionId) {
        const persistence = this.resolvePersistence();
        if (!persistence)
            return false;
        const headers = await persistence.list();
        const target = sessionId;
        return headers.some((header) => persistedSessionId(header) === target);
    }
    /** Atomic probe: the live capability is resolved exactly once per call. */
    async probe(sessionId) {
        const persistence = this.resolvePersistence();
        if (!persistence)
            return 'unavailable';
        const headers = await persistence.list();
        return headers.some((header) => persistedSessionId(header) === sessionId) ? 'present' : 'missing';
    }
}
/**
 * Session V3 persistence `list()` always returns snapshots. Identity lives in
 * the snapshot header; the bridge intentionally does not retain the removed
 * pre-V3 bare-header compatibility path.
 */
function persistedSessionId(entry) {
    return String(entry.header.id);
}
/**
 * Read one durable V3 session through the public read handle. A channel bridge
 * never depends on an implementation-specific persistence reader.
 */
export async function resolvePersistedInspection(persistence, sessionId) {
    const handle = await persistence.open(sessionId, 'read');
    try {
        return {
            meta: handle.header,
            events: (await handle.read()).events,
        };
    }
    finally {
        await handle.close();
    }
}
/**
 * Reconstruct the preset a persisted session actually runs, from its durable
 * inspection: the creation header's `agentPreset` advanced by every
 * `agent-preset/selected` event via the official
 * `agentPresetProjectionDefinition` fold.
 */
function resolvePersistedPreset(header, events) {
    let state = agentPresetProjectionDefinition.init(header);
    for (const event of events) {
        state = agentPresetProjectionDefinition.apply(state, event);
    }
    return state ?? undefined;
}
/**
 * Real gateway over `ctx.agents`. This is the only Harness import surface in
 * the bridge (besides the `session/event` feed consumed by ReplyRouter).
 *
 * Persistence is an OPTIONAL capability resolved LIVE at the use site: the
 * caller passes a resolver (`() => ctx.get('sessionPersistence')`), so
 * `canResume()` and the existence probe reflect the service's CURRENT
 * presence — mounting, unmounting, or replacing the service after the bridge
 * started is observed on the next probe (never a startup snapshot).
 */
export class HarnessAgentGateway {
    ctx;
    probe;
    resolvePersistence;
    /**
     * All persisted session ids (shape-tolerant, issue #8) — the `/bind`
     * resolution universe. Empty when no persistence is mounted.
     */
    async listPersistedSessionIds() {
        const persistence = this.resolvePersistence();
        if (!persistence)
            return [];
        const rows = await persistence.list();
        return rows.map((row) => persistedSessionId(row));
    }
    /**
     * The persisted Agent preset of one session (issue #6 route parity): the
     * official `agentPresetProjectionDefinition` fold over the durable
     * inspection. Undefined when no persistence / no recorded preset.
     */
    async persistedPresetOf(sessionId) {
        const persistence = this.resolvePersistence();
        if (!persistence)
            return undefined;
        const inspection = await resolvePersistedInspection(persistence, SessionId(sessionId));
        return inspection ? resolvePersistedPreset(inspection.meta, inspection.events) : undefined;
    }
    constructor(ctx, resolvePersistence) {
        this.ctx = ctx;
        this.resolvePersistence = resolvePersistence ?? (() => undefined);
        this.probe = new PersistenceMembershipProbe(this.resolvePersistence);
    }
    get(sessionId) {
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (!agent)
            return undefined;
        return {
            id: agent.id,
            agent,
            followup: (message) => agent.followup(message),
            whenIdle: () => agent.whenIdle(),
        };
    }
    canResume() {
        // Only a currently mounted sessionPersistence service enables resume.
        return this.resolvePersistence() !== undefined;
    }
    async exists(sessionId) {
        return this.probe.exists(sessionId);
    }
    async probePersisted(sessionId) {
        return this.probe.probe(sessionId);
    }
    /** Read Harness's live default-model selection (undefined when absent). */
    defaultSelection() {
        const service = this.ctx.get('agentDefaultModel');
        return service?.currentSelection();
    }
    /**
     * Resolve and mount the official Agent preset before publication, matching
     * the Harness Host's create/resume composition boundary. Without this join,
     * preset-scoped tools such as `ask_user_question` are invisible to the Agent.
     */
    async composePreset(presetId, setup) {
        const presets = this.ctx.get('agentPresets');
        // Test/minimal hosts without the optional roster retain the historical
        // metadata behavior; the official runtime always provides this service.
        if (!presets)
            return { agentPreset: presetId, setup };
        const resolvedId = (await presets.resolve(presetId)).id;
        return {
            agentPreset: resolvedId,
            setup: async (agentCtx, agent) => {
                await presets.mount(agentCtx, resolvedId);
                return setup?.(agentCtx, agent);
            },
        };
    }
    async create(sessionId, route, setup, meta) {
        const resolved = resolveRoute(route, this.defaultSelection());
        const composition = await this.composePreset(resolved.preset, setup);
        const handle = await this.ctx.agents.create({
            sessionId: SessionId(sessionId),
            // `{{cwd}}` reads `session.header.cwd`, and `dsh-workspace` groups the
            // session under the workspace whose path matches that cwd. The cwd is
            // decided by the CALLER (the bridge) and passed through `meta.cwd` —
            // `HarnessAgentGateway` only creates the session with the given cwd and
            // never falls back to `process.cwd()`. This must be set at creation —
            // `resume` has no `meta` and cannot add it later.
            meta: {
                ...(meta?.cwd ? { cwd: meta.cwd } : {}),
                ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
            },
            agentOptions: optionsFor(resolved),
            setup: composition.setup,
        });
        return this.wrap(handle);
    }
    async resume(sessionId, route, setup) {
        // Route parity (doc H0.5): resume uses the SAME optionsFor(resolveRoute(...))
        // as create. NEVER `model ?? agentId`.
        const resolved = resolveRoute(route, this.defaultSelection());
        const persistence = this.resolvePersistence();
        const inspected = persistence
            ? await resolvePersistedInspection(persistence, SessionId(sessionId))
            : undefined;
        const persistedPreset = inspected
            ? resolvePersistedPreset(inspected.meta, inspected.events)
            : undefined;
        if (persistedPreset && resolved.preset && persistedPreset !== resolved.preset) {
            throw new AgentPresetConflictError(sessionId, resolved.preset, persistedPreset);
        }
        // Persisted composition wins. Sessions created before Agent presets were
        // recorded have no value, so they intentionally adopt the current default.
        const composition = await this.composePreset(persistedPreset ?? resolved.preset, setup);
        const handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(sessionId),
            agentOptions: optionsFor(resolved),
            setup: composition.setup,
        });
        return this.wrap(handle);
    }
    wrap(handle) {
        return {
            id: handle.agent.id,
            agent: handle.agent,
            followup: (message) => handle.agent.followup(message),
            whenIdle: () => handle.agent.whenIdle(),
            dispose: () => handle.dispose(),
        };
    }
}
export class AgentManager {
    gateway;
    logger;
    inFlight = new Map();
    /** Handles this manager created/resumed — the ones it must dispose. */
    owned = new Map();
    /** Resolved refs, kept for drain (`whenIdle`) lookups. */
    refs = new Map();
    /** Agents that already received the one-time channel-command setup. */
    configuredAgents = new WeakSet();
    /** sessionId -> binding, the reverse lookup used by the ReplyRouter. */
    bindings = new Map();
    maxConcurrency;
    active = 0;
    /** Waiters queued for a free concurrency slot. */
    waiters = [];
    closed = false;
    constructor(gateway, logger, maxConcurrency = 4) {
        this.gateway = gateway;
        this.logger = logger;
        this.maxConcurrency = Math.max(1, maxConcurrency);
    }
    /** Whether a sessionPersistence service enables `resume`. */
    canResume() {
        return this.gateway.canResume();
    }
    /** Probe whether a persisted session exists. Backend failures propagate. */
    exists(sessionId) {
        return this.gateway.exists(sessionId);
    }
    /**
     * Atomic persistence probe: resolves the LIVE capability once and answers
     * `unavailable` / `present` / `missing` — the bridge's single decision
     * point for recreate-vs-resume-vs-fail, immune to a persistence HMR between
     * `canResume()` and `exists()`.
     */
    async probePersisted(sessionId) {
        if (this.gateway.probePersisted)
            return this.gateway.probePersisted(sessionId);
        // Fallback for minimal test gateways without the atomic probe: two live
        // lookups (deterministic in tests).
        if (!this.gateway.canResume())
            return 'unavailable';
        return (await this.gateway.exists(sessionId)) ? 'present' : 'missing';
    }
    /**
     * Create a NEW agent for a session (no prior binding). Calls
     * `gateway.create` directly (under the concurrency slot), owns the handle,
     * and returns the ref. Never resumes — the caller already decided this is a
     * fresh conversation. Single-flight per session id.
     */
    create(sessionId, route, setup, meta) {
        if (this.closed) {
            return Promise.reject(new Error(`AgentManager is closed; cannot create '${sessionId}'`));
        }
        const pending = this.inFlight.get(sessionId);
        if (pending)
            return pending;
        const run = this.doCreate(sessionId, route, setup, meta);
        this.inFlight.set(sessionId, run);
        void run.then(() => {
            this.inFlight.delete(sessionId);
        }, () => {
            this.inFlight.delete(sessionId);
        });
        return run;
    }
    /**
     * Resolve an agent for an EXISTING, persisted session: live `get` first; on
     * a miss, `gateway.resume(route)`. A resume failure propagates loudly
     * (throws) — never falls back to create and never sniffs error messages.
     * Single-flight per session id.
     */
    resolve(sessionId, route, setup) {
        if (this.closed) {
            return Promise.reject(new Error(`AgentManager is closed; cannot resolve '${sessionId}'`));
        }
        const pending = this.inFlight.get(sessionId);
        if (pending)
            return pending;
        const run = this.doResolve(sessionId, route, setup);
        this.inFlight.set(sessionId, run);
        void run.then(() => {
            this.inFlight.delete(sessionId);
        }, () => {
            this.inFlight.delete(sessionId);
        });
        return run;
    }
    /**
     * Borrow the LIVE agent for a session, when one is loaded in this process.
     * Returns `undefined` when there is no live agent — the caller (the Session
     * factory, for channel-session lifecycle decisions) decides what to do next
     * (resume, or a cwd/workspace-aware recreate). Never creates or resumes and
     * never takes ownership (the borrowed agent is never disposed here). Runs
     * the one-time setup against a borrowed agent, exactly once.
     */
    borrowIfLive(sessionId, route, setup) {
        if (this.closed) {
            return Promise.reject(new Error(`AgentManager is closed; cannot borrow '${sessionId}'`));
        }
        return this.doBorrowIfLive(sessionId, route, setup);
    }
    /** Register the binding associated with a session (reverse reply routing). */
    registerBinding(binding) {
        this.bindings.set(binding.sessionId, binding);
    }
    /** Reverse lookup for the ReplyRouter. */
    bindingFor(sessionId) {
        return this.bindings.get(sessionId);
    }
    /**
     * Live agent lookup for the /stop fast path (spec §8). Returns the raw
     * Agent when it is currently live in this process — NEVER creates or
     * resumes a session just to answer this probe.
     */
    getLiveAgent(sessionId) {
        return this.gateway.get(sessionId)?.agent;
    }
    /** Resolved ref for drain purposes, if any. */
    refFor(sessionId) {
        return this.refs.get(sessionId);
    }
    /** Session ids that currently have an active turn (for drain). */
    activeSessions() {
        return [...this.bindings.keys()];
    }
    /**
     * Dispose every owned handle exactly once and clear all tracking. Agents
     * obtained via `gateway.get()` (not owned) are never disposed.
     */
    async disposeAll() {
        this.closed = true;
        const waiters = this.waiters.splice(0);
        for (const wake of waiters)
            wake();
        const handles = [...this.owned.values()];
        this.owned.clear();
        this.refs.clear();
        this.bindings.clear();
        const results = await Promise.allSettled(handles.map((handle) => handle.dispose()));
        for (const result of results) {
            if (result.status === 'rejected') {
                this.logger.error(`failed to dispose an owned agent handle`, result.reason);
            }
        }
    }
    /**
     * Dispose a single owned handle (used to roll back a create whose binding
     * write failed afterward). No-op for handles the manager does not own.
     */
    async disposeSession(sessionId) {
        const handle = this.owned.get(sessionId);
        if (!handle)
            return;
        this.owned.delete(sessionId);
        this.refs.delete(sessionId);
        this.bindings.delete(sessionId);
        try {
            await handle.dispose();
        }
        catch (error) {
            this.logger.error(`failed to dispose owned agent handle for '${sessionId}'`, error);
        }
    }
    /**
     * Retire a session's reference and reverse binding and dispose it ONLY if the
     * manager owns the handle. Borrowed / unknown agents are released
     * from local tracking but NEVER disposed. Retiring never touches persisted
     * history — the old session keeps its durable log.
     */
    async retireSession(sessionId) {
        this.refs.delete(sessionId);
        this.bindings.delete(sessionId);
        const handle = this.owned.get(sessionId);
        if (!handle)
            return;
        this.owned.delete(sessionId);
        try {
            await handle.dispose();
        }
        catch (error) {
            this.logger.error(`failed to dispose owned agent handle for '${sessionId}'`, error);
        }
    }
    /**
     * One-time channel-command setup for a BORROWED live agent. A
     * borrowed agent never went through create/resume, so its setup could not
     * have run at publication; run it here exactly once against the agent's
     * scoped context. Setup failure propagates to the caller. The borrowed
     * agent is never disposed here.
     */
    async ensureBorrowedSetup(agent, setup) {
        if (!setup)
            return;
        if (this.configuredAgents.has(agent.agent))
            return;
        const commit = await setup(agent.agent.ctx, agent.agent);
        commit?.commit();
        this.configuredAgents.add(agent.agent);
    }
    async doCreate(sessionId, route, setup, meta) {
        return this.withSlot(async () => {
            const handle = await this.gateway.create(sessionId, route, setup, meta);
            this.owned.set(sessionId, handle);
            if (setup)
                this.configuredAgents.add(handle.agent);
            return this.makeRef(sessionId, route, handle);
        });
    }
    async doResolve(sessionId, route, setup) {
        const live = this.gateway.get(sessionId);
        if (live) {
            await this.ensureBorrowedSetup(live, setup);
            return this.makeRef(sessionId, route, live);
        }
        return this.withSlot(async () => {
            const handle = await this.gateway.resume(sessionId, route, setup);
            this.owned.set(sessionId, handle);
            if (setup)
                this.configuredAgents.add(handle.agent);
            return this.makeRef(sessionId, route, handle);
        });
    }
    async doBorrowIfLive(sessionId, route, setup) {
        const live = this.gateway.get(sessionId);
        if (!live)
            return undefined;
        await this.ensureBorrowedSetup(live, setup);
        return this.makeRef(sessionId, route, live);
    }
    async withSlot(fn) {
        await this.acquireSlot();
        try {
            return await fn();
        }
        finally {
            this.releaseSlot();
        }
    }
    async acquireSlot() {
        while (true) {
            if (this.closed) {
                throw new Error(`AgentManager is closed; cannot resolve a session`);
            }
            if (this.active < this.maxConcurrency) {
                this.active += 1;
                return;
            }
            await new Promise((resolve) => this.waiters.push(resolve));
        }
    }
    releaseSlot() {
        this.active -= 1;
        const next = this.waiters.shift();
        if (next)
            next();
    }
    makeRef(sessionId, route, agent) {
        const ref = {
            sessionId,
            route,
            agent: agent.agent,
            followup: (message) => agent.followup(message),
            whenIdle: () => agent.whenIdle(),
            release: () => {
                // Simple ownership: release is a marker; actual disposal happens once
                // in disposeAll() for handles this manager owns.
            },
        };
        this.refs.set(sessionId, ref);
        return ref;
    }
}
/** A durable session cannot be silently recomposed under a different preset. */
export class AgentPresetConflictError extends Error {
    sessionId;
    requested;
    persisted;
    constructor(sessionId, requested, persisted) {
        super(`session '${sessionId}' uses Agent preset '${persisted}', but route requested '${requested}'`);
        this.sessionId = sessionId;
        this.requested = requested;
        this.persisted = persisted;
        this.name = 'AgentPresetConflictError';
    }
}
//# sourceMappingURL=agent-manager.js.map