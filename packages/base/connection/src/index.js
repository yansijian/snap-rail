/**
 * The client half of the rpc carrier. A {@link HostLink} rides whatever
 * transport exposes the two preload primitives — the Electron invoke channel
 * and one frame stream per subscription — and adds the protocol invariants
 * from `AbstractApiClient`: rpcId minting, echo checks, typed results.
 *
 * Frames cross a wire boundary, so every inbound frame is envelope-parsed
 * before dispatch; a malformed envelope fails loud in-process (the Electron
 * preload isolates a throwing listener so one bad frame never starves the
 * subscribers after it — pair with `subscribeFrame` for payload schemas).
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
/**
 * Human text for a business error (`what` and joined `issues` read better
 * than the code); the standard failure copy for surfaces. An `internal`
 * always names its corner — the hint carries the failing step, so even an
 * unmapped failure never leaves the operator with a bare code.
 * @param error - the `error` leg of an `ok: false` result.
 */
export function rpcErrorText(error) {
    const details = (error.details ?? {});
    if (error.code === 'bad-request' && Array.isArray(details.issues)) {
        const issues = details.issues.filter((issue) => typeof issue === 'string');
        if (issues.length > 0)
            return issues.join('；');
    }
    if (typeof details.what === 'string')
        return details.what;
    if (error.code === 'internal') {
        const hint = details.hint;
        return typeof hint === 'string' && hint !== '' ? `内部错误（${hint}）` : '内部错误';
    }
    return error.code;
}
/**
 * Subscribe with the owning domain's payload schema: the frame payload is
 * parsed once here, so the listener receives a validated, typed payload
 * instead of a hand-written shape check. The standard way to consume any
 * push frame — the schema lives in the frame's owning contract module.
 *
 * A payload that fails its schema is dropped (logged) rather than fed to
 * the listener half-parsed; the carrier isolates throwing listeners, so
 * this keeps a bad frame from starving the subscribers after it.
 *
 * @param link - the client link carrying the subscription.
 * @param method - the wire frame name to filter on.
 * @param schema - the frame's payload schema (from the owning contract).
 * @param listener - receives each parsed payload.
 * @returns the unsubscribe function.
 */
export function subscribeFrame(link, method, schema, listener) {
    return link.subscribe(method, payload => {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
            console.error(`subscribeFrame: dropping malformed ${method} frame`, parsed.error.message);
            return;
        }
        listener(parsed.data);
    });
}
//# sourceMappingURL=index.js.map