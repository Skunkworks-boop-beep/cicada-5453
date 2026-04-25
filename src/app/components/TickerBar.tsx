import { useEffect, useState, useRef } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useTradingStore } from '../store/TradingStore';
import { getMt5Prices } from '../core/api';
import { getDerivPortfolioPrices } from '../core/derivApi';
import { BROKER_DERIV_ID } from '../core/registries';
import { LIVE_FEED_INTERVAL_MS } from '../core/config';

interface Ticker {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
}

export function TickerBar() {
  const { state } = useTradingStore();
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [prevPrices, setPrevPrices] = useState<Record<string, number>>({});
  const tickersRef = useRef<Ticker[]>([]);
  tickersRef.current = tickers;
  const derivConnected = state.brokers.some((b) => b.id === BROKER_DERIV_ID && b.status === 'connected');
  const mt5Connected = state.brokers.some((b) => b.type === 'mt5' && b.status === 'connected');
  const exnessApiConnected = state.brokers.some((b) => b.type === 'exness_api' && b.status === 'connected');
  const hasConnection = derivConnected || mt5Connected || exnessApiConnected;

  // Old behaviour fetched the first 5 registry instruments by index even when
  // the user wasn't trading them — burned the broker rate limit fast. Now we
  // only ticker instruments the user is actually using:
  //   - explicitly marked "selected" in the dashboard, OR
  //   - active + has an existing position, OR
  //   - active + has a deployed bot
  // Worst case: still capped at 8 symbols so a heavy account doesn't hammer.
  const inUseInstrumentIds = new Set<string>();
  for (const p of state.portfolio.positions) inUseInstrumentIds.add(p.instrumentId);
  for (const b of state.bots) {
    if (b.status === 'deployed' && b.instrumentId) inUseInstrumentIds.add(b.instrumentId);
  }
  const symbols = state.instruments
    .filter(
      (i) =>
        i.status === 'active' && (i.selected || inUseInstrumentIds.has(i.id))
    )
    .slice(0, 8)
    .map((i) => (i.symbol ?? i.id.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/')).replace('/', ''))
    .filter(Boolean);
  const uniqueSymbols = [...new Set(symbols)];

  useEffect(() => {
    if (!hasConnection || uniqueSymbols.length === 0) {
      setTickers([]);
      return;
    }
    const fetchPrices = async () => {
      if (derivConnected) {
        try {
          const prices = await getDerivPortfolioPrices();
          const list: Ticker[] = [];
          for (const sym of uniqueSymbols) {
            const q = prices[sym] ?? prices[sym.toUpperCase()];
            if (q && (q.bid > 0 || q.ask > 0)) {
              const mid = (q.bid + q.ask) / 2;
              list.push({ symbol: sym, price: mid, bid: q.bid, ask: q.ask });
            }
          }
          if (list.length > 0) {
            setPrevPrices((p) => {
              const next = { ...p };
              for (const t of tickersRef.current) next[t.symbol] = t.price;
              return next;
            });
            setTickers(list);
          }
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[TickerBar] ticker fetch failed:', e);
          }
        }
      } else if (mt5Connected || exnessApiConnected) {
        const res = await getMt5Prices(uniqueSymbols);
        if ('prices' in res && res.prices) {
          const list: Ticker[] = [];
          for (const sym of uniqueSymbols) {
            const q = res.prices[sym] ?? res.prices[sym.toUpperCase()];
            if (q && (q.bid > 0 || q.ask > 0)) {
              const mid = (q.bid + q.ask) / 2;
              list.push({ symbol: sym, price: mid, bid: q.bid, ask: q.ask });
            }
          }
          if (list.length > 0) {
            setPrevPrices((p) => {
              const next = { ...p };
              for (const t of tickersRef.current) next[t.symbol] = t.price;
              return next;
            });
            setTickers(list);
          }
        }
      }
    };
    fetchPrices();
    const interval = setInterval(fetchPrices, derivConnected ? 8_000 : LIVE_FEED_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasConnection, derivConnected, mt5Connected, exnessApiConnected, uniqueSymbols.join(',')]);

  useEffect(() => {
    if (tickers.length > 0) {
      setPrevPrices((p) => {
        const next = { ...p };
        for (const t of tickers) {
          if (!(t.symbol in next)) next[t.symbol] = t.price;
        }
        return next;
      });
    }
  }, [tickers]);

  if (!hasConnection) {
    return (
      <div className="border border-[#00ff00] bg-black p-3">
        <div className="text-[#ff6600] text-[10px]">Connect Deriv, eXness, or MT5 in Brokers for live prices</div>
      </div>
    );
  }

  if (tickers.length === 0) {
    return (
      <div className="border border-[#00ff00] bg-black p-3">
        <div className="text-[#00ff00] text-[10px]">Fetching live prices...</div>
      </div>
    );
  }

  return (
    <div className="border border-[#00ff00] bg-black p-3 overflow-hidden">
      <div className="text-[#00ff00] text-[10px] mb-2">LIVE — from broker</div>
      <div className="flex gap-6 animate-marquee">
        {tickers.map((ticker, idx) => {
          const prev = prevPrices[ticker.symbol] ?? ticker.price;
          const change = ticker.price - prev;
          const changePercent = prev ? (change / prev) * 100 : 0;
          return (
            <div key={idx} className="flex items-center gap-2 text-sm whitespace-nowrap">
              <span className="text-[#ffff00]">{ticker.symbol}</span>
              <span className="text-[#00ff00]">${ticker.price}</span>
              <span className={change >= 0 ? 'text-[#00ff00]' : 'text-[#ff0000]'}>
                {change >= 0 ? <TrendingUp className="w-3 h-3 inline" /> : <TrendingDown className="w-3 h-3 inline" />}
                {change >= 0 ? '+' : ''}{change.toFixed(3)} ({changePercent >= 0 ? '+' : ''}{changePercent.toFixed(2)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
