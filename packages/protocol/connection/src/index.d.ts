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
import { AbstractApiClient, type ClientRequest, type ServerRequest, type ServerResponse } from '@snap-rail/protocol';
/**
 * The two-primitive carrier surface the preload exposes on `window.snapRail`.
 * This interface is the sole contract between this package and Electron;
 * tests inject plain functions.
 */
export interface HostChannel {
    /** Deliver one full-form client request; resolves with its full-form response.
     * @param request - the envelope to send.
     */
    invoke(request: ClientRequest): Promise<ServerResponse>;
    /** Subscribe to host frames on a fresh stream; returns the unsubscribe function.
     * @param listener - called with each parsed host frame.
     */
    openStream(listener: (frame: ServerRequest) => void): () => void;
}
/** Filtered push-frame subscription client over a {@link HostChannel}. */
export declare class HostLink extends AbstractApiClient {
    protected readonly transport: (request: ClientRequest) => Promise<ServerResponse>;
    private readonly channel;
    constructor(channel: HostChannel);
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
    subscribe(method: string, listener: (payload: unknown) => void): () => void;
    /** Ask the host to identify itself; the readiness handshake for surfaces. */
    describeHost(): Promise<{
        name: string;
        version: string;
        bin: string;
    }>;
}
//# sourceMappingURL=index.d.ts.map