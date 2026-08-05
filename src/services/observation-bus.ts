import { EventEmitter } from 'node:events';
import type { Observation } from '../types/types.js';

/**
 * In-process pub/sub for observation lifecycle events. The REST observation
 * ingest handlers publish; the SSE route subscribes per connection.
 *
 * Backpressure / slow-consumer policy lives in the subscriber — the bus itself
 * is fire-and-forget. EventEmitter dispatches synchronously, so if a subscriber
 * needs to drop on overflow it should do so inside its handler (e.g. check
 * res.writableNeedDrain for SSE writers).
 */
export interface ObservationEvent {
  /** Mirrors the row's `status` column at publish time. */
  kind: 'started' | 'completed' | 'failed';
  observation: Observation;
  /** Monotonic per-process counter for client-side gap detection. */
  seq: number;
  /** Publish timestamp (Date.now()). */
  ts: number;
}

export class ObservationBus {
  private emitter = new EventEmitter();
  private seq = 0;
  private subscriberCount = 0;

  constructor() {
    // Per-process bound; sized above the realistic concurrent SSE viewer count.
    this.emitter.setMaxListeners(200);
  }

  publish(observation: Observation): void {
    if (this.subscriberCount === 0) return;
    const event: ObservationEvent = {
      kind: observation.status,
      observation,
      seq: ++this.seq,
      ts: Date.now(),
    };
    this.emitter.emit('event', event);
  }

  subscribe(handler: (event: ObservationEvent) => void): () => void {
    this.emitter.on('event', handler);
    this.subscriberCount++;
    return () => {
      this.emitter.off('event', handler);
      this.subscriberCount--;
    };
  }

  get listenerCount(): number {
    return this.subscriberCount;
  }
}
