import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm';
import { formatChannelTurnFailure } from './failure-display.js';
import { buildProcessHtml, shouldShowProcess } from './segmented-reply.js';

/**
 * Routes channel-bound session assistant output to the matching ChannelAdapter.
 * [dsh-workbench patch] interleaved segments: per step a process blockquote
 * (reasoning + tool one-liners) and a separate streamed text message.
 */
export class ReplyRouter {
    options;
    active = new Map();
    streamTurns = new Map();
    // [dsh-telegram-temp patch] tool-result images collected for channel-originated turns.
    pendingImages = new Map();
    currentTurns = new Map();
    attachCtx = undefined;
    constructor(options) {
        this.options = options;
    }
    /** Register the `session/event` listener; returns a disposer. */
    attach(ctx) {
        this.attachCtx = ctx;
        const stopSessionEvents = ctx.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        const stopAssistantStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
            this.onAssistantStream(agent, frame);
        });
        return () => stopSessionEvents() && stopAssistantStream();
    }
    replyOpts() {
        const r = this.options.config?.reply || {};
        return {
            updateIntervalMs: r.updateIntervalMs ?? 200,
            sendReasoning: r.sendReasoning === true,
            showToolCalls: r.showToolCalls !== false,
            reasoningMaxChars: r.reasoningMaxChars ?? 1500,
        };
    }
    onAssistantStream(agent, frame) {
        const key = `${agent.id}:${frame.attemptId}`;
        if (frame.type === 'start') {
            this.streamTurns.set(key, frame.turn);
            const active = this.active.get(String(agent.session.id));
            if (active) {
                active.suppressLiveDeltas = false;
                active.liveAttemptId = String(frame.attemptId);
                active.liveAttemptBase = (active.textBuffer || '').length;
                active.liveAttemptSawText = false;
            }
            return;
        }
        if (frame.type === 'end') {
            this.streamTurns.delete(key);
            return;
        }
        const turn = this.streamTurns.get(key);
        if (turn === undefined) return;
        const active = this.ensureActive(agent.session, turn);
        if (!active) return;
        const chunk = frame.chunk;
        if (!chunk) return;
        if (chunk.type === 'reasoning-delta') {
            if (!this.replyOpts().sendReasoning) return;
            active.reasoning = (active.reasoning || '') + (chunk.text || '');
            void this.flushProcess(active);
            return;
        }
        if (chunk.type === 'tool-call-delta') {
            if (!this.replyOpts().showToolCalls) return;
            const id = chunk.id || `idx-${chunk.index}`;
            let tool = active.tools.get(id);
            if (!tool) {
                tool = { id, name: chunk.name || 'tool', status: 'running', startedAt: Date.now() };
                active.tools.set(id, tool);
                active.toolOrder.push(id);
            }
            else if (chunk.name) tool.name = chunk.name;
            void this.flushProcess(active);
            return;
        }
        if (chunk.type !== 'text-delta') return;
        if (active.suppressLiveDeltas) return;
        if (active.liveAttemptId && active.liveAttemptId !== String(frame.attemptId)) return;
        if (!active.liveAttemptId) active.liveAttemptId = String(frame.attemptId);
        if (active.liveAttemptBase === undefined) active.liveAttemptBase = (active.textBuffer || '').length;
        active.liveAttemptSawText = true;
        this.appendText(active, chunk.text);
    }
    onSessionEvent(session, event) {
        switch (event.type) {
            case 'turn/start':
                try {
                    if (event.data && event.data.turn !== undefined)
                        this.currentTurns.set(String(session.id), event.data.turn);
                } catch { }
                break;
            case 'step/start': {
                const active = this.ensureActive(session, event.data.turn);
                if (!active) break;
                // Only close if the previous step left anything open.
                if (active.textHandle || active.textBuffer || active.processHandle || active.toolOrder.length || active.reasoning)
                    void this.closeOpenSegments(active);
                active.step = event.data.step;
                break;
            }
            case 'step/end': {
                const active = this.active.get(String(session.id));
                if (!active) break;
                void this.closeOpenSegments(active);
                break;
            }
            case 'assistant/message': {
                const streamedText = joinAssistantStreamText(event.data.stream);
                const finalText = assistantText(event.data.message) || streamedText;
                // Capture reasoning blocks from the settled message if we missed live deltas.
                if (this.replyOpts().sendReasoning && event.data.message?.content) {
                    const active = this.ensureActive(session, event.data.turn);
                    if (active && !active.reasoning) {
                        let reasoning = '';
                        for (const block of event.data.message.content) {
                            if (block.type === 'reasoning' && block.text) reasoning += block.text;
                        }
                        if (reasoning) {
                            active.reasoning = reasoning;
                            void this.flushProcess(active);
                        }
                    }
                }
                if (streamedText || finalText) {
                    const active = this.ensureActive(session, event.data.turn);
                    if (active) {
                        const remaining = remainingAssistantText(active.textBuffer || '', streamedText, finalText, active.liveAttemptSawText && active.liveAttemptBase !== undefined
                            ? { attemptBase: active.liveAttemptBase }
                            : undefined);
                        if (remaining) this.appendText(active, remaining);
                        active.finalText = finalText;
                        active.suppressLiveDeltas = true;
                        active.liveAttemptSawText = false;
                        active.liveAttemptBase = undefined;
                    }
                }
                break;
            }
            case 'tool/call': {
                const active = this.ensureActive(session, event.data.turn);
                if (!active || !this.replyOpts().showToolCalls) break;
                const id = event.data.callId;
                const name = event.data.name || active.tools.get(id)?.name || 'tool';
                let tool = active.tools.get(id);
                if (!tool) {
                    tool = { id, name, status: 'running', startedAt: Date.now() };
                    active.tools.set(id, tool);
                    active.toolOrder.push(id);
                }
                else {
                    tool.name = name;
                    tool.status = 'running';
                    if (!tool.startedAt) tool.startedAt = Date.now();
                }
                void this.flushProcess(active);
                break;
            }
            case 'tool/result': {
                try { this.collectToolResultImages(session, event); } catch (error) {
                    this.options.logger.warn('[channel-harness] [dsh-telegram-temp patch] image collect failed', error);
                }
                const active = this.active.get(String(session.id));
                if (!active || !this.replyOpts().showToolCalls) break;
                const callId = event.data?.message?.source?.callId || event.data?.callId;
                if (!callId) break;
                let tool = active.tools.get(callId);
                if (!tool) {
                    tool = { id: callId, name: 'tool', status: 'done', startedAt: Date.now(), endedAt: Date.now() };
                    active.tools.set(callId, tool);
                    active.toolOrder.push(callId);
                }
                else {
                    tool.status = event.data?.message?.isError ? 'error' : 'done';
                    tool.endedAt = Date.now();
                }
                void this.flushProcess(active);
                break;
            }
            case 'turn/end':
                void this.finishTurn(session, event.data.turn, event.data.reason);
                break;
        }
    }
    activeSessions() {
        return [...this.active.keys()];
    }
    async flushAll() {
        for (const sessionId of [...this.active.keys()]) {
            const active = this.active.get(sessionId);
            if (active) await this.finalize(active, active.turn);
        }
    }
    async reconcileSession(session) {
        const sessionId = String(session.id);
        const unfinished = lastUnfinishedTurn(session.events);
        if (!unfinished) return;
        const { turn } = unfinished;
        const rebuilt = rebuildAssistantText(session.events, turn);
        const context = this.options.replyContexts.getTurn(sessionId, turn);
        if (!context) {
            this.options.replyContexts.releaseTurn(sessionId, turn);
            const mirrorBinding = rebuilt ? this.options.getBinding(sessionId) : undefined;
            if (!mirrorBinding || mirrorBinding.mirror !== true || !rebuilt) return;
            const binding = mirrorBinding;
            const adapter = this.options.getAdapter(binding.channelId);
            if (!adapter || !adapter.capabilities.text) return;
            const mirrorContext = {
                conversationType: binding.conversationType,
                ...(binding.senderId === undefined ? {} : { senderId: binding.senderId }),
            };
            await this.deliver(adapter, targetFor(binding, mirrorContext), rebuilt);
            return;
        }
        const active = this.active.get(sessionId);
        if (active && !active.finished) {
            active.textBuffer = rebuilt;
            if (rebuilt) active.finalText = rebuilt;
            await this.finalize(active, turn);
            return;
        }
        if (!rebuilt) {
            this.options.replyContexts.releaseTurn(sessionId, turn);
            return;
        }
        const binding = this.options.getBinding(sessionId);
        if (!binding) {
            this.options.logger.warn(`[channel-harness] reconcile: no session binding for '${sessionId}'`);
            this.options.replyContexts.releaseTurn(sessionId, turn);
            return;
        }
        const adapter = this.options.getAdapter(binding.channelId);
        if (!adapter) {
            this.options.logger.warn(`[channel-harness] reconcile: no adapter for channel '${binding.channelId}'`);
            this.options.replyContexts.releaseTurn(sessionId, turn);
            return;
        }
        if (active?.textHandle) {
            await active.textHandle.finish(rebuilt ? { text: rebuilt } : undefined).catch(() => { });
        }
        else {
            await this.deliver(adapter, targetFor(binding, context), rebuilt);
        }
        this.options.replyContexts.releaseTurn(sessionId, turn);
    }
    dispose() {
        for (const active of this.active.values()) {
            if (active.textTimer) clearTimeout(active.textTimer);
            if (active.processTimer) clearTimeout(active.processTimer);
            active.finished = true;
        }
        this.active.clear();
        this.streamTurns.clear();
        this.pendingImages.clear();
        this.currentTurns.clear();
    }
    /** [dsh-telegram-temp patch] Collect `{type:'image', attachment}` blocks of a channel-originated turn. */
    collectToolResultImages(session, event) {
        const sessionId = String(session.id);
        const data = event && event.data ? event.data : {};
        const message = data.message;
        if (!message || message.isError === true || !Array.isArray(message.content))
            return;
        const active = this.active.get(sessionId);
        let turn = data.turn;
        if (turn === undefined)
            turn = this.currentTurns.has(sessionId) ? this.currentTurns.get(sessionId) : active?.turn;
        if (turn === undefined)
            return;
        // Same outbound gate as text: only turns with a live channel ReplyContext.
        if (!this.options.replyContexts.getTurn(sessionId, turn))
            return;
        const key = `${sessionId}:${String(turn)}`;
        for (const block of message.content) {
            const ref = block && block.type === 'image' ? block.attachment : undefined;
            if (!ref || typeof ref.attachmentId !== 'string' || typeof ref.mediaType !== 'string')
                continue;
            let list = this.pendingImages.get(key);
            if (!list) {
                list = [];
                this.pendingImages.set(key, list);
            }
            if (list.length >= 10 || list.some((r) => r.attachmentId === ref.attachmentId))
                continue;
            list.push(ref);
        }
    }
    /** [dsh-telegram-temp patch] Send collected images via adapter media parts; warn on failure, never throw. */
    async deliverTurnImages(sessionId, turn, terminalTarget) {
        const key = `${sessionId}:${String(turn)}`;
        const refs = this.pendingImages.get(key);
        this.pendingImages.delete(key);
        if (this.currentTurns.get(sessionId) === turn)
            this.currentTurns.delete(sessionId);
        if (!refs || refs.length === 0)
            return;
        if (!terminalTarget) {
            this.options.logger.warn(`[channel-harness] [dsh-telegram-temp patch] ${refs.length} image(s) dropped: no channel target for session '${sessionId}'`);
            return;
        }
        const { adapter, target } = terminalTarget;
        if (adapter.capabilities && adapter.capabilities.image === false) {
            this.options.logger.warn(`[channel-harness] [dsh-telegram-temp patch] adapter '${terminalTarget.binding.channelId}' has no image capability`);
            return;
        }
        let attachments;
        try {
            attachments = this.attachCtx ? this.attachCtx.get('attachments') : undefined;
        }
        catch {
            attachments = undefined;
        }
        if (!attachments || typeof attachments.readImage !== 'function') {
            this.options.logger.warn('[channel-harness] [dsh-telegram-temp patch] attachments service unavailable; images not forwarded');
            return;
        }
        for (const ref of refs) {
            try {
                const read = await attachments.readImage(ref);
                const bytes = read && read.data ? read.data : undefined;
                if (!bytes || bytes.length === 0)
                    throw new Error('empty image data');
                const ext = String(ref.mediaType).split('/')[1] || 'png';
                const name = typeof ref.name === 'string' && ref.name ? ref.name : `image.${ext === 'jpeg' ? 'jpg' : ext}`;
                await adapter.send(target, {
                    parts: [{ type: 'image', localData: bytes, mimeType: ref.mediaType, name }],
                });
            }
            catch (error) {
                this.options.logger.warn(`[channel-harness] [dsh-telegram-temp patch] failed to forward image '${ref.attachmentId}' (${ref.mediaType})`, error);
            }
        }
    }

    ensureActive(session, turn) {
        const sessionId = String(session.id);
        const context = this.options.replyContexts.getTurn(sessionId, turn);
        if (!context) return this.ensureMirrorActive(session, turn);
        const existing = this.active.get(sessionId);
        if (existing) {
            if (existing.context !== context) {
                existing.context = context;
                existing.target = targetFor(existing.binding, context);
                existing.strategy = strategyFor(this.options.getAdapter(existing.binding.channelId), existing.target);
            }
            return existing;
        }
        const binding = this.options.getBinding(sessionId);
        if (!binding) {
            this.options.logger.warn(`[channel-harness] no session binding for '${sessionId}'`);
            return null;
        }
        const adapter = this.options.getAdapter(binding.channelId);
        if (!adapter) {
            this.options.logger.warn(`[channel-harness] no adapter for channel '${binding.channelId}'`);
            return null;
        }
        const target = targetFor(binding, context);
        const active = this.newActive(binding, adapter, target, context, turn, false);
        this.active.set(sessionId, active);
        return active;
    }
    ensureMirrorActive(session, turn) {
        const sessionId = String(session.id);
        const existing = this.active.get(sessionId);
        if (existing) return existing;
        const binding = this.options.getBinding(sessionId);
        if (!binding || binding.mirror !== true) return null;
        const adapter = this.options.getAdapter(binding.channelId);
        if (!adapter || !adapter.capabilities.text) return null;
        const context = {
            conversationType: binding.conversationType,
            ...(binding.senderId === undefined ? {} : { senderId: binding.senderId }),
        };
        const active = this.newActive(binding, adapter, targetFor(binding, context), context, turn, true);
        active.strategy = 'buffered';
        active.mirror = true;
        this.active.set(sessionId, active);
        return active;
    }
    newActive(binding, adapter, target, context, turn, mirror) {
        return {
            binding,
            strategy: mirror ? 'buffered' : strategyFor(adapter, target),
            target,
            context,
            mirror: !!mirror,
            processHandle: null,
            textHandle: null,
            textBuffer: '',
            finalText: '',
            textTimer: null,
            processTimer: null,
            lastTextFlush: 0,
            lastProcessFlush: 0,
            lastSentLength: 0,
            lastProcessHtml: '',
            turn,
            step: null,
            finished: false,
            textFlushing: null,
            processFlushing: null,
            suppressLiveDeltas: false,
            liveAttemptSawText: false,
            reasoning: '',
            tools: new Map(),
            toolOrder: [],
            processFinalized: false,
        };
    }
    toolList(active) {
        return active.toolOrder.map((id) => active.tools.get(id)).filter(Boolean);
    }
    async ensureProcessHandle(active) {
        if (active.processHandle || active.strategy === 'buffered') return;
        const adapter = this.options.getAdapter(active.binding.channelId);
        if (!adapter?.createReply) return;
        active.processHandle = await adapter.createReply(active.target, { kind: 'process', markdown: true });
    }
    async ensureTextHandle(active) {
        if (active.textHandle || active.strategy === 'buffered') return;
        const adapter = this.options.getAdapter(active.binding.channelId);
        if (!adapter?.createReply) return;
        // Order is process → text. [dsh-workbench patch] If the process bubble is already posted,
        // finish it in the background so the first text bubble is not delayed by its throttle.
        if (active.processFlushing) await active.processFlushing.catch(() => { });
        if (active.processHandle && active.processHandle.messageId) {
            const closing = this.finalizeProcess(active);
            active.processClosing = Promise.all([active.processClosing, closing]).then(() => undefined, () => undefined);
        }
        else {
            await this.finalizeProcess(active);
        }
        active.textHandle = await adapter.createReply(active.target, { kind: 'text', markdown: true });
    }
    appendText(active, delta) {
        if (!delta) return;
        // Starting text implies we should seal the process card if shown.
        active.textBuffer = (active.textBuffer || '') + delta;
        // buffer alias for remainingAssistantText / finalize compatibility
        active.buffer = active.textBuffer;
        const interval = this.replyOpts().updateIntervalMs;
        if (interval <= 0) { void this.flushText(active); return; }
        const now = Date.now();
        if (now - active.lastTextFlush >= interval) { void this.flushText(active); return; }
        if (!active.textTimer) {
            active.textTimer = setTimeout(() => {
                active.textTimer = null;
                void this.flushText(active);
            }, interval - (now - active.lastTextFlush));
        }
    }
    flushProcess(active) {
        if (active.finished || active.processFinalized) return;
        const opts = this.replyOpts();
        const tools = this.toolList(active);
        if (!shouldShowProcess({ sendReasoning: opts.sendReasoning, showToolCalls: opts.showToolCalls, reasoning: active.reasoning, tools }))
            return;
        if (!active.processFlushing) {
            active.processFlushing = this.doFlushProcess(active).finally(() => { active.processFlushing = null; });
        }
    }
    async doFlushProcess(active) {
        if (active.finished || active.processFinalized || active.strategy === 'buffered') return;
        const opts = this.replyOpts();
        const tools = this.toolList(active);
        const html = buildProcessHtml({
            reasoning: active.reasoning,
            tools,
            sendReasoning: opts.sendReasoning,
            reasoningMaxChars: opts.reasoningMaxChars,
        });
        if (!html || html === active.lastProcessHtml) return;
        try {
            await this.ensureProcessHandle(active);
            if (!active.processHandle) return;
            if (active.strategy === 'edit' || active.strategy === 'native') {
                await active.processHandle.replace({ text: html });
            }
            active.lastProcessHtml = html;
            active.lastProcessFlush = Date.now();
        }
        catch (error) {
            await active.processHandle?.fail(error).catch(() => { });
            this.options.logger.error(`[channel-harness] process flush failed for session '${active.binding.sessionId}'`, error);
        }
    }
    async finalizeProcess(active) {
        if (active.processFinalized) return;
        active.processFinalized = true;
        if (active.processTimer) { clearTimeout(active.processTimer); active.processTimer = null; }
        if (active.processFlushing) await active.processFlushing.catch(() => { });
        const opts = this.replyOpts();
        const tools = this.toolList(active);
        const html = buildProcessHtml({
            reasoning: active.reasoning,
            tools,
            sendReasoning: opts.sendReasoning,
            reasoningMaxChars: opts.reasoningMaxChars,
        });
        // [dsh-workbench patch] detach the handle synchronously so a background finish can never
        // clobber a handle opened by the next step.
        let handle = active.processHandle;
        active.processHandle = null;
        active.lastProcessHtml = html;
        if (!html) {
            if (handle) await handle.finish({ text: '' }).catch(() => { });
            return;
        }
        try {
            if (!handle && active.strategy !== 'buffered') {
                const adapter = this.options.getAdapter(active.binding.channelId);
                if (adapter?.createReply) handle = await adapter.createReply(active.target, { kind: 'process', markdown: true });
            }
            if (handle) {
                await handle.finish({ text: html });
            }
            else {
                const adapter = this.options.getAdapter(active.binding.channelId);
                if (adapter) await this.deliver(adapter, active.target, html);
            }
        }
        catch (error) {
            await handle?.fail(error).catch(() => { });
            this.options.logger.error(`[channel-harness] process finish failed for session '${active.binding.sessionId}'`, error);
        }
    }
    flushText(active) {
        if (active.finished) return;
        if (!active.textFlushing) {
            active.textFlushing = this.drainText(active).finally(() => { active.textFlushing = null; });
        }
    }
    async drainText(active) {
        while (!active.finished) {
            if (active.strategy === 'buffered') return;
            const before = active.lastSentLength;
            await this.doFlushText(active);
            if (active.lastSentLength === before) return;
        }
    }
    async doFlushText(active) {
        if (active.finished) return;
        active.lastTextFlush = Date.now();
        if ((active.textBuffer || '').length === active.lastSentLength) return;
        try {
            await this.ensureTextHandle(active);
            if (!active.textHandle) return;
            if (active.strategy === 'edit') {
                await active.textHandle.replace({ text: active.textBuffer });
                active.lastSentLength = active.textBuffer.length;
            }
            else {
                const delta = active.textBuffer.slice(active.lastSentLength);
                active.lastSentLength = active.textBuffer.length;
                await active.textHandle.append(delta);
            }
        }
        catch (error) {
            await active.textHandle?.fail(error).catch(() => { });
            this.options.logger.error(`[channel-harness] reply flush failed for session '${active.binding.sessionId}'`, error);
        }
    }
    /**
     * [dsh-workbench patch] Close the current step's segments exactly once.
     * State is snapshotted and reset synchronously, so a concurrent `turn/end`
     * finalize never sees the same text again (no duplicate delivery); the
     * async delivery is chained on `active.closing`, which finalize awaits.
     */
    closeOpenSegments(active) {
        if (active.textTimer) { clearTimeout(active.textTimer); active.textTimer = null; }
        const snap = {
            textHandle: active.textHandle,
            text: active.textBuffer || active.finalText || '',
            textFlushing: active.textFlushing,
            processHandle: active.processHandle,
            processFlushing: active.processFlushing,
            processFinalized: active.processFinalized,
            reasoning: active.reasoning,
            tools: this.toolList(active),
        };
        const hadText = !!(snap.textHandle || snap.text);
        // Reset synchronously for the next step / finalize.
        active.textHandle = null;
        active.processHandle = null;
        active.textBuffer = '';
        active.buffer = '';
        active.finalText = '';
        active.lastSentLength = 0;
        active.processFinalized = false;
        active.lastProcessHtml = '';
        active.reasoning = '';
        active.tools = new Map();
        active.toolOrder = [];
        active.suppressLiveDeltas = false;
        active.liveAttemptBase = undefined;
        active.liveAttemptSawText = false;
        const previous = active.closing || Promise.resolve();
        active.closing = previous.then(() => this.deliverClosedStep(active, snap, hadText)).catch((error) => {
            this.options.logger.error(`[channel-harness] segment close failed for session '${active.binding.sessionId}'`, error);
        });
        return active.closing;
    }
    async deliverClosedStep(active, snap, hadText) {
        if (snap.textFlushing) await snap.textFlushing.catch(() => { });
        if (active.processClosing) await active.processClosing.catch(() => { });
        if (snap.processFlushing) await snap.processFlushing.catch(() => { });
        // Process segment first (order: process → text). If text already opened,
        // the process card was finalized then (ensureTextHandle).
        if (!snap.processFinalized) {
            const opts = this.replyOpts();
            const html = buildProcessHtml({ reasoning: snap.reasoning, tools: snap.tools, sendReasoning: opts.sendReasoning, reasoningMaxChars: opts.reasoningMaxChars });
            try {
                if (snap.processHandle) await snap.processHandle.finish(html ? { text: html } : { text: '' });
                else if (html && active.strategy !== 'buffered') {
                    const adapter = this.options.getAdapter(active.binding.channelId);
                    if (adapter?.createReply) {
                        const h = await adapter.createReply(active.target, { kind: 'process', markdown: true });
                        await h.finish({ text: html });
                    }
                }
            }
            catch (error) {
                await snap.processHandle?.fail(error).catch(() => { });
            }
        }
        if (!hadText) return;
        try {
            if (snap.textHandle) await snap.textHandle.finish(snap.text ? { text: snap.text } : undefined);
            else if (snap.text && active.strategy !== 'buffered') {
                const adapter = this.options.getAdapter(active.binding.channelId);
                if (adapter?.createReply) {
                    const h = await adapter.createReply(active.target, { kind: 'text', markdown: true });
                    await h.finish({ text: snap.text });
                }
            }
            else if (snap.text && active.strategy === 'buffered') {
                // Buffered strategy: keep for finalize (send-once at turn end).
                active.bufferedSteps = (active.bufferedSteps || []).concat(snap.text);
            }
        }
        catch (error) {
            await snap.textHandle?.fail(error).catch(() => { });
            this.options.logger.error(`[channel-harness] reply finish failed for session '${active.binding.sessionId}'`, error);
        }
    }
    resolveTurnTarget(sessionId, context) {
        if (!context) return undefined;
        const binding = this.options.getBinding(sessionId);
        if (!binding) {
            this.options.logger.warn(`[channel-harness] no session binding for '${sessionId}'`);
            return undefined;
        }
        const adapter = this.options.getAdapter(binding.channelId);
        if (!adapter) {
            this.options.logger.warn(`[channel-harness] no adapter for channel '${binding.channelId}'`);
            return undefined;
        }
        return { binding, adapter, target: targetFor(binding, context) };
    }
    async finishTurn(session, turn, reason) {
        const sessionId = String(session.id);
        const active = this.active.get(sessionId);
        const context = this.options.replyContexts.getTurn(sessionId, turn);
        const terminalTarget = active
            ? (() => {
                const adapter = this.options.getAdapter(active.binding.channelId);
                return adapter ? { binding: active.binding, adapter, target: active.target } : undefined;
            })()
            : this.resolveTurnTarget(sessionId, context);
        try {
            if (active) await this.finalize(active, turn);
            try { await this.deliverTurnImages(sessionId, turn, terminalTarget); }
            catch (error) {
                this.options.logger.warn(`[channel-harness] [dsh-telegram-temp patch] image delivery failed for session '${sessionId}'`, error);
            }
            if (reason.kind === 'error' && terminalTarget) {
                this.options.logger.error(`[channel-harness] Harness turn failed for session '${sessionId}'`, {
                    turn, code: reason.error.code, status: reason.error.status,
                    requestId: reason.error.requestId, providerRetryAfterMs: reason.error.providerRetryAfterMs,
                });
                try { await this.deliver(terminalTarget.adapter, terminalTarget.target, formatChannelTurnFailure(reason.error)); }
                catch (error) {
                    this.options.logger.error(`[channel-harness] failed to deliver turn error for session '${sessionId}'`, error);
                }
            }
        }
        finally {
            if (!active) {
                this.options.replyContexts.releaseTurn(sessionId, turn);
                if (terminalTarget) this.stopTypingIfSupported(terminalTarget.binding.channelId, terminalTarget.target);
            }
        }
    }
    async finalize(active, turn) {
        if (active.textTimer) { clearTimeout(active.textTimer); active.textTimer = null; }
        if (active.processTimer) { clearTimeout(active.processTimer); active.processTimer = null; }
        this.active.delete(active.binding.sessionId);
        if (active.finished) return;
        if (active.textFlushing) await active.textFlushing.catch(() => { });
        if (active.processFlushing) await active.processFlushing.catch(() => { });
        // [dsh-workbench patch] earlier steps are delivered by closeOpenSegments; wait for them first.
        if (active.closing) await active.closing.catch(() => { });
        if (active.processClosing) await active.processClosing.catch(() => { });
        active.finished = true;
        let text = (active.textBuffer && active.textBuffer.length > 0) ? active.textBuffer : active.finalText;
        if (active.bufferedSteps && active.bufferedSteps.length)
            text = [...active.bufferedSteps, text].filter(Boolean).join('\n\n');
        const adapter = this.options.getAdapter(active.binding.channelId);
        if (!adapter) {
            this.options.logger.warn(`[channel-harness] no adapter for channel '${active.binding.channelId}'`);
            this.options.replyContexts.releaseTurn(active.binding.sessionId, turn);
            return;
        }
        try {
            await this.finalizeProcess(active);
            if (active.textHandle) {
                await active.textHandle.finish(text ? { text } : undefined);
            }
            else if (active.strategy !== 'buffered' && adapter.createReply && text) {
                const handle = await adapter.createReply(active.target, { kind: 'text', markdown: true });
                await handle.finish({ text });
            }
            else if (text) {
                await this.deliver(adapter, active.target, text);
            }
        }
        catch (error) {
            try { await active.textHandle?.fail(error); } catch { }
            this.options.logger.error(`[channel-harness] reply finish failed for session '${active.binding.sessionId}'`, error);
        }
        this.options.replyContexts.releaseTurn(active.binding.sessionId, turn);
        this.stopTypingIfSupported(active.binding.channelId, active.target);
    }
    stopTypingIfSupported(channelId, target) {
        const adapter = this.options.getAdapter(channelId);
        if (adapter?.stopTypingForTarget) void adapter.stopTypingForTarget(target).catch(() => { });
        else if (adapter?.stopTyping) void adapter.stopTyping(target.conversationId).catch(() => { });
    }
    async deliver(adapter, target, text) {
        if (!text) return;
        const max = this.options.config.maxTextLength;
        if (!max || text.length <= max) {
            await adapter.send(target, { text });
            return;
        }
        const pieces = splitMessage(text, max, this.options.config);
        for (const piece of pieces) await adapter.send(target, { text: piece });
    }
}

