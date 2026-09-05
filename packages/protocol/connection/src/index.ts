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

import {
  AbstractApiClient,
  parseServerRequest,
  type ClientRequest,
  type FrameName,
  type FramePayload,
  type ServerRequest,
  type ServerResponse,
} from '@snap-rail/protocol'
import { z } from 'zod'

/**
 * The two-primitive carrier surface the preload exposes on `window.snapRail`.
 * This interface is the sole contract between this package and Electron;
 * tests inject plain functions.
 */
export interface HostChannel {
  /** Deliver one full-form client request; resolves with its full-form response.
   * @param request - the envelope to send.
   */
  invoke(request: ClientRequest): Promise<ServerResponse>
  /** Subscribe to host frames on a fresh stream; returns the unsubscribe function.
   * @param listener - called with each parsed host frame.
   */
  openStream(listener: (frame: ServerRequest) => void): () => void
}

/** Filtered push-frame subscription client over a {@link HostChannel}. */
export class HostLink extends AbstractApiClient {
  protected readonly transport: (request: ClientRequest) => Promise<ServerResponse>

  private readonly channel: HostChannel

  constructor(channel: HostChannel) {
    super()
    this.channel = channel
    this.transport = request => channel.invoke(request)
  }

  /**
   * Subscribe to broadcast frames whose method matches exactly.
   *
   * Two overloads, one open-world rule: a frame known to `FrameMap`
   * (directly or via the caller's own declaration merge) delivers a typed
   * payload; any other frame name delivers `unknown` and the caller owns
   * the payload contract (parse it with the owning package's schema).
   *
   * Each subscription opens its own stream on the channel; a frame that
   * fails envelope parsing throws at dispatch time rather than delivering.
   *
   * @param method - the wire frame name to filter on.
   * @param listener - receives each matching frame's business payload.
   * @returns the unsubscribe function.
   */
  subscribe<K extends FrameName>(method: K, listener: (payload: FramePayload<K>) => void): () => void
  subscribe(method: string, listener: (payload: unknown) => void): () => void
  subscribe(method: string, listener: (payload: unknown) => void): () => void {
    return this.channel.openStream(rawFrame => {
      const frame = parseServerRequest(rawFrame)
      if (frame.method === method) listener(frame.payload)
    })
  }

  /** Ask the host to identify itself; the readiness handshake for surfaces. */
  async describeHost() {
    const result = await this.call('host.describe', {})
    if (!result.ok) throw new Error(`host describe failed: ${result.error.code}`)
    return result.value
  }
}

/**
 * Human text for a business error (`what` and joined `issues` read better
 * than the code); the standard failure copy for surfaces. An `internal`
 * always names its corner — the hint carries the failing step, so even an
 * unmapped failure never leaves the operator with a bare code.
 * @param error - the `error` leg of an `ok: false` result.
 */
export function rpcErrorText(error: { code: string, details?: unknown }): string {
  const details = (error.details ?? {}) as Record<string, unknown>
  if (error.code === 'bad-request' && Array.isArray(details.issues)) {
    const issues = details.issues.filter((issue): issue is string => typeof issue === 'string')
    if (issues.length > 0) return issues.join('；')
  }
  if (typeof details.what === 'string') return details.what
  if (error.code === 'internal') {
    const hint = details.hint
    return typeof hint === 'string' && hint !== '' ? `内部错误（${hint}）` : '内部错误'
  }
  return error.code
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
export function subscribeFrame<S extends z.ZodType>(
  link: HostLink,
  method: string,
  schema: S,
  listener: (payload: z.output<S>) => void,
): () => void {
  return link.subscribe(method, payload => {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      console.error(`subscribeFrame: dropping malformed ${method} frame`, parsed.error.message)
      return
    }
    listener(parsed.data)
  })
}

/**
 * Subscribe to a topic with the full client recipe in one call: open the
 * wire-side gate (`topic.subscribe`, carrying the filter the host evaluates),
 * follow the topic's frames with the owning contract's payload schema, and
 * close gate and stream together on dispose. The standard way to consume any
 * topic — the schema lives in the topic's owning contract module.
 *
 * The wire gate is process-wide: while any window's gate matches a
 * publication, every window following the topic sees it, so a consumer
 * watching a slice (one point, one device) narrows by payload in its
 * listener. A payload that fails its schema is dropped (logged), mirroring
 * `subscribeFrame`. The gate opens asynchronously — publications before it
 * settles are not delivered (seed current state with a read where freshness
 * matters). The returned disposer is synchronous, so it slots straight into
 * an effect body.
 *
 * @param link - the client link carrying the subscription.
 * @param topic - the wire topic name (`domain/event`).
 * @param filter - the subscription filter (the topic declaration's shape).
 * @param schema - the topic's payload schema (from the owning contract).
 * @param listener - receives each parsed payload the topic delivers.
 * @returns the unsubscribe function.
 */
export function subscribeTopic<S extends z.ZodType>(
  link: HostLink,
  topic: string,
  filter: Record<string, unknown> | undefined,
  schema: S,
  listener: (payload: z.output<S>) => void,
): () => void {
  let gateId: string | undefined
  let disposed = false
  void link.call('topic.subscribe', { topic, ...(filter !== undefined ? { filter } : {}) })
    .then(result => {
      if (!result.ok) {
        console.error(`subscribeTopic: gate for ${topic} failed: ${rpcErrorText(result.error)}`)
        return
      }
      gateId = result.value.subscriptionId
      // Disposed while the gate was settling: close it right away.
      if (disposed) void link.call('topic.unsubscribe', { subscriptionId: gateId }).catch(() => undefined)
    })
    .catch(() => undefined)
  const detach = link.subscribe(topic, payload => {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      console.error(`subscribeTopic: dropping malformed ${topic} payload`, parsed.error.message)
      return
    }
    listener(parsed.data)
  })
  return () => {
    disposed = true
    detach()
    if (gateId !== undefined) void link.call('topic.unsubscribe', { subscriptionId: gateId }).catch(() => undefined)
  }
}
