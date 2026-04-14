/**
 * CICADA-5453 — Core domain types for the algorithmic trading system.
 * Strategies, patterns, instruments, regimes, bots, portfolio, backtest.
 */

// ─── Instruments ─────────────────────────────────────────────────────────────
/** Fiat (forex), crypto, Deriv synthetic indices (Volatility/Crash/Boom/Jump), eXness real index CFDs (AUS200, US30, etc.) */
export type InstrumentType = 'fiat' | 'crypto' | 'synthetic_deriv' | 'indices_exness';

export interface Instrument {
  id: string;
  symbol: string;
  type: InstrumentType;
  status: 'active' | 'inactive';
  /** Spread in points (from broker when fetched). Empty until live sync. */
  spread?: number;
  /** Broker that provides this instrument (execution goes to this broker). */
  brokerId: string;
  /** Volume constraints (lots). When min > step, open uses min+step so partial close can leave step. */
  volumeMin?: number;
  volumeMax?: number;
  volumeStep?: number;
  /** Preferred timeframes for this instrument (e.g. M1, M5, M15, H1, H4, D1) */
  timeframes: Timeframe[];
  /** Rebuild interval in hours (0 = use default) */
  rebuildIntervalHours?: number;
  /** When true, this instrument is the current selection (single source of truth; Bot Builder sets it, others depend on it). */
  selected?: boolean;
}

// ─── Brokers (multi-broker: Deriv, eXness, etc.) ──────────────────────────────
/** Broker connection type: eXness REST API, MT5 add-on, or Deriv WebSocket API */
export type BrokerType = 'exness_api' | 'mt5' | 'deriv_api';

export type BrokerConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Credentials and connection params; avoid persisting plain passwords in production. */
export interface BrokerConfigCredentials {
  /** MT5: account number */
  login?: string;
  /** MT5: password; Deriv: token (session) */
  password?: string;
  /** MT5: server name (e.g. Exness broker server) */
  server?: string;
  /** Deriv: App ID from api.deriv.com */
  appId?: string;
  /** eXness API: API key from Exness Personal Area → API section */
  apiKey?: string;
  /** eXness API: optional base URL (e.g. https://api.exness.com); omit to use default */
  baseUrl?: string;
}

export interface BrokerConfig {
  id: string;
  name: string;
  type: BrokerType;
  status: BrokerConnectionStatus;
  lastError?: string;
  connectedAt?: string;
  /** Connection config (login/server for MT5; appId/token for Deriv). Persist with care. */
  config: BrokerConfigCredentials;
  /** Optional: sort order in UI */
  order?: number;
}

export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' | 'W1';

/** Trade scope: from scalp (seconds–minutes) to swing (days–weeks). Drives timeframe choice and hold duration. */
export type TradeScope = 'scalp' | 'day' | 'swing' | 'position';

// ─── Strategy & pattern categories ────────────────────────────────────────────
export type StrategyCategory = 'pattern' | 'candlestick' | 'indicator' | 'logic' | 'custom';

/** Base strategy/pattern definition with operation logic descriptor */
export interface StrategyDef {
  id: string;
  name: string;
  category: StrategyCategory;
  /** Human-readable logic: entry/exit rules, conditions */
  logic: string;
  /** Which market regimes this strategy is tuned for */
  regimes: MarketRegime[];
  /** Which trade styles (timeframe scope) it supports */
  styles: TradeStyle[];
  enabled: boolean;
}

/** Chart pattern (e.g. H&S, double top, triangles) with operation logic */
export interface ChartPatternDef extends StrategyDef {
  category: 'pattern';
  /** e.g. "Break of neckline + volume confirmation" */
  entryLogic: string;
  /** e.g. "Target = measured move; stop below right shoulder" */
  exitLogic: string;
}

/** Candlestick pattern with operation logic */
export interface CandlestickPatternDef extends StrategyDef {
  category: 'candlestick';
  /** e.g. "Close above open, body > 60% range, prior downtrend" */
  entryLogic: string;
  exitLogic: string;
}

/** Indicator-based or custom trade logic */
export interface TradeLogicDef extends StrategyDef {
  category: 'indicator' | 'logic' | 'custom';
  entryLogic: string;
  exitLogic: string;
}

export type AnyStrategyDef = ChartPatternDef | CandlestickPatternDef | TradeLogicDef;

// ─── Market regimes & trade styles ────────────────────────────────────────────
export type MarketRegime =
  | 'trending_bull'
  | 'trending_bear'
  | 'ranging'
  | 'reversal_bull'
  | 'reversal_bear'
  | 'volatile'
  | 'breakout'
  | 'consolidation'
  | 'unknown'
  /** Bypass regime filter: enter trades whenever strategy signals, regardless of detected regime. Use for diagnosis when all results are $0. */
  | 'any';