function strategyFor(adapter, target) {
    const mode = adapter.resolveStreamingMode?.(target) ?? adapter.capabilities.streaming;
    if (adapter.createReply) {
        if (mode === 'native')
            return 'native';
        if (mode === 'edit')
            return 'edit';
    }
    return 'buffered';
}
function assistantText(message) {
    let text = '';
    for (const block of message.content) {
        if (block.type === 'text')
            text += block.text;
    }
    return text;
}
function targetFor(binding, context) {
    const target = {
        channelId: binding.channelId,
        accountId: binding.accountId,
        conversationId: binding.conversationId,
    };
    if (binding.threadId) {
        target.threadId = binding.threadId;
    }
    if (context) {
        target.conversationType = context.conversationType;
        if (context.replyToMessageId) {
            target.replyToMessageId = context.replyToMessageId;
        }
        if (context.raw !== undefined) {
            target.raw = context.raw;
        }
        if (context.runId) {
            target.runId = context.runId;
        }
    }
    return target;
}
/**
 * Find the last turn that started but never ended. Returns its turn number, or
 * `undefined` when every opened turn was closed.
 */
function lastUnfinishedTurn(events) {
    let lastOpen;
    for (const event of events) {
        if (event.type === 'turn/start') {
            lastOpen = event.data.turn;
        }
        else if (event.type === 'turn/end' && event.data.turn === lastOpen) {
            lastOpen = undefined;
        }
    }
    return lastOpen === undefined ? undefined : { turn: lastOpen };
}
/**
 * Rebuild the assistant text for one turn from its V3 compact assistant
 * streams, falling back to `assistant/message` text when no delta flowed.
 */
