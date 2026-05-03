/**
 * Read-only client for the backend's append-only order + SL/TP-event store.
 *
 * Frontend never writes order records directly — it emits intent (via the
 * existing bot execution path) and reads the projected state through the
 * `/orders` and `/sl_tp_events` endpoints exposed by `python/cicada_nn/api.py`.
 *
 * Mirrors the row dataclasses in `python/cicada_nn/order_records.py`.
 */

import { getRemoteServerUrl } from './config';

export type OrderStatus =
  | 'intent'
  | 'rejected'
  | 'submitted'
  | 'filled'
  | 'closed'
  | 'broker_error';

export type SLTPEventKind =
  | 'initial'
  | 'move_be'
  | 'trail'
  | 'partial_tp'
  | 'sl_hit'
  | 'tp_hit';

export interface OrderRow {
  id: number;
  botId: string;
  instrumentId: string;
  instrumentSymbol: string;
  style: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number | null;
  status: OrderStatus;
  reason: string | null;
  ticket: number | null;
  dataSource: string;
  ts: number;
}

export interface SLTPEventRow {
  id: number;
  ticket: number;
  botId: string;
  kind: SLTPEventKind;
  sl: number | null;
  tp: number | null;
  price: number | null;
  note: string | null;
  ts: number;
}

interface OrderRowApi {
  id: number;
  bot_id: string;
  instrument_id: string;
  instrument_symbol: string;
  style: string;
  side: string;
  size: number;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  confidence: number | null;
  status: string;
  reason: string | null;
  ticket: number | null;
  data_source: string;
  ts: number;
}

interface SLTPEventRowApi {
  id: number;
  ticket: number;
  bot_id: string;
  kind: string;
  sl: number | null;
  tp: number | null;
  price: number | null;
  note: string | null;
  ts: number;
}

function snakeToOrder(r: OrderRowApi): OrderRow {
  return {
    id: r.id,
    botId: r.bot_id,
    instrumentId: r.instrument_id,
    instrumentSymbol: r.instrument_symbol,
    style: r.style,
    side: (r.side === 'SHORT' ? 'SHORT' : 'LONG'),
    size: r.size,
    entryPrice: r.entry_price,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    confidence: r.confidence,
    status: r.status as OrderStatus,
    reason: r.reason,
    ticket: r.ticket,
    dataSource: r.data_source,
    ts: r.ts,
  };
}

function snakeToSLTP(r: SLTPEventRowApi): SLTPEventRow {
  return {
    id: r.id,
    ticket: r.ticket,
    botId: r.bot_id,
    kind: r.kind as SLTPEventKind,
    sl: r.sl,
    tp: r.tp,
    price: r.price,
    note: r.note,
    ts: r.ts,
  };
}

interface FetchFilters {
  botId?: string;
  ticket?: number;
  since?: number;
  limit?: number;
}

function buildQuery(filters: FetchFilters): string {
  const params = new URLSearchParams();
  if (filters.botId) params.set('bot_id', filters.botId);
  if (filters.ticket != null) params.set('ticket', String(filters.ticket));
  if (filters.since != null) params.set('since', String(filters.since));
  if (filters.limit != null) params.set('limit', String(filters.limit));
  const q = params.toString();
  return q ? `?${q}` : '';
}

export async function fetchOrders(filters: FetchFilters = {}): Promise<OrderRow[]> {
  const base = getRemoteServerUrl();
  if (!base) return [];
  const res = await fetch(`${base}/orders${buildQuery(filters)}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { rows?: OrderRowApi[] };
  return (json.rows ?? []).map(snakeToOrder);
}

export async function fetchSLTPEvents(filters: FetchFilters = {}): Promise<SLTPEventRow[]> {
  const base = getRemoteServerUrl();
  if (!base) return [];
  const res = await fetch(`${base}/sl_tp_events${buildQuery(filters)}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { rows?: SLTPEventRowApi[] };
  return (json.rows ?? []).map(snakeToSLTP);
}