/** Regime detection result with confidence (0–1) for cross-market and strategy weighting. */
export interface RegimeState {
  regime: MarketRegime;
  confidence: number;
  trendStrength: number;
  volatilityPercent: number;
  momentum: number;
  detectedAt: string;
}

export type TradeStyle =
  | 'scalping'      // 1–5 min, precision entry/exit
  | 'day'           // intraday, 15–60 min
  | 'medium_swing' // multi-day, 4H focus
  | 'swing'         // 4H–D1
  | 'sniper';       // precision entry/exit any scope

// ─── Backtest ────────────────────────────────────────────────────────────────
export interface BacktestRunRequest {
  instrumentIds: string[];
  strategyIds: string[];
  timeframes: Timeframe[];
  regimes: MarketRegime[];
  dateFrom: string;
  dateTo: string;
  /** Optional: instrumentId -> spread (in points/pips). When set, backtest uses this instead of a fixed constant. */
  instrumentSpreads?: Record<string, number>;
  /** Risk per trade as fraction of equity (e.g. 0.01 = 1%). Overrides default. */
  riskPerTradePct?: number;
  /** Stop loss as fraction of entry price (e.g. 0.02 = 2%). Overrides default. */
  stopLossPct?: number;
  /** Take profit as multiple of stop distance (e.g. 2 = 2R). Overrides default. */
  takeProfitR?: number;
  /** Regime detection rolling window (bars). Overrides default. */
  regimeLookback?: number;
  /** Initial equity (USD). Overrides default. */
  initialEquity?: number;
  /** Slippage as price fraction. Overrides default. */
  slippagePct?: number;
  /** Optional: instrumentId -> symbol (e.g. inst-deriv-r10 -> R_10). Used for correct symbol in jobs. */
  instrument_symbols?: Record<string, string>;
  /** Optional: instrument-specific risk overrides. When set, backtest uses these per instrument instead of global defaults. */
  instrumentRiskOverrides?: Record<string, { riskPerTradePct?: number; stopLossPct?: number; takeProfitR?: number }>;
  /** "instrumentId|strategyId" or "instrumentId|strategyId|timeframe" -> risk params (takes precedence over instrumentRiskOverrides) */
  jobRiskOverrides?: Record<string, { riskPerTradePct?: number; stopLossPct?: number; takeProfitR?: number }>;
  /** Instrument-specific regime detection config (from research). Tuned from each instrument's own behavior. */
  regimeTunes?: Record<string, Record<string, number>>;
  /** When running research: use robust mode (OOS profit, walk-forward, successive halving). */
  robustMode?: boolean;
  /** Research grid: max regime configs to evaluate (default 9). Robust mode uses env CICADA_RESEARCH_MAX_REGIME_CONFIGS. */
  regimeGridMax?: number;
  /** Research grid: max strategy param combos per regime (default 2). */
  paramTuneMaxStrat?: number;
  /** Research grid: max risk param configs per regime (default 6). Robust mode uses env CICADA_RESEARCH_MAX_RISK_CONFIGS. */
  paramTuneMaxRisk?: number;
  /** Max strategy param combos per strategy (1 = family defaults; 12 = subsample grid + defaults first). */
  paramCombosLimit?: number;
  /**
   * When HTF bars are loaded: map regime from HTF to each LTF bar (slow filter).
   * false = always use LTF regime. true = use HTF regime when HTF series is long enough.
   * omit = auto (use HTF regime when enough HTF bars).
   */
  preferHtfRegime?: boolean;
}

/** Strategy params used for this backtest run (e.g. { period: 14 }). Enables param optimization. */
export type StrategyParams = Record<string, number>;

export interface BacktestResultRow {
  id: string;
  instrumentId: string;
  instrumentSymbol: string;
  strategyId: string;
  strategyName: string;
  /** Params used for this run (e.g. RSI period, MACD fast/slow). */
  strategyParams?: StrategyParams;
  timeframe: Timeframe;
  regime: MarketRegime;
  scope: TradeScope;
  winRate: number;
  profit: number;
  trades: number;
  maxDrawdown: number;
  profitFactor: number;
  /** Risk-adjusted return (annualized proxy). */
  sharpeRatio: number;
  /** Downside deviation–adjusted return. */
  sortinoRatio: number;
  /** Average bars in trade (scope-aware). */
  avgHoldBars: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  completedAt?: string;
  /** When status is 'failed': root cause error message for diagnostics. */
  error?: string;
  /** End time of backtest data (last bar timestamp, ISO). Used to avoid training data leakage. */
  dataEndTime?: string;
  /** When set: only results with dataSource === 'live' are used for NN build; synthetic results are excluded. */
  dataSource?: 'live' | 'synthetic';
  /** When trades === 0: diagnostic counters to debug why no entries occurred. */
  diagnostics?: BacktestDiagnostics;
}