function rebuildAssistantText(events, turn) {
    let text = '';
    for (const event of events) {
        if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && event.data.turn === turn) {
            text += joinAssistantStreamText(event.data.stream);
        }
    }
    if (text.length > 0)
        return text;
    for (const event of events) {
        if (event.type === 'assistant/message' && event.data.turn === turn) {
            const fallback = assistantText(event.data.message);
            if (fallback)
                return fallback;
        }
    }
    return '';
}
/**
 * Merge one attempt's official settlement into the live text already buffered
 * for that same attempt.
 *
 * `suffix` is only the current attempt, never the whole turn. A later
 * tool-loop chunk is therefore not treated as new just because it is not a
 * prefix of everything sent so far, and a new chunk is not dropped just
 * because the same words appeared in an earlier attempt.
 */
export function mergeAssistantText(suffix, incoming) {
    if (!incoming)
        return suffix;
    if (!suffix)
        return incoming;
    if (incoming === suffix || suffix.startsWith(incoming))
        return suffix;
    if (incoming.startsWith(suffix))
        return incoming;
    if (suffix.includes(incoming))
        return suffix;
    return suffix + incoming;
}
/**
 * Text still missing from the preview buffer after one `assistant/message`.
 *
 * Without `attemptBase`, settlements are official-only deltas: a cumulative
 * snapshot contributes its suffix, and any other chunk is appended. With
 * `attemptBase`, the settlement is merged only into the live suffix of the
 * current attempt.
 *
 * Empty durable streams never append `finalText` onto a non-empty buffer —
 * `finalize()` already falls back to `finalText` when nothing streamed.
 */
