import { channelAdapterShapeSchema } from './schema.js';
/** Emit a message event through the adapter context helper. */
export function isChannelAdapter(value) {
    return channelAdapterShapeSchema.safeParse(value).success;
}
//# sourceMappingURL=adapter.js.map