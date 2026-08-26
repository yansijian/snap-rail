/**
 * The client half of the rpc carrier. A {@link HostLink} rides whatever
 * transport exposes the two preload primitives — the Electron invoke channel
 * and one frame stream per subscription — and adds the protocol invariants
 * from `AbstractApiClient`: rpcId minting, echo checks, typed results.
 *
 * Frames cross a wire boundary, so every inbound frame is schema-parsed
 * before dispatch; a malformed frame fails loud instead of feeding garbage
 * to subscribers.
 *
 * @module @snap-rail/connection
 */
import { AbstractApiClient, parseServerRequest, } from '@snap-rail/protocol';
/** Filtered push-frame subscription client over a {@link HostChannel}. */
export class HostLink extends AbstractApiClient {
    transport;
    channel;
    constructor(channel) {
        super();
        this.channel = channel;
        this.transport = request => channel.invoke(request);
    }
    /**
     * Subscribe to broadcast frames whose method matches exactly.
     *
     * Each subscription opens its own stream on the channel; a frame that
     * fails envelope parsing throws at dispatch time rather than delivering.
     *
     * @param method - the wire method name to filter on.
     * @param listener - receives each matching frame's business payload.
     * @returns the unsubscribe function.
     */
    subscribe(method, listener) {
        return this.channel.openStream(rawFrame => {
            const frame = parseServerRequest(rawFrame);
            if (frame.method === method)
                listener(frame.payload);
        });
    }
    /** Ask the host to identify itself; the readiness handshake for surfaces. */
    async describeHost() {
        const result = await this.call('host.describe', {});
        if (!result.ok)
            throw new Error(`host describe failed: ${result.error.code}`);
        return result.value;
    }
}
//# sourceMappingURL=index.js.map