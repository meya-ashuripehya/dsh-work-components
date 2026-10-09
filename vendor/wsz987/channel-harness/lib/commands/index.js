/**
 * Channel command plane.
 *
 * Composes the channel command factories and installs them into an Agent
 * scoped context via the official `@deepseek-ai/dsh-commands` registry —
 * there is no custom ChannelCommandRegistry / CommandMap here. Each factory
 * returns an official `CommandDefinition`; `installChannelCommands` mounts a
 * command-injected child plugin under the Agent's exact context. Channel
 * commands register in the AGENT scope, so they shadow same-named globals and
 * a same-scope duplicate throws (no custom priority/reserved-name system —
 * spec §11/§43).
 *
 * The `deps` argument is the bridge hook surface channel commands need —
 * every capability a handler uses arrives as a NARROW injected function or
 * object, mirroring `/new`'s `startNewSession`. Handlers must NEVER read
 * Harness services through `invocation.agent.ctx` (the agent-loop scoped
 * context does not inject `commands` / `llm` — Cordis throws "without
 * inject"); the bridge lazily bridges them through `deps` instead, exactly
 * like the official compact/goal/plan commands close over their plugin ctx.
 */
import {} from '@deepseek-ai/cordis';
import { createNewCommand } from './new.js';
import { createStopCommand } from './stop.js';
import { createHelpCommand } from './help.js';
import { createStatusCommand } from './status.js';
import { createModelsCommand } from './models.js';
import { createModelCommand } from './model.js';
import { createVersionCommand } from './version.js';
import { createMirrorCommand } from './mirror.js';
import { createBindCommand } from './bind.js';
const commandFactories = [
    createStopCommand,
    createNewCommand,
    createHelpCommand,
    createStatusCommand,
    createModelsCommand,
    createModelCommand,
    createVersionCommand,
    createMirrorCommand,
    createBindCommand,
];
/**
 * Install the channel commands on an Agent scoped context. Registrations live
 * for the life of that Agent scope and unwind together with it when the Agent
 * is disposed.
 */
export function installChannelCommands(agentCtx, deps) {
    const fiber = agentCtx.inject(['commands'], function* channelCommands(ctx) {
        for (const factory of commandFactories) {
            yield ctx.commands.register(factory(deps));
        }
    });
    return fiber.await().then(() => {
        let disposing;
        return () => disposing ??= quiesceFiber(fiber);
    });
}
async function quiesceFiber(fiber) {
    await Promise.resolve(fiber.dispose());
    while (fiber.inertia !== undefined)
        await fiber.inertia;
}
//# sourceMappingURL=index.js.map