export function remainingAssistantText(existing, streamedText, _finalText, options) {
    if (!streamedText)
        return '';
    if (options?.attemptBase === undefined) {
        return streamedText.startsWith(existing) ? streamedText.slice(existing.length) : streamedText;
    }
    const base = Math.max(0, Math.min(options.attemptBase, existing.length));
    const suffix = existing.slice(base);
    return mergeAssistantText(suffix, streamedText).slice(suffix.length);
}
/**
 * Split a long message into `maxLength`-bounded pieces, keeping fenced code
 * blocks whole and preferring paragraph boundaries. `finalFlush: false`
 * drops a trailing partial piece instead of delivering it.
 */
export function splitMessage(text, maxLength, config) {
    if (text.length <= maxLength)
        return [text];
    const segments = config.splitCodeBlocks ? splitCodeSegments(text) : [text];
    const pieces = [];
    for (const segment of segments) {
        if (segment.length === 0)
            continue;
        if (segment.length <= maxLength) {
            pieces.push(segment);
            continue;
        }
        if (config.splitParagraphs) {
            pieces.push(...packSegments(segment, maxLength));
        }
        else {
            pieces.push(...hardWrap(segment, maxLength));
        }
    }
    if (!config.finalFlush && pieces.length > 1) {
        const last = pieces[pieces.length - 1];
        if (last && last.length < maxLength)
            pieces.pop();
    }
    return pieces;
}
function splitCodeSegments(text) {
    const segments = [];
    const fence = /```[\s\S]*?```/g;
    let cursor = 0;
    let match;
    while ((match = fence.exec(text))) {
        const before = text.slice(cursor, match.index);
        if (before)
            segments.push(before);
        segments.push(match[0]);
        cursor = match.index + match[0].length;
    }
    const rest = text.slice(cursor);
    if (rest)
        segments.push(rest);
    return segments.length > 0 ? segments : [text];
}
function packSegments(segment, maxLength) {
    const paragraphs = segment.split(/\n\s*\n/);
    const pieces = [];
    let current = '';
    for (const paragraph of paragraphs) {
        if (paragraph.length <= maxLength) {
            const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
            if (candidate.length <= maxLength) {
                current = candidate;
            }
            else {
                if (current)
                    pieces.push(current);
                current = paragraph;
            }
        }
        else {
            if (current)
                pieces.push(current);
            current = '';
            pieces.push(...hardWrap(paragraph, maxLength));
        }
    }
    if (current)
        pieces.push(current);
    return pieces;
}
function hardWrap(text, maxLength) {
    const pieces = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (line.length > maxLength) {
            if (current)
                pieces.push(current);
            current = '';
            for (let i = 0; i < line.length; i += maxLength) {
                pieces.push(line.slice(i, i + maxLength));
            }
        }
        else {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length <= maxLength) {
                current = candidate;
            }
            else {
                pieces.push(current);
                current = line;
            }
        }
    }
    if (current)
        pieces.push(current);
    return pieces;
}
//# sourceMappingURL=reply-router.js.map