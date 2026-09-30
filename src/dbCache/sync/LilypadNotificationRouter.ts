import type { LilypadDbNotification } from '@/dbCache/sync/LilypadDbSyncTypes';
import type { LilypadDbGate, LilypadDbListener } from '@/dbGate/LilypadDbGate';
import type { LilypadLibLogLevel } from '@/logger/LilypadLibLogger';

const OPERATIONS = new Set(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'BULK']);
/** The operations that concern the whole table, not one row: they carry no `id`. */
const TABLE_OPERATIONS = new Set(['TRUNCATE', 'BULK']);

/**
 * Parses a notification of the `cache_events` channel.
 *
 * @returns The payload, or `undefined` if it does not have the expected shape.
 */
export function parseLilypadNotification(payload: unknown): LilypadDbNotification | undefined {
  if (typeof payload !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { table, op, id, schema, xid } = parsed as Record<string, unknown>;
  if (typeof table !== 'string' || table === '' || typeof op !== 'string' || !OPERATIONS.has(op)) {
    return undefined;
  }
  if (
    !TABLE_OPERATIONS.has(op) &&
    !((typeof id === 'string' && id !== '') || typeof id === 'number')
  ) {
    return undefined;
  }
  if (
    (schema !== undefined && typeof schema !== 'string') ||
    (xid !== undefined && typeof xid !== 'string')
  ) {
    return undefined;
  }
  return parsed as LilypadDbNotification;
}

/** A cache that follows the notifications of its table. */
export type LilypadNotificationSubscriber = {
  /** The name of the table, without its schema (as `TG_TABLE_NAME` sends it). */
  readonly table: string;
  /** Applies a notification of the table. Its errors are logged with `log`. */
  handle(payload: LilypadDbNotification): Promise<void> | void;
  /** `LISTEN` is active again after its connection was lost: notifications may have been lost. */
  onReconnect(): void;
  log(level: LilypadLibLogLevel, message: string, detail?: unknown): void;
};

/**
 * Receives the notifications of a channel for every cache of a gate: one listener on the gate,
 * one `JSON.parse` per notification, and each notification handed to the caches of its table only
 * (instead of every cache parsing and filtering every notification).
 */
export class LilypadNotificationRouter {
  private readonly subscribers = new Set<LilypadNotificationSubscriber>();
  private readonly listener: LilypadDbListener;
  /** The registration of the listener on the gate, while at least one cache subscribes. */
  private listening?: Promise<void> | undefined;

  constructor(
    private readonly gate: LilypadDbGate,
    channel: string
  ) {
    this.listener = {
      channel,
      callbackId: 'lilypad_notification_router',
      callback: (payload) => this.dispatch(payload),
      onReconnect: () => {
        for (const subscriber of [...this.subscribers]) {
          subscriber.onReconnect();
        }
      },
    };
  }

  /**
   * Subscribes a cache, and resolves once the channel is listened to.
   *
   * @throws If `LISTEN` fails: the cache is then not subscribed.
   */
  async subscribe(subscriber: LilypadNotificationSubscriber): Promise<void> {
    this.subscribers.add(subscriber);
    try {
      this.listening ??= this.gate.addListener(this.listener).catch((error: unknown) => {
        this.listening = undefined;
        throw error;
      });
      await this.listening;
    } catch (error) {
      this.subscribers.delete(subscriber);
      throw error;
    }
  }

  /** Unsubscribes a cache; the last one stops listening. It never rejects. */
  async unsubscribe(subscriber: LilypadNotificationSubscriber): Promise<void> {
    if (!this.subscribers.delete(subscriber) || this.subscribers.size > 0) {
      return;
    }
    const listening = this.listening;
    this.listening = undefined;
    await listening?.catch(() => {});
    // Unless a cache subscribed again meanwhile: it registered the listener again
    if (this.subscribers.size === 0 && !this.listening) {
      await this.gate.removeListener(this.listener.channel, this.listener.callbackId);
    }
  }

  private async dispatch(raw: unknown): Promise<void> {
    const subscribers = [...this.subscribers];
    if (subscribers.length === 0) {
      return;
    }
    const payload = parseLilypadNotification(raw);
    if (!payload) {
      subscribers[0]!.log('warn', 'Ignoring a malformed cache_events notification:', raw);
      return;
    }
    await Promise.all(
      subscribers
        .filter((subscriber) => subscriber.table === payload.table)
        .map(async (subscriber) => {
          try {
            await subscriber.handle(payload);
          } catch (error) {
            subscriber.log('error', 'Error applying a notification:', error);
          }
        })
    );
  }
}

const routers = new WeakMap<LilypadDbGate, Map<string, LilypadNotificationRouter>>();

/** The router shared by the caches of a gate that listen to this channel. */
export function getLilypadNotificationRouter(
  gate: LilypadDbGate,
  channel: string
): LilypadNotificationRouter {
  let gateRouters = routers.get(gate);
  if (!gateRouters) {
    gateRouters = new Map();
    routers.set(gate, gateRouters);
  }
  let router = gateRouters.get(channel);
  if (!router) {
    router = new LilypadNotificationRouter(gate, channel);
    gateRouters.set(channel, router);
  }
  return router;
}
