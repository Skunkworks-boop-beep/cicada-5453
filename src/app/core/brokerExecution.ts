/**
 * Broker order placement: MT5-only execution path.
 *
 * Stage 1 of the spec rebuild explicitly narrows execution to MT5. Deriv and
 * Exness remain as read-only data sources (price quotes, instrument registry,
 * ticks for charts) but their order-placement code paths are removed —
 * routing an order to a Deriv broker now returns a ``data-only`` rejection
 * instead of placing a contract. The bot has to target an MT5 broker.
 *
 * Volume is rounded per instrument constraints (min/max/step).
 */

import type { BrokerConfig, Instrument } from './types';
import { computeVolumeForOrder, getVolumeConstraints } from './volumeUtils';
import { BROKER_DERIV_ID } from './registries';
import { postMt5Order, postMt5ClosePartial } from './api';

export interface PlaceOrderParams {
  instrumentId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  brokerId: string;
  brokers: BrokerConfig[];
  /** Instrument (optional). Used for volume constraints; when omitted, uses defaults 0.01–100, step 0.01. */
  instrument?: Instrument | null;
}

export type PlaceOrderResult = { success: true; volume: number; contractId?: number; ticket?: number } | { success: false; error: string };

/**
 * Place an order with the connected MT5 broker. Deriv-routed orders are
 * rejected with a data-only error so the bot can either re-route to MT5
 * or surface the misconfiguration to the user.
 */
export async function placeBrokerOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { symbol, side, size, entryPrice, stopLoss, takeProfit, brokerId, brokers } = params;
  const constraints = getVolumeConstraints(params.instrument ?? null);
  const volResult = computeVolumeForOrder(size, constraints);
  const volume = volResult.openVolume;
  const targetSize = volResult.targetSize;
  const broker = brokers.find((b) => b.id === brokerId);

  if (brokerId === BROKER_DERIV_ID || broker?.type === 'deriv_api') {
    return {
      success: false,
      error: 'Deriv is data-only; route order to an MT5 broker',
    };
  }

  void entryPrice;  // kept for signature stability — MT5 prices at request time

  const mt5Broker = brokers.find((b) => b.type === 'mt5' && b.status === 'connected');
  const useMt5 = (broker?.type === 'mt5' || broker?.type === 'exness_api') && mt5Broker;
  if (useMt5) {
    const mt5Symbol = symbol.replace('/', '');
    const result = await postMt5Order({
      symbol: mt5Symbol,
      side: side === 'LONG' ? 'buy' : 'sell',
      volume,
      sl: stopLoss,
      tp: takeProfit,
    });
    if ('error' in result) return { success: false, error: result.error };
    const ticket = result.ticket;
    if (volResult.partialCloseVolume != null && ticket != null) {
      const closeRes = await postMt5ClosePartial({
        ticket,
        symbol: mt5Symbol,
        volume: volResult.partialCloseVolume,
        positionType: side === 'LONG' ? 0 : 1,
      });
      if ('error' in closeRes) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[brokerExecution] Partial close failed:', closeRes.error);
        }
        return { success: true, volume, ticket };
      }
    }
    return { success: true, volume: targetSize, ticket };
  }

  return { success: false, error: 'No MT5 broker connected for this instrument' };
}

export interface ClosePositionParams {
  positionId: string;
  instrumentId: string;
  symbol: string;
  type: 'LONG' | 'SHORT';
  size: number;
  brokerId: string;
  brokers: BrokerConfig[];
}

export type ClosePositionResult = { success: true } | { success: false; error: string };

/**
 * Close an open position at market via MT5. Deriv-routed positions are
 * rejected: Deriv is data-only in Stage 1, and Deriv tick contracts can't be
 * closed early anyway (fixed duration).
 */
export async function closeBrokerPosition(params: ClosePositionParams): Promise<ClosePositionResult> {
  const { positionId, symbol, type, size, brokerId, brokers } = params;
  if (brokerId === BROKER_DERIV_ID || brokers.find((b) => b.id === brokerId)?.type === 'deriv_api') {
    return { success: false, error: 'Deriv is data-only; cannot close via Deriv' };
  }
  const mt5Broker = brokers.find((b) => b.type === 'mt5' && b.status === 'connected');
  const useMt5 = (brokers.find((b) => b.id === brokerId)?.type === 'mt5' || brokers.find((b) => b.id === brokerId)?.type === 'exness_api') && mt5Broker;
  if (useMt5) {
    const m = positionId.match(/^pos-mt5-(\d+)$/);
    if (!m) {
      if (positionId.startsWith('pos-exness-')) {
        return { success: false, error: 'Exness API close not yet implemented' };
      }
      return { success: false, error: 'MT5 position ticket not found' };
    }
    const ticket = parseInt(m[1], 10);
    const mt5Symbol = symbol.replace(/\s/g, '').replace('/', '');
    const positionType = type === 'LONG' ? 0 : 1;
    const res = await postMt5ClosePartial({
      ticket,
      symbol: mt5Symbol,
      volume: size,
      positionType,
    });
    if ('error' in res) return { success: false, error: res.error };
    return { success: true };
  }
  return { success: false, error: 'No MT5 broker connected for closing this position' };
}
