/**
 * Live bid/ask spread for selected instrument.
 * Replaces Order Book (not supported by Deriv/MT5).
 * Isolated: retries fetch when stale; never disconnects broker — connection is app-wide and stable.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useTradingStore } from '../store/TradingStore';
import { getMt5Prices } from '../core/api';
import { getDerivSymbolQuote } from '../core/derivApi';
import { BROKER_DERIV_ID, BROKER_EXNESS_ID, BROKER_EXNESS_API_ID } from '../core/registries';
import { LIVE_FEED_INTERVAL_MS } from '../core/config';

/** Slower poll for Live Spread to avoid rate limit (ticks stream). */
const LIVE_SPREAD_INTERVAL_MS = 5_000;
import { isMarketOpen } from '../core/marketHours';

const STALE_THRESHOLD_MS = 8_000;
const RETRY_INTERVAL_MS = 1_500;

function findPrice<T>(prices: Record<string, T>, symbol: string): T | undefined {
  const variants = [
    symbol,
    symbol.toUpperCase(),
    symbol.replace(/\s/g, ''),
    symbol.replace(/\s/g, '') + 'm',
    symbol.replace(/\s/g, '') + '.',
  ];
  for (const v of variants) {
    const q = prices[v];
    if (q !== undefined) return q;
  }
  return undefined;
}

