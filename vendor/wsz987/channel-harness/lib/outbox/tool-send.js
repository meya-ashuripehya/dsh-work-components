/**
 * send_channel_message — the M6 Harness tool.
 *
 * Lets the model send a proactive message back to the channel conversation the
 * CURRENT session is durably bound to. Parameters are ONLY `{ text?,
 * attachment_id? }` — there is NO `recipient` / `channel` / `account` /
 * `conversation` / `user_id` / `openid` / `file_path` (those
 * fields must NOT exist in the parameter schema nor in the request type). The
 * durable binding resolves the target.
 *
 * Agent-scoped registration: installSendChannelMessageTool registers
 * through the official @deepseek-ai/dsh-tools ctx.tools.register on the agent's
 * own scope, mirroring installReadChannelAttachmentTool.
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
/**
 * The tool definition, ready to register on an Agent scope. Parameters are
 * type-level guaranteed to be only `{ text?, attachment_id? }`.
 */
export function registerSendChannelMessageTool(options) {
    const outbox = options.outbox;
    return defineTool({
        name: 'send_channel_message',
        description: 'Send a proactive message to the channel conversation bound to the current session. ' +
            'Supply text and/or an attachment_id; the destination is derived from the session binding.',
        parameters: {
            text: { type: 'string', description: 'Plain text to send.' },
            attachment_id: {
                type: 'string',
                description: 'A stored channel attachment id to send using its stored media kind.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    delivered: { type: 'boolean' },
                    messageId: { type: 'string' },
                },
            },
            render: (args, value) => {
                const delivered = Boolean(value.delivered);
                const messageId = typeof value.messageId === 'string' ? value.messageId : undefined;
                const text = delivered
                    ? 'Message sent to the channel' + (messageId ? ' (message id ' + messageId + ')' : '') + '.'
                    : 'Message could not be delivered.';
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            const sessionId = exec.agent ? String(exec.agent.id) : undefined;
            if (sessionId === undefined) {
                throw new ToolArgsError(['send_channel_message requires a session (no agent context)']);
            }
            if (!args.text && !args.attachment_id) {
                throw new ToolArgsError([
                    'send_channel_message requires at least one of: text, attachment_id',
                ]);
            }
            const result = await outbox.send(sessionId, { text: args.text, attachmentId: args.attachment_id }, { signal: exec.signal });
            const canonical = {
                delivered: result.delivered,
                ...(result.messageId ? { messageId: result.messageId } : {}),
            };
            return canonical;
        },
    });
}
/** Install the tool on an Agent scoped context (Agent-scoped registration). */
export async function installSendChannelMessageTool(agentCtx, options) {
    const fiber = agentCtx.inject(['tools'], function* sendToolScope(ctx) {
        yield ctx.tools.register(registerSendChannelMessageTool(options));
    });
    await fiber.await().then(() => undefined);
}
//# sourceMappingURL=tool-send.js.map