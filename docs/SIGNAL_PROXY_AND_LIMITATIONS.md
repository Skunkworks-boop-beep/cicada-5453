# Signal Proxy and Limitations

## Full Implementations (No Proxy)

The following now have dedicated signal logic and indicators:

| Category | Strategies | Implementation |
|----------|------------|-----------------|
| **VWAP** | `ind-vwap`, `ind-vwap-bands`, `ind-vwap-anchor` | Cumulative VWAP, VWAP bands; `signalVwap`, `signalVwapBands` |
| **Volume oscillators** | `ind-cmf`, `ind-cmo`, `ind-tsi`, `ind-ultimate-osc` | CMF, CMO, TSI, Ultimate Oscillator; full indicator + signal |
| **Volume-based** | `ind-obv-div`, `ind-obv-breakout`, `ind-force-index`, `ind-eom`, `ind-vpt` | OBV, Force Index, EOM, VPT; full implementations |
| **Chart patterns** | H&S, Inverse H&S, Cup, Inverse Cup, Broadening, Wedges, Diamond | `detectHeadAndShoulders`, `detectCupAndHandle`, etc.; `signalChartPattern` runs all before structure fallback |
| **Coppock, NVI/PVI, A/D** | `ind-coppock`, `ind-nvi-pvi`, `ind-accumulation` | Coppock (ROC14+ROC11, SMA); NVI/PVI; Accumulation/Distribution |
| **Pivots** | `ind-pivot-points`, `ind-camarilla`, `ind-fib-pivot` | Classic, Camarilla, Fibonacci pivots; touch levels |
| **ZigZag, Fractals** | `ind-zigzag`, `ind-fractals` | ZigZag swing levels; Bill Williams Fractals |

## Structure Fallback (Intentional)

Many `pa-*` and `cp-*` strategies use `signalStructure` as a shared implementation. Structure is a broad concept (trend continuation, breakout, Donchian, BB reversion); individual strategies may need distinct logic for full fidelity.

Examples: `pa-trendline-touch`, `pa-confluence-zone`, `pa-value-area`, `cp-channel-up`, `cp-harmonic-gartley`, `cp-elliott-impulse`, etc.

## Category Defaults

- **cs-*** (unmapped) → `signalCandlestick` (engulfing, hammer, doji, pin bar)
- **cp-*** (unmapped) → `signalChartPattern` (H&S, cup, double top/bottom, then structure)
- **pa-*** (unmapped) → `signalStructure`
- **ind-*** (unmapped) → `signalRsi`
