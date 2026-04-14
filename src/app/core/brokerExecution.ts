/**
 * Broker order placement: routes to Deriv or MT5 based on instrument and connection.
 * Used by bot execution only. Volume is rounded per instrument constraints (min/max/step).
 */

import type { BrokerConfig, Instrument } from './types';
import { computeVolumeForOrder, getVolumeConstraints } from './volumeUtils';

/** Deriv stake as fraction of notional (size * entryPrice). Min 1, max 100. */
const DERIV_STAKE_FACTOR = 0.01;
const DERIV_STAKE_MIN = 1;
const DERIV_STAKE_MAX = 100;
/** Deriv contract duration (ticks). */
const DERIV_DURATION = 5;
const DERIV_DURATION_UNIT = 't' as const;
import { BROKER_DERIV_ID } from './registries';
import { getDerivProposal, buyDerivContract, getDerivApiSymbolForRequest, getActiveSyntheticSymbols, isConnected as derivIsConnected } from './derivApi';
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
 * Place an order with the connected broker (Deriv or MT5).
 * For Deriv: proposal → buy. For MT5: postMt5Order.
 */
export async function placeBrokerOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { symbol, side, size, entryPrice, stopLoss, takeProfit, brokerId, brokers } = params;
  const constraints = getVolumeConstraints(params.instrument ?? null);
  const volResult = computeVolumeForOrder(size, constraints);
  const volume = volResult.openVolume;
  const targetSize = volResult.targetSize;
  const broker = brokers.find((b) => b.id === brokerId);

  if (brokerId === BROKER_DERIV_ID) {
    if (broker?.status !== 'connected' || !derivIsConnected()) {
      return { success: false, error: 'Deriv not connected' };
    }
    try {
      const { symbols: apiSymbols } = await getActiveSyntheticSymbols();
      const derivSymbol = getDerivApiSymbolForRequest(symbol, apiSymbols);
      const contractType = side === 'LONG' ? 'CALL' : 'PUT';
      const stake = Math.max(DERIV_STAKE_MIN, Math.min(DERIV_STAKE_MAX, Math.round(volume * entryPrice * DERIV_STAKE_FACTOR)));
      const { proposal_id, ask_price } = await getDerivProposal(derivSymbol, contractType, stake, DERIV_DURATION, DERIV_DURATION_UNIT);
      const { contract_id } = await buyDerivContract(proposal_id, ask_price);
      return { success: true, volume: targetSize, contractId: contract_id };
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[brokerExecution] Deriv order failed:', e);
      }
      return { success: false, error: e instanceof Error ? e.message : 'Deriv order failed' };
    }
  }

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

  return { success: false, error: 'No broker connected for this instrument' };
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
 * Close an open position at market. MT5: close by ticket. Deriv tick contracts: not supported (fixed duration).
 */
export async function closeBrokerPosition(params: ClosePositionParams): Promise<ClosePositionResult> {
  const { positionId, symbol, type, size, brokerId, brokers } = params;
  if (brokerId === BROKER_DERIV_ID) {
    return { success: false, error: 'Deriv tick contracts cannot be closed early; they expire at fixed duration.' };
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
  return { success: false, error: 'No broker connected for closing this position' };
}
