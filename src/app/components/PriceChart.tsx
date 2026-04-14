import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useTradingStore } from '../store/TradingStore';
import { fetchOHLCV } from '../core/ohlcvFeed';
import { LIVE_FEED_INTERVAL_MS } from '../core/config';

interface ChartData {
  time: string;
  timeFull: string;
  price: number;
}

const LOADING_TIMEOUT_MS = 15_000;

export function PriceChart() {
  const { state } = useTradingStore();
  const selected = state.instruments.find((i) => i.selected);
  const [data, setData] = useState<ChartData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingSlow, setLoadingSlow] = useState(false);
  const hasConnection = state.brokers.some((b) => b.status === 'connected');

  useEffect(() => {
    if (!selected || !hasConnection) {
      setData([]);
      setError(hasConnection ? 'Select an instrument' : 'Connect broker for live chart');
      return;
    }
    setError(null);
    setLoadingSlow(false);
    let cancelled = false;
    const slowTimer = setTimeout(() => {
      if (!cancelled) setLoadingSlow(true);
    }, LOADING_TIMEOUT_MS);
    const symbol = selected.symbol ?? selected.id.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/');
    const brokers = state.brokers;
    const doFetch = () =>
      fetchOHLCV({
        instrumentId: selected.id,
        symbol,
        brokerId: selected.brokerId,
        timeframe: 'M5',
        brokers,
        activity: 'live',
        count: 100,
      })
        .then(({ bars }) => {
          if (cancelled) return;
          const chartData: ChartData[] = bars.map((b) => {
            const d = new Date(b.time);
            return {
              time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
              timeFull: d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
              price: b.close,
            };
          });
          setData(chartData);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : 'Fetch failed');
            setData([]);
          }
        });
    doFetch();
    const interval = setInterval(doFetch, LIVE_FEED_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearInterval(interval);
    };
  }, [selected?.id, hasConnection]);

  const currentPrice = data.length > 0 ? data[data.length - 1].price : 0;
  const priceChange = data.length > 1 ? currentPrice - data[0].price : 0;
  const priceChangePercent = data.length > 1 && data[0].price ? (priceChange / data[0].price) * 100 : 0;

  if (error) {
    return (
      <div className="border border-[#00ff00] bg-black p-4">
        <div className="text-[#ff6600] text-[10px]">{error}</div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="border border-[#00ff00] bg-black p-4">
        <div className="text-[#00ff00] text-[10px]">Loading chart...</div>
        {loadingSlow && (
          <div className="text-[#ff6600] text-[10px] mt-2">Taking longer than usual—check broker connection and retry.</div>
        )}
      </div>
    );
  }

  return (
    <div className="border border-[#00ff00] bg-black p-4 h-full flex flex-col">
      <div className="text-[#00ff00] text-[10px] mb-2">LIVE — from broker</div>
      <div className="mb-3">
        <div className="text-[#00ff00] text-xs mb-1">┌─ {selected?.symbol ?? 'Chart'} ─────────────────────────┐</div>
        <div className="flex items-baseline gap-3">
          <span className="text-[#00ff00] text-2xl font-mono">${Number(currentPrice).toFixed(3)}</span>
          <span className={`text-sm ${priceChange >= 0 ? 'text-[#00ff00]' : 'text-[#ff0000]'}`}>
            {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(3)} ({priceChangePercent >= 0 ? '+' : ''}{priceChangePercent.toFixed(2)}%)
          </span>
        </div>
        <div className="text-[#00ff00] text-xs mt-1">└────────────────────────────────────┘</div>
      </div>

      <div className="flex-1 min-h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#00ff0033" />
            <XAxis dataKey="time" hide />
            <YAxis stroke="#00ff00" tick={{ fill: '#00ff00', fontSize: 10 }} domain={['auto', 'auto']} tickFormatter={(v) => String(Number(v))} width={40} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#000',
                border: '1px solid #00ff00',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '12px',
                color: '#00ff00',
              }}
              formatter={(value: number) => [Number(value), 'price']}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.timeFull ?? ''}
            />
            <Line type="monotone" dataKey="price" stroke="#ff6600" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between gap-2 mt-2 pt-2 border-t border-[#00ff00]/40 text-[#00ff00] text-xs font-bold flex-wrap" style={{ textShadow: '0 0 6px rgba(0,255,0,0.8)' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => {
          const idx = Math.min(Math.floor(p * (data.length - 1)), data.length - 1);
          return <span key={p}>{data[idx]?.timeFull ?? '—'}</span>;
        })}
      </div>
    </div>
  );
}
