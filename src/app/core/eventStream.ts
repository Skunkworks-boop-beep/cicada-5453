/**
 * Frontend subscriber for the backend's SSE /events stream.
 *
 * Replaces the front-end's polling of /jobs and the bot execution loop. The
 * backend daemon now pushes everything; we just reduce.
 *
 * Topics emitted by the backend (see python/cicada_nn/event_bus.py + producers):
 *   - ``hello``       — initial connection ack
 *   - ``job``         — backtest / research / shadow job lifecycle
 *   - ``bot``         — daemon deploy/stop/enable/disable
 *   - ``bot_tick``    — per-tick decision (predict, ensemble, risk, order)
 *   - ``order``       — order placed by the daemon
 *   - ``daemon``      — daemon-level events (boot, shutdown)
 *   - ``log``         — generic log line (level + message)
 *   - ``shadow``      — shadow-training transitions (handled elsewhere too)
 */

import { getNnApiBaseUrl } from './config';

export interface ServerEvent {
  id: string;
  topic: string;
  ts: number;
  [key: string]: unknown;
}

export type EventHandler = (ev: ServerEvent) => void;

interface SubscriptionOptions {
  topics?: string[];
  /** Called on each event (after topic filtering). */
  onEvent: EventHandler;
  /** Called when the stream connects (or reconnects). */
  onOpen?: () => void;
  /** Called on transient errors. The hook still auto-reconnects. */
  onError?: (err: Event | Error) => void;
}

export interface EventStreamHandle {
  /** Stop receiving events and close the underlying connection. */
  close(): void;
  /** True while the underlying EventSource is open. */
  isOpen(): boolean;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Subscribe to the backend SSE stream. Re-connects with exponential backoff up
 * to 15 s between attempts. ``close()`` is idempotent.
 */
export function subscribeToEvents(options: SubscriptionOptions): EventStreamHandle {
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const connect = (): void => {
    if (stopped) return;
    const params = new URLSearchParams();
    if (options.topics?.length) params.set('topics', options.topics.join(','));
    const url = `${getNnApiBaseUrl()}/events${params.toString() ? `?${params}` : ''}`;
    try {
      es = new EventSource(url, { withCredentials: false });
    } catch (err) {
      options.onError?.(err as Error);
      scheduleReconnect();
      return;
    }
    es.onopen = () => {
      attempt = 0;
      options.onOpen?.();
    };
    es.onmessage = (ev) => handleRaw(ev);
    // Topic-tagged events arrive as named events, not the default `message`.
    // We attach a single listener per topic the backend may emit.
    for (const topic of [
      'hello',
      'job',
      'bot',
      'bot_tick',
      'order',
      'daemon',
      'log',
      'shadow',
    ]) {
      es.addEventListener(topic, handleRaw as EventListener);
    }
    es.onerror = (err) => {
      options.onError?.(err);
      // Browser auto-retries `EventSource`, but transient network errors leave
      // the connection in a half-open state. Force reconnect through our own
      // backoff so we surface a fresh ``onOpen`` and reset attempt count.
      es?.close();
      es = null;
      scheduleReconnect();
    };
  };

  const handleRaw = (ev: MessageEvent): void => {
    if (!ev.data) return;
    try {
      const parsed = JSON.parse(ev.data) as ServerEvent;
      options.onEvent(parsed);
    } catch (err) {
      options.onError?.(err as Error);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  connect();

  return {
    close: () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
    },
    isOpen: () => es !== null && es.readyState === EventSource.OPEN,
  };
}
