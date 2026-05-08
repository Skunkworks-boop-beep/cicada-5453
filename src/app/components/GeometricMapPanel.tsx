/**
 * Stage 2B — read-only geometric map panel (spec phase 2 surface).
 *
 * Shows the persisted geometric map for the currently selected instrument
 * as a vertical price ladder of S/R bands, volume nodes, and fractal
 * swings. Polls /map/geometric/{symbol} every 30s and degrades silently
 * when the endpoint 404s — the map is built once from full history, so
 * an empty state is the correct demo / first-run experience.
 *
 * Visual contract (do not violate):
 *   - palette: #00ff00, #ff6600, #ffff00 only (alpha variants OK)
 *   - typography: text-[10px] rows, text-xs labels, no oversized text
 *   - reuse RetroBox, the corner-bracket box pattern, JetBrains Mono
 */
import { useEffect, useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { RetroBox } from './RetroBox';
import { getGeometricMap, type GeometricMap } from '../core/api';
import { useTradingStore } from '../store/TradingStore';

const POLL_MS = 30_000;
const MAX_LEVELS_PER_KIND = 5;
const MAX_VOLUME_NODES = 6;

export function GeometricMapPanel() {
  const { state } = useTradingStore();
  const { instruments } = state;
  const activeInstruments = instruments.filter((i) => i.status === 'active');
  const selectedInstrument = instruments.find((i) => i.selected) ?? activeInstruments[0] ?? null;
  const symbol = selectedInstrument?.symbol ?? '';

  const [map, setMap] = useState<GeometricMap | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setMap(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const next = await getGeometricMap(symbol);
      if (!cancelled) {
        setMap(next);
        setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  const ladder = useMemo(() => buildLadder(map), [map]);

  return (
    <RetroBox title="GEOMETRIC MAP" icon={<Layers className="w-3 h-3 text-[#00ff00]" />}>
      <div className="flex items-center justify-between text-[10px] mb-2 text-[#00ff00]/80">
        <span>
          SYM <span className="text-[#ff6600]">{symbol || '—'}</span>
        </span>
        <span>
          BARS <span className="text-[#00ff00]">{map?.meta.n_bars ?? 0}</span>
        </span>
        <span>
          ATR <span className="text-[#00ff00]">{formatAtr(map?.meta.atr_at_build)}</span>
        </span>
        <span className="text-[#00ff00]/50">{loading ? 'SYNC' : 'IDLE'}</span>
      </div>

      {!symbol ? (
        <div className="text-[10px] text-[#00ff00]/50 py-2 tracking-wider">[ NO INSTRUMENT SELECTED ]</div>
      ) : !map ? (
        <div className="text-[10px] text-[#ff6600]/80 py-2 tracking-wider">
          [ NO MAP — RUN BUILD ]
        </div>
      ) : (
        <div className="space-y-2">
          <Section title="RESISTANCE">
            {map.resistance_levels.slice(0, MAX_LEVELS_PER_KIND).map((l, idx) => (
              <Row
                key={`r-${idx}`}
                left={l.price.toFixed(5)}
                middle={`x${l.confirmations}`}
                right={l.score.toFixed(2)}
                accent="resistance"
              />
            ))}
            {map.resistance_levels.length === 0 && <Empty />}
          </Section>

          <Section title="VOLUME NODES">
            {map.volume_nodes.slice(0, MAX_VOLUME_NODES).map((n, idx) => (
              <Row key={`v-${idx}`} left={n.price.toFixed(5)} right={n.score.toFixed(2)} accent="volume" />
            ))}
            {map.volume_nodes.length === 0 && <Empty />}
          </Section>

          <Section title="SUPPORT">
            {map.support_levels.slice(0, MAX_LEVELS_PER_KIND).map((l, idx) => (
              <Row
                key={`s-${idx}`}
                left={l.price.toFixed(5)}
                middle={`x${l.confirmations}`}
                right={l.score.toFixed(2)}
                accent="support"
              />
            ))}
            {map.support_levels.length === 0 && <Empty />}
          </Section>

          <Section title="SWINGS">
            <Row
              left={`HIGHS ${map.swing_highs.length}`}
              right={`LOWS ${map.swing_lows.length}`}
              accent="swing"
            />
          </Section>
        </div>
      )}
    </RetroBox>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-[#00ff00]/70 border-b border-[#00ff00]/30 pb-0.5 mb-1">
        [ {title} ]
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({
  left,
  middle,
  right,
  accent,
}: {
  left: string;
  middle?: string;
  right: string;
  accent: 'resistance' | 'support' | 'volume' | 'swing';
}) {
  const colour =
    accent === 'resistance'
      ? 'text-[#ff6600]'
      : accent === 'support'
      ? 'text-[#00ff00]'
      : accent === 'volume'
      ? 'text-[#ffff00]'
      : 'text-[#00ff00]/80';
  return (
    <div className="grid grid-cols-3 text-[10px] font-mono">
      <span className={colour}>{left}</span>
      <span className="text-center text-[#00ff00]/60">{middle ?? ''}</span>
      <span className="text-right text-[#00ff00]/80">{right}</span>
    </div>
  );
}

function Empty() {
  return <div className="text-[10px] text-[#00ff00]/30">—</div>;
}

function formatAtr(atr: number | undefined): string {
  if (atr === undefined || atr === null) return '—';
  if (atr === 0) return '0';
  return atr.toFixed(5);
}

function buildLadder(map: GeometricMap | null): null {
  // Reserved hook for a future ascii price-ladder rendering. The Stage 2B
  // surface keeps the layout grouped by kind (resistance / volume /
  // support / swings) — this matches the operator's reading order.
  if (!map) return null;
  return null;
}
