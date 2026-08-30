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
 * than the code); the standard failure copy for surfaces.
 * @param error - the `error` leg of an `ok: false` result.
 */
export function rpcErrorText(error: { code: string, details?: unknown }): string {
  const details = (error.details ?? {}) as Record<string, unknown>
  if (error.code === 'bad-request' && Array.isArray(details.issues)) {
    const issues = details.issues.filter((issue): issue is string => typeof issue === 'string')
    if (issues.length > 0) return issues.join('；')
  }
  if (typeof details.what === 'string') return details.what
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
