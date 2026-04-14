import { useTradingStore } from '../store/TradingStore';

export function OrderBook() {
  const { state } = useTradingStore();
  const hasConnection = state.brokers.some((b) => b.status === 'connected');

  return (
    <div className="border border-[#00ff00] bg-black p-4 h-full flex flex-col">
      <div className={`text-[10px] mb-2 ${hasConnection ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
        {hasConnection
          ? 'Deriv/MT5 do not expose order book — use TickerBar and PriceChart for live prices'
          : 'Connect Deriv or MT5 in Brokers for live data'}
      </div>
      <div className="text-[#00ff00] text-xs mb-3">┌─ ORDER BOOK ──────────────────────┐</div>
      <div className="flex-1 flex items-center justify-center text-[#00ff00]/60 text-xs">
        {hasConnection
          ? 'Order book not supported by these brokers. TickerBar and PriceChart show live prices.'
          : 'Connect a broker for live data. TickerBar and PriceChart show prices when connected.'}
      </div>
      <div className="text-[#00ff00] text-xs mt-3">└────────────────────────────────────┘</div>
    </div>
  );
}
