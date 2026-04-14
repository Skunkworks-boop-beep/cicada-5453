/**
 * Chart patterns registry — 45+ patterns with entry/exit logic.
 */
import type { ChartPatternDef, MarketRegime, TradeStyle } from '../types';

const R: MarketRegime[] = ['reversal_bear', 'reversal_bull', 'trending_bull', 'trending_bear', 'ranging', 'breakout', 'consolidation', 'volatile', 'unknown'];
const S: TradeStyle[] = ['scalping', 'day', 'medium_swing', 'swing', 'sniper'];

function chart(
  id: string,
  name: string,
  logic: string,
  regimes: MarketRegime[],
  styles: TradeStyle[],
  entryLogic: string,
  exitLogic: string,
  enabled = true
): ChartPatternDef {
  return {
    id,
    name,
    category: 'pattern',
    logic,
    regimes,
    styles,
    enabled,
    entryLogic,
    exitLogic,
  };
}

export const CHART_PATTERNS: ChartPatternDef[] = [
  chart('cp-head-shoulders', 'Head & Shoulders', 'Classic reversal: left shoulder, higher head, right shoulder. Volume decline on right shoulder.', ['reversal_bear', 'reversal_bull', 'trending_bull', 'trending_bear'], ['swing', 'medium_swing', 'day', 'sniper'], 'Entry on break of neckline with volume confirmation.', 'Target = measured move; stop above right shoulder.'),
  chart('cp-inverse-h-s', 'Inverse Head & Shoulders', 'Bullish reversal: left shoulder, lower head, right shoulder.', ['reversal_bull', 'trending_bear', 'ranging'], ['swing', 'medium_swing', 'day', 'sniper'], 'Entry on break above neckline with volume.', 'Target = measured move up; stop below right shoulder.'),
  chart('cp-double-top', 'Double Top', 'Two similar highs, failure to break; bearish reversal.', ['reversal_bear', 'ranging', 'breakout'], ['swing', 'medium_swing', 'day', 'scalping', 'sniper'], 'Entry on break below neckline; volume spike preferred.', 'Target = distance from peaks to neckline projected down.'),
  chart('cp-double-bottom', 'Double Bottom', 'Two similar lows, failure to break; bullish reversal.', ['reversal_bull', 'ranging', 'breakout'], ['swing', 'medium_swing', 'day', 'scalping', 'sniper'], 'Entry on break above neckline.', 'Target = distance from troughs to neckline projected up.'),
  chart('cp-triangle-sym', 'Symmetrical Triangle', 'Converging trendlines; breakout direction determines trade.', ['consolidation', 'breakout', 'ranging'], ['day', 'medium_swing', 'swing', 'sniper'], 'Entry on close beyond triangle boundary with volume.', 'Target = height at widest point projected; stop opposite side.'),
  chart('cp-triangle-asc', 'Ascending Triangle', 'Flat top, rising lows; bullish bias.', ['trending_bull', 'breakout', 'consolidation'], ['day', 'medium_swing', 'swing', 'sniper'], 'Entry on breakout above horizontal resistance.', 'Target = triangle height up; stop below rising trendline.'),
  chart('cp-triangle-desc', 'Descending Triangle', 'Flat bottom, lower highs; bearish bias.', ['trending_bear', 'breakout', 'reversal_bear'], ['day', 'medium_swing', 'swing', 'sniper'], 'Entry on breakdown below horizontal support.', 'Target = triangle height down; stop above descending trendline.'),
  chart('cp-flag-bull', 'Bull Flag', 'Short consolidation after strong up move; continuation.', ['trending_bull', 'breakout'], ['scalping', 'day', 'sniper'], 'Entry on break of flag upper boundary.', 'Target = pole length projected up; stop below flag.'),
  chart('cp-flag-bear', 'Bear Flag', 'Short consolidation after strong down move; continuation.', ['trending_bear', 'breakout'], ['scalping', 'day', 'sniper'], 'Entry on break of flag lower boundary.', 'Target = pole length projected down.'),
  chart('cp-pennant', 'Pennant', 'Small symmetrical triangle after strong move; continuation.', ['trending_bull', 'trending_bear', 'breakout'], ['scalping', 'day', 'sniper'], 'Entry on break of pennant in trend direction.', 'Target = pole length; stop beyond pennant.'),
  chart('cp-wedge-rising', 'Rising Wedge', 'Converging uptrend lines; often bearish reversal.', ['reversal_bear', 'consolidation'], ['day', 'medium_swing', 'swing'], 'Entry on breakdown from wedge.', 'Target = wedge height or prior support; stop above wedge.'),
  chart('cp-wedge-falling', 'Falling Wedge', 'Converging downtrend lines; often bullish reversal.', ['reversal_bull', 'consolidation'], ['day', 'medium_swing', 'swing'], 'Entry on breakout above wedge.', 'Target = wedge height or prior resistance.'),
  chart('cp-fib-retracement', 'Fibonacci Retracement', 'Retracements to 38.2%, 50%, 61.8% in trend.', ['trending_bull', 'trending_bear', 'ranging'], S, 'Entry at Fib level with candlestick or structure confirmation.', 'Target next Fib extension or prior high/low; stop beyond 78.6%.'),
  chart('cp-fib-extension', 'Fibonacci Extension', 'Extensions 127.2%, 161.8% for targets.', ['trending_bull', 'trending_bear', 'breakout'], ['day', 'medium_swing', 'swing', 'sniper'], 'Entry on pullback in trend; target at extension level.', 'Exit at extension or structure.'),
  chart('cp-channel-up', 'Ascending Channel', 'Price in rising parallel channel; trade bounces or breakout.', ['trending_bull', 'ranging'], S, 'Entry on touch of lower channel line or breakout above.', 'Target upper line or channel break.'),
  chart('cp-channel-down', 'Descending Channel', 'Price in falling parallel channel.', ['trending_bear', 'ranging'], S, 'Entry on touch of upper channel line or breakdown.', 'Target lower line or channel break.'),
  chart('cp-rectangle', 'Rectangle (Range)', 'Horizontal support and resistance; breakout or range trade.', ['ranging', 'breakout', 'consolidation'], S, 'Entry on break of range or bounce at boundary.', 'Target opposite side or measured move.'),
  chart('cp-cup-handle', 'Cup and Handle', 'U-shaped base (cup) then small pullback (handle); bullish.', ['reversal_bull', 'trending_bull', 'breakout'], ['day', 'medium_swing', 'swing', 'sniper'], 'Entry on break above handle resistance.', 'Target = cup depth projected from handle.'),
  chart('cp-inverse-cup', 'Inverse Cup and Handle', 'Inverted U then small rally; bearish.', ['reversal_bear', 'trending_bear'], ['day', 'medium_swing', 'swing'], 'Entry on break below handle support.', 'Target = cup depth projected down.'),
  chart('cp-broadening', 'Broadening Formation', 'Expanding range; high volatility reversal or breakout.', ['volatile', 'reversal_bull', 'reversal_bear'], ['day', 'swing'], 'Entry on break of formation with volume.', 'Wide stop; target prior swing.'),
  chart('cp-diamond', 'Diamond Top/Bottom', 'Rare; expansion then contraction; reversal.', ['reversal_bull', 'reversal_bear'], ['swing', 'medium_swing'], 'Entry on break of diamond boundary.', 'Target = height of formation.'),
  chart('cp-rounding-bottom', 'Rounding Bottom (Saucer)', 'Gradual bottom formation; bullish.', ['reversal_bull', 'ranging'], ['medium_swing', 'swing'], 'Entry on break above resistance of saucer.', 'Target = depth of saucer projected.'),
  chart('cp-rounding-top', 'Rounding Top', 'Gradual top formation; bearish.', ['reversal_bear', 'ranging'], ['medium_swing', 'swing'], 'Entry on break below support.', 'Target = depth of rounding.'),
  chart('cp-gap-up', 'Gap Up Breakout', 'Price gaps above resistance; continuation or exhaustion.', ['breakout', 'trending_bull', 'volatile'], ['scalping', 'day', 'sniper'], 'Entry on gap open or pullback to gap edge.', 'Target prior resistance or fill.'),
  chart('cp-gap-down', 'Gap Down Breakdown', 'Price gaps below support.', ['breakout', 'trending_bear', 'volatile'], ['scalping', 'day', 'sniper'], 'Entry on gap open or pullback to gap edge.', 'Target prior support or fill.'),
  chart('cp-ascending-broadening', 'Ascending Broadening Wedge', 'Rising wedge with expanding range.', ['volatile', 'reversal_bear'], ['day', 'swing'], 'Entry on breakdown.', 'Target lower boundary or structure.'),
  chart('cp-descending-broadening', 'Descending Broadening Wedge', 'Falling wedge with expanding range.', ['volatile', 'reversal_bull'], ['day', 'swing'], 'Entry on breakout.', 'Target upper boundary.'),
  chart('cp-triple-top', 'Triple Top', 'Three similar highs; strong resistance.', ['reversal_bear', 'ranging'], ['swing', 'medium_swing', 'day'], 'Entry on break below support.', 'Target = range height projected down.'),
  chart('cp-triple-bottom', 'Triple Bottom', 'Three similar lows; strong support.', ['reversal_bull', 'ranging'], ['swing', 'medium_swing', 'day'], 'Entry on break above resistance.', 'Target = range height projected up.'),
  chart('cp-bump-run', 'Bump and Run Reversal', 'Parabolic move then sharp reversal.', ['reversal_bear', 'reversal_bull', 'volatile'], ['day', 'swing'], 'Entry on break of trendline after bump.', 'Target prior consolidation.'),
  chart('cp-fan-lines', 'Fan Lines', 'Multiple trendlines from one point; break of third often reversal.', ['reversal_bull', 'reversal_bear'], ['day', 'medium_swing', 'swing'], 'Entry on break of third fan line.', 'Target next line or structure.'),
  chart('cp-speed-lines', 'Speed Resistance Lines', 'Lines from high/low at 1/3 and 2/3; support/resistance.', ['trending_bull', 'trending_bear', 'ranging'], ['day', 'swing', 'sniper'], 'Entry at line touch with confirmation.', 'Target next line.'),
  chart('cp-gann-square', 'Gann Square of 9', 'Price and time symmetry; key levels.', ['ranging', 'breakout', 'trending_bull', 'trending_bear'], ['day', 'swing', 'sniper'], 'Entry at Gann level with structure.', 'Target next Gann level.'),
  chart('cp-andrews-pitchfork', 'Andrews Pitchfork', 'Three parallel lines from pivot; median line trades.', ['trending_bull', 'trending_bear', 'ranging'], S, 'Entry on touch of median or fork line.', 'Target opposite line.'),
  chart('cp-schiff-pitchfork', 'Schiff Pitchfork', 'Variant of Andrews; different pivot selection.', ['trending_bull', 'trending_bear'], ['day', 'medium_swing', 'swing'], 'Entry at median line touch.', 'Target fork boundary.'),
  chart('cp-wolfe-waves', 'Wolfe Waves', 'Five-point pattern; price and time symmetry.', ['reversal_bull', 'reversal_bear', 'ranging'], ['day', 'swing', 'sniper'], 'Entry at point 5 with reversal candle.', 'Target line from 1–4.'),
  chart('cp-harmonic-gartley', 'Gartley Pattern', 'XABCD harmonic; 0.618 retrace, 0.786 extension.', ['reversal_bull', 'reversal_bear', 'ranging'], ['day', 'swing', 'sniper'], 'Entry at D with confirmation.', 'Target A or extension.'),
  chart('cp-harmonic-bat', 'Bat Pattern', 'Harmonic; shallow retrace at B, 0.886 XA.', ['reversal_bull', 'reversal_bear'], ['day', 'swing', 'sniper'], 'Entry at D (0.886 of XA).', 'Target 0.382 or 0.618 retrace.'),
  chart('cp-harmonic-butterfly', 'Butterfly Pattern', 'Deep retrace at B; 0.786 XA.', ['reversal_bull', 'reversal_bear'], ['day', 'swing'], 'Entry at D (1.27 or 1.618 extension).', 'Target 0.786 retrace.'),
  chart('cp-harmonic-crab', 'Crab Pattern', 'Extreme extension; 1.618 XA.', ['reversal_bull', 'reversal_bear'], ['day', 'swing', 'sniper'], 'Entry at D (1.618); tight stop.', 'Target 0.382 or 0.618.'),
  chart('cp-harmonic-shark', 'Shark Pattern', 'Alternate harmonic; 0.886 OA, 1.41–2.24 extension.', ['reversal_bull', 'reversal_bear'], ['day', 'swing'], 'Entry at D with confirmation.', 'Target O or 0.5 retrace.'),
  chart('cp-cypher', 'Cypher Pattern', 'Complex harmonic; 0.382 XA, 0.786 BC.', ['ranging', 'reversal_bull', 'reversal_bear'], ['day', 'sniper'], 'Entry at D (0.786 of XC).', 'Target 0.382 or 0.786.'),
  chart('cp-three-drives', 'Three Drives', 'Three equal legs; 127% or 161.8% extension.', ['reversal_bull', 'reversal_bear'], ['day', 'medium_swing', 'swing'], 'Entry at third drive completion.', 'Target first drive start.'),
  chart('cp-elliott-impulse', 'Elliott Impulse Wave', 'Five-wave motive; trade wave 3 or 5 extension.', ['trending_bull', 'trending_bear'], ['day', 'swing'], 'Entry at end of wave 2 pullback.', 'Target wave 3 high/low.'),
  chart('cp-elliott-abc', 'Elliott ABC Correction', 'Three-wave correction; trade C completion.', ['reversal_bull', 'reversal_bear', 'ranging'], ['day', 'swing', 'sniper'], 'Entry at C = 0.618 or 1.0 of A.', 'Target start of correction.'),
  chart('cp-rising-window', 'Rising Three Methods', 'Bullish continuation; gap up then three small down candles.', ['trending_bull', 'breakout'], ['day', 'scalping'], 'Entry on break above first candle.', 'Target prior high or ATR.'),
  chart('cp-falling-window', 'Falling Three Methods', 'Bearish continuation; gap down then three small up.', ['trending_bear', 'breakout'], ['day', 'scalping'], 'Entry on break below first candle.', 'Target prior low.'),
  chart('cp-tweezer-tops', 'Tweezer Tops', 'Two candles with same high; bearish reversal.', ['reversal_bear', 'ranging'], ['scalping', 'day', 'sniper'], 'Entry on break below tweezer low.', 'Target next support.'),
  chart('cp-tweezer-bottoms', 'Tweezer Bottoms', 'Two candles with same low; bullish reversal.', ['reversal_bull', 'ranging'], ['scalping', 'day', 'sniper'], 'Entry on break above tweezer high.', 'Target next resistance.'),
  chart('cp-island-reversal', 'Island Reversal', 'Gap, trade, gap opposite; strong reversal.', ['reversal_bull', 'reversal_bear', 'volatile'], ['day', 'swing'], 'Entry on break of island range.', 'Target gap fill or structure.'),
  chart('cp-key-reversal', 'Key Reversal Day', 'New high then close below prior close; bearish.', ['reversal_bear', 'trending_bull'], ['day', 'swing'], 'Entry on next candle confirmation.', 'Target prior support.'),
  chart('cp-inside-bar', 'Inside Bar (NR7)', 'Current range inside prior; breakout or mean reversion.', ['breakout', 'ranging', 'consolidation'], ['scalping', 'day', 'sniper'], 'Entry on break of mother bar.', 'Target 1:1 or structure.'),
  chart('cp-outside-bar', 'Outside Bar', 'Range engulfs prior; momentum or reversal.', ['breakout', 'volatile', 'reversal_bull', 'reversal_bear'], ['scalping', 'day', 'sniper'], 'Entry in direction of close with filter.', 'Target 1:1 or prior swing.'),
];