/** Diagnostic counters for zero-trade backtest runs. */
export interface BacktestDiagnostics {
  barsCount: number;
  signalsFired: number;
  regimeBlocked: number;
  regimeDistribution: Record<string, number>;
  /** Long (1) vs short (-1) signal counts. */
  signalDirectionDistribution?: { long: number; short: number };
  /** Human-readable reason for zero trades (for logging/UI). */
  zeroTradeReason?: string;
}

export type BacktestStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';

// ─── Neural network bot (per instrument / timeframe / regime) ─────────────────
/** Per-bot scope selector config: dynamic trade mode selection by equity, regime, volatility, etc. */
export interface BotScopeSelectorConfig {
  /** Below this equity (USD), only scalp allowed. */
  equityScalpOnly: number;
  /** Below this equity, scalp or day only (no swing/position). */
  equityDayMin: number;
  /** When regime confidence >= this and trending, prefer swing. 0–1. */
  trendConfidenceSwing: number;
  /** When volatility (ATR %) > this, avoid scalp. */
  volatilityNoScalp: number;
  /** When drawdown > this (0–1), prefer scalp only. */
  drawdownScalpOnly: number;
  /** When drawdown > this, pause (no new positions). */
  drawdownPause: number;
  /** When regime confidence >= this, allow 2 positions per instrument. 0–1. */
  confidenceForSecondEntry: number;
  /** When regime confidence >= this, allow 3 positions per instrument. 0–1. */
  confidenceForThirdEntry: number;
  /** Absolute cap on positions per instrument (regardless of confidence). */
  maxPositionsPerInstrument: number;
}

/** Default scope selector config. */
export const DEFAULT_SCOPE_SELECTOR_CONFIG: BotScopeSelectorConfig = {
  equityScalpOnly: 50,
  equityDayMin: 500,
  trendConfidenceSwing: 0.7,
  volatilityNoScalp: 0.03,
  drawdownScalpOnly: 0.1,
  drawdownPause: 0.2,
  confidenceForSecondEntry: 0.7,
  confidenceForThirdEntry: 0.85,
  maxPositionsPerInstrument: 3,
};

/** Institutional risk parameters per bot. */
export interface BotRiskParams {
  /** Risk per trade as fraction of equity (e.g. 0.01 = 1%). */
  riskPerTradePct: number;
  /** Max drawdown before bot pauses (e.g. 0.15 = 15%). */
  maxDrawdownPct: number;
  /** Use Kelly-optimal position sizing (fraction of full Kelly). */
  useKelly: boolean;
  /** Kelly fraction cap (e.g. 0.25 = quarter Kelly). */
  kellyFraction: number;
  /** Max correlation-weighted exposure (e.g. 1.5 = 150% of equity in correlated bucket). */
  maxCorrelatedExposure: number;
  /** Hard stop-loss as fraction of entry (e.g. 0.02 = 2%). */
  defaultStopLossPct: number;
  /** Take-profit as multiple of risk (e.g. 2 = 2R). */
  defaultRiskRewardRatio: number;
}

export interface BotConfig {
  id: string;
  name: string;
  instrumentId: string;
  instrumentSymbol: string;
  timeframes: Timeframe[];
  /** Trade styles this bot is optimized for */
  styles: TradeStyle[];
  /** Allowed trade scopes (scalp/day/swing/position) for cross-scope operation */
  allowedScopes: TradeScope[];
  /** Scope selection mode: auto = dynamic by equity/regime/volatility; manual = always use fixedScope */
  scopeMode?: 'auto' | 'manual';
  /** When scopeMode === 'manual', always use this scope (single selection) */
  fixedScope?: TradeScope;
  /** When manual: which TradeStyle was selected (scalping/day/medium_swing/swing/sniper) for display */
  fixedStyle?: TradeStyle;
  /** When manual with multi-select: selected TradeStyles. Empty or all 5 → auto. 1 → fixedScope. 2–4 → auto logic within those scopes. */
  fixedStyles?: TradeStyle[];
  regimes: MarketRegime[];
  strategyIds: string[];
  riskLevel: number; // 1–5
  maxPositions: number;
  /** Institutional risk parameters */
  riskParams: BotRiskParams;
  status: 'building' | 'ready' | 'deployed' | 'outdated';
  buildProgress: number;
  lastBacktestRunId?: string;
  nextRebuildAt?: string;
  /** Set when build fails (e.g. "Run a backtest first", "Backend unavailable") */
  lastError?: string;
  /** When model was deployed (for cold-start warmup). Set on deploy; used to scale position size during warmup. */
  deployedAt?: string;
  /** When drift was detected (live performance diverging from backtest). Triggers early rebuild. */
  driftDetectedAt?: string;
  /** Reason for drift (e.g. "Live win rate 38% vs backtest 58%"). */
  forceRebuildReason?: string;
  /** 256-dim feature vector from last successful build; used for /predict with regime/timeframe at inference. */
  nnFeatureVector?: number[];
  /** Out-of-sample accuracy from last build (0–1). */
  oosAccuracy?: number;
  /** Number of validation samples used for OOS. */
  oosSampleCount?: number;
  /** When detection model: timeframe NN was trained on (for bar fetch at predict). */
  nnDetectionTimeframe?: string;
  /** When detection model: bar window size (for bar_window at predict). */
  nnDetectionBarWindow?: number;
}

