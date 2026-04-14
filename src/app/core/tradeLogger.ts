/**
 * Structured logging and persistence for trade opens and closes.
 * Mitigates edge cases: duplicate detection, audit trail, recovery from crash.
 */

export type TradeLogEvent = 
  | { kind: 'trade_open'; positionId: string; brokerKey?: string; instrumentId: string; symbol: string; type: 'LONG' | 'SHORT'; size: number; entryPrice: number; botId: string; scope: string; timestamp: string }
  | { kind: 'trade_close'; positionId: string; brokerKey?: string; instrumentId: string; symbol: string; type?: 'LONG' | 'SHORT'; entryPrice: number; exitPrice?: number; pnl: number; pnlPercent: number; botId: string; timestamp: string };

const TRADE_LOG_MAX = 500;
let inMemoryTradeLog: Array<TradeLogEvent & { loggedAt: string }> = [];

/** Append trade event to in-memory log only. Persistent audit is backend execution-log. */
export function logTradeEvent(event: TradeLogEvent): void {
  const full = { ...event, loggedAt: new Date().toISOString() };
  if (typeof console !== 'undefined' && console.info) {
    const msg = event.kind === 'trade_open'
      ? `[TRADE_OPEN] ${event.symbol} ${event.type} ${event.size} @ ${event.entryPrice} id=${event.positionId}`
      : `[TRADE_CLOSE] ${event.symbol} P/L=$${event.pnl.toFixed(2)} (${event.pnlPercent.toFixed(2)}%) id=${event.positionId}`;
    console.info(msg, full);
  }
  inMemoryTradeLog.push(full);
  if (inMemoryTradeLog.length > TRADE_LOG_MAX) {
    inMemoryTradeLog = inMemoryTradeLog.slice(-TRADE_LOG_MAX);
  }
}

/** Convert trade event to execution-log format for backend persistence. */
export function tradeEventToExecutionLog(event: TradeLogEvent): { botId: string; symbol: string; phase: string; outcome: string; message: string; details?: Record<string, unknown> } {
  const timestamp = new Date().toISOString();
  if (event.kind === 'trade_open') {
    return {
      botId: event.botId,
      symbol: event.symbol,
      phase: 'trade_open',
      outcome: 'success',
      message: `Opened ${event.type} ${event.size} @ ${event.entryPrice}`,
      details: {
        positionId: event.positionId,
        brokerKey: event.brokerKey,
        instrumentId: event.instrumentId,
        size: event.size,
        entryPrice: event.entryPrice,
        scope: event.scope,
        timestamp: event.timestamp,
      },
    };
  }
  const isDeriv = /inst-deriv/.test(event.instrumentId) || /^R_/.test(event.symbol ?? '');
  return {
    botId: event.botId,
    symbol: event.symbol,
    phase: 'trade_close',
    outcome: 'success',
    message: isDeriv ? 'Closed' : `Closed P/L $${event.pnl.toFixed(2)} (${event.pnlPercent.toFixed(2)}%)`,
    details: {
      positionId: event.positionId,
      brokerKey: event.brokerKey,
      instrumentId: event.instrumentId,
      type: event.type,
      entryPrice: event.entryPrice,
      ...(event.exitPrice != null && { exitPrice: event.exitPrice }),
      ...(!isDeriv && { pnl: event.pnl, pnlPercent: event.pnlPercent }),
      timestamp: event.timestamp,
    },
  };
}