export function LiveSpreadPanel() {
  const { state, actions } = useTradingStore();
  const selected = state.instruments.find((i) => i.selected);
  const [bid, setBid] = useState<number | null>(null);
  const [ask, setAsk] = useState<number | null>(null);
  const lastSuccessAt = useRef<number>(0);
  const [isStale, setIsStale] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const derivConnected = state.brokers.some((b) => b.id === BROKER_DERIV_ID && b.status === 'connected');
  const mt5Connected = state.brokers.some((b) => b.type === 'mt5' && b.status === 'connected');
  const exnessApiConnected = state.brokers.some((b) => b.type === 'exness_api' && b.status === 'connected');
  const hasConnection = derivConnected || mt5Connected || exnessApiConnected;

  const symbol = selected
    ? (selected.symbol ?? selected.id.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/')).replace(/\//g, '')
    : null;

  const useDeriv = selected?.brokerId === BROKER_DERIV_ID && derivConnected;
  const useMt5 = (selected?.brokerId === BROKER_EXNESS_ID || selected?.brokerId === BROKER_EXNESS_API_ID) && (mt5Connected || exnessApiConnected);

  const fetchPrices = useCallback(async () => {
    if ((!useDeriv && !useMt5) || !symbol) return false;
    try {
      if (useDeriv) {
        const q = await getDerivSymbolQuote(symbol);
        if (q && (q.bid > 0 || q.ask > 0)) {
          setBid(q.bid);
          setAsk(q.ask);
          lastSuccessAt.current = Date.now();
          return true;
        }
      } else if (useMt5) {
        const res = await getMt5Prices([symbol]);
        if ('prices' in res && res.prices) {
          const q = findPrice(res.prices, symbol);
          if (q && (q.bid > 0 || q.ask > 0)) {
            setBid(q.bid);
            setAsk(q.ask);
            lastSuccessAt.current = Date.now();
            return true;
          }
        }
      }
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[LiveSpreadPanel] fetchPrices failed:', e);
      }
    }
    return false;
  }, [useDeriv, useMt5, symbol]);

  useEffect(() => {
    if ((!useDeriv && !useMt5) || !symbol) {
      setBid(null);
      setAsk(null);
      lastSuccessAt.current = 0;
      setIsStale(false);
      return;
    }
    lastSuccessAt.current = 0;
    fetchPrices();
    const interval = setInterval(fetchPrices, useDeriv ? LIVE_SPREAD_INTERVAL_MS : LIVE_FEED_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [useDeriv, useMt5, symbol, fetchPrices]);

  // Liveness check: detect stale data and retry more aggressively (isolated — never touches broker connection)
  useEffect(() => {
    if ((!useDeriv && !useMt5) || !symbol) return;
    const check = () => {
      const elapsed = Date.now() - lastSuccessAt.current;
      const wasStale = isStale;
      setIsStale((s) => {
        const nowStale = lastSuccessAt.current > 0 && elapsed > STALE_THRESHOLD_MS;
        return nowStale;
      });
      if (elapsed > STALE_THRESHOLD_MS && !wasStale) {
        setRetryKey((k) => k + 1);
      }
    };
    const t = setInterval(check, 2_000);
    return () => clearInterval(t);
  }, [useDeriv, useMt5, symbol, isStale]);

  // When stale, retry more frequently
  useEffect(() => {
    if (!isStale || (!useDeriv && !useMt5) || !symbol) return;
    const t = setInterval(fetchPrices, RETRY_INTERVAL_MS);
    return () => clearInterval(t);
  }, [isStale, useDeriv, useMt5, symbol, fetchPrices, retryKey]);

  const spread = bid != null && ask != null ? ask - bid : null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const marketOpen = selected ? isMarketOpen(selected.type) : null;

  if (!hasConnection) {
    return (
      <div className="border border-[#00ff00] bg-black p-4 h-full flex flex-col">
        <div className="text-[#00ff00] text-[10px] mb-2">LIVE SPREAD</div>
        <div className="text-[#00ff00] text-xs mb-2">┌─ BID / ASK ──────────────────────┐</div>
        <div className="flex-1 flex items-center justify-center text-[#ff6600] text-xs">
          Connect Deriv, eXness, or MT5 in Brokers for live bid/ask
        </div>
        <div className="text-[#00ff00] text-xs mt-2">└────────────────────────────────────┘</div>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="border border-[#00ff00] bg-black p-4 h-full flex flex-col">
        <div className="text-[#00ff00] text-[10px] mb-2">LIVE SPREAD</div>
        <div className="text-[#00ff00] text-xs mb-2">┌─ BID / ASK ──────────────────────┐</div>
        <div className="flex-1 flex items-center justify-center text-[#00ff00]/60 text-xs">
          Select an instrument above
        </div>
        <div className="text-[#00ff00] text-xs mt-2">└────────────────────────────────────┘</div>
      </div>
    );
  }

  if (!useDeriv && !useMt5 && hasConnection) {
    return (
      <div className="border border-[#00ff00] bg-black p-4 h-full flex flex-col">
        <div className="text-[#00ff00] text-[10px] mb-2">LIVE SPREAD</div>
        <div className="text-[#00ff00] text-xs mb-2">┌─ {selected.symbol ?? symbol} ──────────────────────┐</div>
        <div className="flex-1 flex items-center justify-center text-[#ff6600] text-xs">
          Connect {selected.brokerId?.includes('deriv') ? 'Deriv' : 'MT5'} for this instrument
        </div>
        <div className="text-[#00ff00] text-xs mt-2">└────────────────────────────────────┘</div>
      </div>
    );
  }

  return (
    <div className="border border-[#00ff00] bg-black p-4 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[#00ff00] text-[10px]">LIVE SPREAD</div>
        {isStale && (
          <div className="flex items-center gap-1">
            <span className="text-[#ff6600] text-[9px]">Stale</span>
            <button
              type="button"
              onClick={() => { setRetryKey((k) => k + 1); fetchPrices(); }}
              className="text-[9px] border border-[#ff6600] text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660011]"
            >
              Retry
            </button>
          </div>
        )}
      </div>
      <div className="text-[#00ff00] text-xs mb-2">┌─ {selected.symbol ?? symbol} ──────────────────────┐</div>
      <div className="flex-1 flex flex-col justify-center gap-3 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-[#ff6600]">Bid</span>
          <span className="text-[#00ff00] font-mono font-bold">
            {bid != null ? bid.toFixed(3) : '—'}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-[#ff6600]">Ask</span>
          <span className="text-[#00ff00] font-mono font-bold">
            {ask != null ? ask.toFixed(3) : '—'}
          </span>
        </div>
        <div className="flex justify-between items-center border-t border-[#00ff00]/30 pt-2">
          <span className="text-[#ffff00]">Spread</span>
          <span className="text-[#00ff00] font-mono font-bold">
            {spread != null ? spread.toFixed(5) : '—'}
          </span>
        </div>
        {mid != null && (
          <div className="flex justify-between items-center text-[#00ff00]/70">
            <span>Mid</span>
            <span className="font-mono">{mid.toFixed(3)}</span>
          </div>
        )}
        {marketOpen != null && (
          <div className="flex justify-between items-center text-[10px] pt-1">
            <span className="text-[#00ff00]/60">Market</span>
            <span className={marketOpen ? 'text-[#00ff00]' : 'text-[#ff6600]'}>
              {marketOpen ? '● Open' : '○ Closed'}
            </span>
          </div>
        )}
      </div>
      <div className="text-[#00ff00] text-xs mt-2">└────────────────────────────────────┘</div>
    </div>
  );
}
