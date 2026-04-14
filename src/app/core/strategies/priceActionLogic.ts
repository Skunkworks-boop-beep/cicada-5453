/**
 * Price action & trade logic strategies — 55+ (order blocks, liquidity, breakouts, etc.)
 */
import type { TradeLogicDef, MarketRegime, TradeStyle } from '../types';

const R: MarketRegime[] = ['trending_bull', 'trending_bear', 'ranging', 'reversal_bull', 'reversal_bear', 'breakout', 'consolidation', 'volatile', 'unknown'];
const S: TradeStyle[] = ['scalping', 'day', 'medium_swing', 'swing', 'sniper'];

function logic(id: string, name: string, logic: string, regimes: MarketRegime[], styles: TradeStyle[], entry: string, exit: string, enabled = true): TradeLogicDef {
  return { id, name, category: 'logic', logic, regimes, styles, enabled, entryLogic: entry, exitLogic: exit };
}

export const PRICE_ACTION_LOGIC: TradeLogicDef[] = [
  logic('pa-order-block-bull', 'Order Block (Demand)', 'Last down candle before strong up; demand zone.', R, S, 'Entry on retest of OB with confirmation.', 'Target next OB or structure; stop beyond OB.'),
  logic('pa-order-block-bear', 'Order Block (Supply)', 'Last up candle before strong down; supply zone.', R, S, 'Entry on retest of OB with confirmation.', 'Target next OB or structure.'),
  logic('pa-liquidity-sweep', 'Liquidity Sweep / Stop Hunt', 'Price sweeps high/low then reverses.', ['reversal_bull', 'reversal_bear', 'breakout', 'volatile'], ['scalping', 'day', 'sniper'], 'Entry on reversal candle after sweep.', 'Target opposite pool or 1:2 R:R.'),
  logic('pa-breakout-retest', 'Breakout & Retest', 'Break level then retest as S/R.', ['breakout', 'trending_bull', 'trending_bear'], ['day', 'medium_swing', 'swing', 'sniper'], 'Entry on retest hold; volume on break.', 'Target measured move; stop beyond retest.'),
  logic('pa-fakeout', 'Fakeout / Trap', 'False break then reverse; trap liquidity.', ['reversal_bull', 'reversal_bear', 'volatile'], ['scalping', 'day', 'sniper'], 'Entry on confirmation of trap (engulfing, close back).', 'Target opposite side; stop beyond trap.'),
  logic('pa-equal-highs-lows', 'Equal Highs / Equal Lows', 'Liquidity pools; break for continuation or reversal.', ['breakout', 'reversal_bull', 'reversal_bear'], S, 'Entry on break of equal highs/lows.', 'Target next pool or structure.'),
  logic('pa-fvg', 'Fair Value Gap (FVG)', 'Three candles; gap between 1 and 3; imbalance.', R, S, 'Entry on FVG fill or touch in trend.', 'Target next FVG or structure; stop beyond FVG.'),
  logic('pa-bos', 'Break of Structure (BOS)', 'Higher high / lower low in trend.', ['trending_bull', 'trending_bear'], S, 'Entry on BOS with pullback.', 'Target next BOS or liquidity.'),
  logic('pa-choch', 'Change of Character (CHoCH)', 'BOS against trend; potential reversal.', ['reversal_bull', 'reversal_bear'], S, 'Entry on CHoCH with confirmation.', 'Target prior structure.'),
  logic('pa-imb', 'Imbalance / Liquidity Void', 'Fast move leaving gap; often filled.', ['trending_bull', 'trending_bear', 'ranging'], S, 'Entry on fill of imbalance in trend.', 'Target next imbalance.'),
  logic('pa-mitigation-block', 'Mitigation Block', 'Last opposite candle before drop/rise; like OB.', R, S, 'Entry on retest of mitigation block.', 'Target next block.'),
  logic('pa-liquidity-pool', 'Liquidity Pool (Buy/Sell Side)', 'Clustered stops above/below; target for moves.', ['breakout', 'reversal_bull', 'reversal_bear'], S, 'Entry after liquidity grab or on break.', 'Target next pool.'),
  logic('pa-inducement', 'Inducement', 'Move to grab liquidity before real move.', ['reversal_bull', 'reversal_bear', 'breakout'], ['scalping', 'day', 'sniper'], 'Entry on reversal from inducement.', 'Target real structure.'),
  logic('pa-session-high-low', 'Session High/Low', 'London/NY open high and low; key levels.', ['ranging', 'breakout', 'trending_bull', 'trending_bear'], ['scalping', 'day', 'sniper'], 'Entry at session high/low with confirmation.', 'Target opposite or extension.'),
  logic('pa-opening-range', 'Opening Range Breakout', 'First N-minute range; break for direction.', ['breakout', 'volatile'], ['scalping', 'day'], 'Entry on break of OR high/low.', 'Target 1:1 or session extreme.'),
  logic('pa-poc', 'Point of Control (POC)', 'Highest volume price level; magnet.', ['ranging', 'trending_bull', 'trending_bear'], S, 'Entry at POC touch in trend.', 'Target next POC or value edge.'),
  logic('pa-value-area', 'Value Area High/Low', 'Volume profile value area; support/resistance.', ['ranging', 'breakout'], ['day', 'swing', 'sniper'], 'Entry at VAH/VAL with confirmation.', 'Target opposite or POC.'),
  logic('pa-hvn-lvn', 'HVN/LVN', 'High/low volume nodes; fast through LVN, slow at HVN.', R, S, 'Entry at HVN in trend or LVN break.', 'Target next node.'),
  logic('pa-p-shape', 'P-Shape Profile', 'Single peak; trend day.', ['trending_bull', 'trending_bear'], ['day', 'swing'], 'Entry in direction of P shape.', 'Target profile edge.'),
  logic('pa-b-shape', 'B-Shape Profile', 'Two peaks; balanced day.', ['ranging'], ['day'], 'Entry at value edges.', 'Target opposite edge.'),
  logic('pa-double-distribution', 'Double Distribution', 'Two value areas; trend then range.', ['trending_bull', 'trending_bear', 'ranging'], ['day', 'swing'], 'Entry at second distribution edge.', 'Target extension.'),
  logic('pa-auction-theory', 'Auction Theory', 'Price discovery; balance to imbalance.', R, S, 'Entry on imbalance in direction of auction.', 'Target balance or new imbalance.'),
  logic('pa-two-legged-pullback', 'Two-Legged Pullback', 'ABC pullback in trend; entry at C.', ['trending_bull', 'trending_bear'], S, 'Entry at C completion (Fib or OB).', 'Target prior extreme.'),
  logic('pa-three-legged', 'Three-Legged Move', 'Three swings; exhaustion or continuation.', ['reversal_bull', 'reversal_bear', 'trending_bull', 'trending_bear'], ['day', 'swing'], 'Entry at third leg completion.', 'Target first leg.'),
  logic('pa-swing-failure', 'Swing Failure', 'Break of swing then fail; SFL.', ['reversal_bull', 'reversal_bear'], ['scalping', 'day', 'sniper'], 'Entry on failure of break.', 'Target opposite swing.'),
  logic('pa-turtle-soup', 'Turtle Soup', 'Break of N-period high/low then reverse.', ['reversal_bull', 'reversal_bear'], ['day', 'sniper'], 'Entry on reversal after break.', 'Target prior extreme.'),
  logic('pa-confluence-zone', 'Confluence Zone', 'Multiple factors: Fib, OB, session level.', R, S, 'Entry when 2+ factors align.', 'Target next zone; stop beyond confluence.'),
  logic('pa-sr-flip', 'Support/Resistance Flip', 'Broken support becomes resistance and vice versa.', ['breakout', 'trending_bull', 'trending_bear'], S, 'Entry on retest of flipped level.', 'Target next level.'),
  logic('pa-touch-and-go', 'Touch and Go', 'Quick touch of level and rejection.', ['ranging', 'reversal_bull', 'reversal_bear'], ['scalping', 'day', 'sniper'], 'Entry on rejection candle.', 'Target opposite level.'),
  logic('pa-absorption', 'Absorption', 'Volume at level but no move; accumulation/distribution.', ['reversal_bull', 'reversal_bear', 'breakout'], ['day', 'swing'], 'Entry on break of absorption range.', 'Target next structure.'),
  logic('pa-stop-hunt', 'Stop Hunt', 'Clear stops then reverse; institutional.', ['reversal_bull', 'reversal_bear'], ['scalping', 'day', 'sniper'], 'Entry on reversal confirmation after hunt.', 'Target 1:2 or structure.'),
  logic('pa-momentum-shift', 'Momentum Shift', 'Volume and range expansion in new direction.', ['breakout', 'reversal_bull', 'reversal_bear'], S, 'Entry on first pullback after shift.', 'Target prior structure.'),
  logic('pa-range-expansion', 'Range Expansion', 'NR7 or narrow range then wide range bar.', ['breakout', 'volatile'], ['scalping', 'day', 'sniper'], 'Entry on break of expansion bar.', 'Target 1:1 or structure.'),
  logic('pa-tight-consolidation', 'Tight Consolidation Break', 'Small range then breakout.', ['breakout', 'consolidation'], S, 'Entry on close beyond consolidation.', 'Target measured move.'),
  logic('pa-wick-rejection', 'Wick Rejection', 'Long wick at level; rejection.', ['reversal_bull', 'reversal_bear', 'ranging'], S, 'Entry on break of body with level.', 'Target 1:1.5; stop beyond wick.'),
  logic('pa-close-beyond', 'Close Beyond Level', 'Close beyond key level; commitment.', ['breakout', 'trending_bull', 'trending_bear'], S, 'Entry on close beyond level; filter wicks.', 'Target next level.'),
  logic('pa-gap-fill', 'Gap Fill', 'Price returns to fill gap; continuation or reversal.', ['ranging', 'trending_bull', 'trending_bear', 'volatile'], ['scalping', 'day', 'sniper'], 'Entry at gap fill with confirmation.', 'Target opposite side of gap.'),
  logic('pa-run-and-gun', 'Run and Gun', 'Strong move, small pullback, continuation.', ['trending_bull', 'trending_bear', 'breakout'], ['scalping', 'day'], 'Entry on shallow pullback in trend.', 'Target extension.'),
  logic('pa-scalp-break', 'Scalp Break', 'Quick break of micro level; 1:1 target.', ['ranging', 'breakout'], ['scalping'], 'Entry on break; target 1:1; tight stop.', 'Exit at target or break.'),
  logic('pa-trendline-touch', 'Trendline Touch', 'Price touches trendline in trend.', ['trending_bull', 'trending_bear'], S, 'Entry at trendline with candle confirmation.', 'Target prior swing or next line.'),
  logic('pa-trendline-break', 'Trendline Break', 'Break of trendline; reversal or acceleration.', ['reversal_bull', 'reversal_bear', 'breakout'], S, 'Entry on break with close beyond.', 'Target next structure.'),
  logic('pa-channel-touch', 'Channel Touch', 'Price at channel boundary.', ['trending_bull', 'trending_bear', 'ranging'], S, 'Entry at channel line in trend.', 'Target opposite line.'),
  logic('pa-dynamic-sr', 'Dynamic S/R', 'Moving level (EMA, trendline); bounce or break.', ['trending_bull', 'trending_bear'], S, 'Entry at dynamic level with confirmation.', 'Target next level.'),
  logic('pa-swing-high-low', 'Swing High/Low', 'Relevant swing points; break or hold.', R, S, 'Entry on break of swing or hold at swing.', 'Target next swing.'),
  logic('pa-higher-high-higher-low', 'HH/HL Structure', 'Uptrend structure; buy pullbacks to HL.', ['trending_bull'], S, 'Entry at HL with confirmation.', 'Target next HH.'),
  logic('pa-lower-high-lower-low', 'LH/LL Structure', 'Downtrend structure; sell pullbacks to LH.', ['trending_bear'], S, 'Entry at LH with confirmation.', 'Target next LL.'),
  logic('pa-structure-break', 'Structure Break', 'Break of HH/HL or LH/LL; trend change.', ['reversal_bull', 'reversal_bear'], S, 'Entry on structure break with confirmation.', 'Target prior structure.'),
  logic('pa-multi-tf-alignment', 'Multi-Timeframe Alignment', 'Same direction on HTF and LTF.', R, S, 'Entry when HTF and LTF align.', 'Target HTF level.'),
  logic('pa-htf-bias', 'HTF Bias', 'Trade only in direction of higher timeframe.', ['trending_bull', 'trending_bear'], S, 'Entry on LTF signal in HTF direction.', 'Target HTF structure.'),
  logic('pa-ltf-trigger', 'LTF Trigger', 'HTF level; LTF pattern for entry.', R, S, 'Entry on LTF trigger at HTF level.', 'Target HTF target.'),
  logic('pa-session-overlap', 'Session Overlap', 'London-NY overlap; volatility and direction.', ['breakout', 'volatile'], ['scalping', 'day'], 'Entry in overlap with structure.', 'Target session extreme.'),
  logic('pa-asian-range', 'Asian Range', 'Asian session range; break or fade.', ['ranging', 'breakout'], ['scalping', 'day'], 'Entry on break of Asian range.', 'Target 1:1 or session level.'),
  logic('pa-news-spike', 'News Spike Fade', 'Spike on news then mean reversion.', ['volatile', 'reversal_bull', 'reversal_bear'], ['scalping', 'day'], 'Entry on rejection of spike (with care).', 'Target pre-news level.'),
  logic('pa-exhaustion', 'Exhaustion Move', 'Climactic volume and range; reversal.', ['reversal_bull', 'reversal_bear'], ['day', 'swing'], 'Entry on exhaustion candle and reversal.', 'Target prior structure.'),
  logic('pa-capitulation', 'Capitulation', 'Panic sell/buy then reversal.', ['reversal_bull', 'reversal_bear', 'volatile'], ['day', 'swing'], 'Entry on reversal from capitulation.', 'Target measured move.'),
  logic('pa-squeeze-momentum', 'Squeeze Momentum', 'Bollinger inside Keltner; then momentum burst.', ['breakout', 'consolidation'], ['scalping', 'day', 'sniper'], 'Entry on first bar after squeeze.', 'Target 1:1 or trail.'),
  logic('pa-custom-combo', 'Custom Combo', 'User-defined mix of structure, OB, Fib, session.', R, S, 'Entry per combo rules.', 'Target and stop per combo.'),
];
