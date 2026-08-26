/**
 * The client carrier family: protocol invariants live in the base class;
 * platform differences are transport aspects only. Business failures come
 * back as `RpcResult` (never thrown here); transport failures are thrown by
 * the carrier; the two layers never mix.
 *
 * @module @snap-rail/protocol/client
 */

import { randomUUID } from 'node:crypto'
import type { ClientRequest, RpcResult, ServerRequest, ServerResponse } from './rpc.ts'
import { RpcId } from './rpc.ts'
import type { MethodName, RequestPayload, ResponseValue } from './methods.ts'

/** A thrown transport failure; carries no business semantics. */
export class RpcTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RpcTransportError'
  }
}

/** Signature of the raw unary transport: send one full-form request, get its full-form response. */
export type UnaryTransport = (request: ClientRequest) => Promise<ServerResponse>

/**
 * Protocol client base. Subclasses supply the unary transport; rpcId minting
 * and the echo check live here and nowhere else.
 */
export abstract class AbstractApiClient {
  /**
   * The transport aspect: deliver one full-form client request and settle
   * with its full-form server response.
   */
  protected abstract transport: UnaryTransport

  /**
   * Call a unary method with the business payload directly; the carrier
   * mints the rpcId and wraps the envelope.
   *
   * @param method - the wire method name.
   * @param payload - the business payload.
   * @returns the business result; `ok: false` is a normal outcome, not an
   * exception. Transport failures and rpcId echo mismatches throw.
   */
  async call<K extends MethodName>(method: K, payload: RequestPayload<K>): Promise<RpcResult<ResponseValue<K>>> {
    const rpcId = RpcId(`${randomUUID()}`)
    const response = await this.transport({
      type: 'client-request',
      rpcId,
      method,
      payload,
    })
    if (response.type !== 'server-response') {
      throw new RpcTransportError(`expected a server-response, received ${String(response.type)}`)
    }
    if (response.rpcId !== rpcId) {
      throw new RpcTransportError(`rpcId echo mismatch: sent ${rpcId}, received ${response.rpcId}`)
    }
    return response.result as RpcResult<ResponseValue<K>>
  }
}

/**
 * The isomorphic carrier: runs the real protocol against an injected handler
 * with no IPC at all. Tests exercise the exact envelope/result path a real
 * carrier travels.
 */
export class InProcessApiClient extends AbstractApiClient {
  private readonly queue: ServerRequest[] = []
  private resolvers: ((result: IteratorResult<ServerRequest>) => void)[] = []
  private finished = false

  protected readonly transport: UnaryTransport

  /**
   * @param handler - the gateway-side unary entry (`handleClientRequest`).
   */
  constructor(handler: (request: ClientRequest) => Promise<ServerResponse>) {
    super()
    this.transport = handler
  }

  /** Deliver a host frame into the client's mux stream (test/pump side). */
  pushFrame(frame: ServerRequest): void {
    const resolver = this.resolvers.shift()
    if (resolver !== undefined) resolver({ done: false, value: frame })
    else this.queue.push(frame)
  }

  /** The mux stream as an async iterable; ends when {@link end} is called. */
  frames(): AsyncIterable<ServerRequest> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<ServerRequest>> => {
          const frame = this.queue.shift()
          if (frame !== undefined) return Promise.resolve({ done: false, value: frame })
          if (this.finished) return Promise.resolve({ done: true, value: undefined })
          return new Promise(resolve => this.resolvers.push(resolve))
        },
      }),
    }
  }

  /** End the mux stream; pending and future iterations finish. */
  end(): void {
    this.finished = true
    for (const resolve of this.resolvers.splice(0)) resolve({ done: true, value: undefined })
  }
}