/** Global execution: when true, deployed bots are allowed to execute trades */
export type BotExecutionState = {
  enabled: boolean;
  /** When execution was toggled */
  updatedAt: string;
};

// ─── Portfolio (bot-managed) ─────────────────────────────────────────────────
export type PositionSide = 'LONG' | 'SHORT';

export interface Position {
  id: string;
  instrumentId: string;
  instrument: string;
  type: PositionSide;
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  /** Trade scope for this position (scalp/day/swing/position) */
  scope: TradeScope;
  style: TradeStyle;
  botId: string;
  openedAt: string;
  /** Institutional: stop-loss price (optional; bot riskParams default if absent) */
  stopLoss?: number;
  /** Institutional: take-profit price */
  takeProfit?: number;
  /** Risk amount in account currency at open */
  riskAmount: number;
  /** Balance at entry (for P/L % on tick contracts). Set when position is opened. */
  balanceAtEntry?: number;
  /** NN sl_pct used for this position (for closed trade log consistency) */
  nnSlPct?: number;
  /** NN tp_r used for this position (for closed trade log consistency) */
  nnTpR?: number;
  /** NN size_multiplier used for this position */
  nnSizeMult?: number;
}

/** Record of a closed position for drift detection (live win rate vs backtest). */
export interface ClosedTrade {
  id: string;
  botId: string;
  instrumentId: string;
  type?: PositionSide;
  /** Lot/volume size used for this trade */
  size?: number;
  /** Entry price when position was opened */
  entryPrice?: number;
  /** Exit price when position was closed (actual from broker when available) */
  exitPrice?: number;
  pnl: number;
  pnlPercent: number;
  /** Entry time (ISO). Used for backward validation to locate entry bar in OHLCV. */
  openedAt?: string;
  closedAt: string; // ISO
  /** Trade scope (scalp/day/swing/position) when known */
  scope?: TradeScope;
  /** Deriv contract_id for broker matching and deduplication */
  contractId?: number;
  /** Broker-specific key (e.g. MT5 ticket) for matching and deduplication */
  brokerKey?: string;
  /** Balance at entry (for P/L % = profit/balanceAtEntry). Set when position opened. */
  balanceAtEntry?: number;
  /** NN sl_pct used for entry (for log consistency) */
  nnSlPct?: number;
  /** NN tp_r used for entry (for log consistency) */
  nnTpR?: number;
  /** NN size_multiplier used for entry */
  nnSizeMult?: number;
}

/** Where portfolio data comes from; 'none' = no live data yet. */
export type PortfolioDataSource = 'none' | 'mt5' | 'deriv';

export interface PortfolioState {
  balance: number;
  equity: number;
  /** Peak equity (high-water mark) for drawdown calculation */
  peakEquity: number;
  /** Current drawdown from peak (0–1) */
  drawdownPct: number;
  positions: Position[];
  totalPnl: number;
  totalPnlPercent: number;
  /** Live data source; 'none' when no broker has supplied balance/positions. */
  dataSource: PortfolioDataSource;
}

/** Global risk limits (institutional): applied across all bots. */
export interface RiskLimits {
  maxTotalExposurePct: number;
  maxDrawdownPct: number;
  maxPositionsPerInstrument: number;
  maxCorrelatedBucketExposurePct: number;
}

// ─── Rebuild scheduler ────────────────────────────────────────────────────────
export interface RebuildScheduleEntry {
  instrumentId: string;
  instrumentSymbol: string;
  nextRunAt: string; // ISO
  intervalHours: number;
  reason: 'periodic' | 'regime_change' | 'manual' | 'performance_drop' | 'drift';
}
