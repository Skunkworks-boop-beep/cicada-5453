/**
 * Beehive structural visualiser — Section 11 of the spec.
 *
 * Strict green-only palette (#020d02 → #1aff1a). Canvas with a
 * requestAnimationFrame loop targeting 60fps. Cells map 1:1 to price
 * points loaded from /map/geometric/{symbol}. HUD (stats + price ticker
 * + event log + terminal) is rendered as DOM overlays for accessibility
 * and copy-paste — keeps the canvas focused on the live map.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGeometricMap, type GeometricMap as GeometricMapData } from '../../core/api';
import {
  type Cell,
  type Pulse,
  PALETTE,
  HEX_R,
  HEX_W,
  HEX_H,
  buildGrid,
  cellLabel,
  strengthToFill,
  fireProgressFill,
  cascadeProbability,
  newPulse,
  MAX_PULSE_DEPTH,
  FIRE_DURATION_TICKS,
} from './cellModel';
import { dispatch, type BeehiveWorld } from './commands';

interface LogEntry {
  tick: number;
  message: string;
}

const HOVER_THROTTLE_MS = 40;
const SPONT_FIRE_TICKS = 70;
const SPONT_LEVEL_FIRE_TICKS = 200;
const SPONT_PRICE_UPDATE_TICKS = 12;
const SPONT_STATS_UPDATE_TICKS = 20;
const LOG_MAX_LINES = 6;

interface BeehiveProps {
  /** When set, the component fetches /map/geometric/{symbol} and seeds
   *  cells with real S/R nodes, volume nodes, fractal swings. When null,
   *  the hive renders empty (idle breathing only). */
  symbol: string | null;
}

interface HoverProbe {
  cellIdx: number;
  x: number;
  y: number;
}

export function Beehive({ symbol }: BeehiveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  // World state lives in a ref so the RAF loop can mutate without rerendering.
  const worldRef = useRef<{
    cells: Cell[];
    pulses: Pulse[];
    tick: number;
    width: number;
    height: number;
    /** Synthetic price line — drifts up and down each tick. Replaced by
     *  real price data when wired to the daemon's /events stream. */
    price: number;
    priceMin: number;
    priceMax: number;
  }>({
    cells: [],
    pulses: [],
    tick: 0,
    width: 0,
    height: 0,
    price: 1.0,
    priceMin: 0.95,
    priceMax: 1.05,
  });

  const [log, setLog] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState({ nodes: 0, active: 0, pulses: 0, fakeout: 0, energy: 0 });
  const [hover, setHover] = useState<HoverProbe | null>(null);
  const [cmdInput, setCmdInput] = useState('');
  const [mapMeta, setMapMeta] = useState<{ symbol: string; nBars: number; sha: string } | null>(null);

  // ── Append to log ───────────────────────────────────────────────────

  const pushLog = useCallback((message: string) => {
    setLog((prev) => {
      const tick = worldRef.current.tick;
      const next = [...prev, { tick, message }];
      return next.length > LOG_MAX_LINES ? next.slice(-LOG_MAX_LINES) : next;
    });
  }, []);

  // ── Build / rebuild grid when size or symbol changes ────────────────

  const rebuildGrid = useCallback((data: GeometricMapData | null) => {
    const w = worldRef.current.width;
    const h = worldRef.current.height;
    if (w <= 0 || h <= 0) return;

    let nodes: Array<{ price: number; type: 'support' | 'resistance' | 'volume' | 'fractal'; strength: number; touches?: number }> = [];
    let priceMin: number | undefined;
    let priceMax: number | undefined;

    if (data) {
      const allLevels = [
        ...data.support_levels.map((s) => ({ price: s.price, type: 'support' as const, strength: s.strength, touches: s.touches })),
        ...data.resistance_levels.map((s) => ({ price: s.price, type: 'resistance' as const, strength: s.strength, touches: s.touches })),
        ...data.volume_nodes.map((v) => ({ price: v.price, type: 'volume' as const, strength: v.strength })),
        ...data.swing_highs.map((s) => ({ price: s.price, type: 'fractal' as const, strength: 0.6 })),
        ...data.swing_lows.map((s) => ({ price: s.price, type: 'fractal' as const, strength: 0.6 })),
      ];
      const prices = allLevels.map((n) => n.price).filter((p) => Number.isFinite(p));
      if (prices.length >= 2) {
        const lo = Math.min(...prices);
        const hi = Math.max(...prices);
        const pad = (hi - lo) * 0.15;
        priceMin = lo - pad;
        priceMax = hi + pad;
        nodes = allLevels;
      }
    }

    worldRef.current.cells = buildGrid({
      width: w, height: h, nodes, priceMin, priceMax,
    });
    if (priceMin != null && priceMax != null) {
      worldRef.current.priceMin = priceMin;
      worldRef.current.priceMax = priceMax;
      worldRef.current.price = (priceMin + priceMax) / 2;
    }
    worldRef.current.pulses = [];
  }, []);

  // ── Fetch geometric map on mount / symbol change ────────────────────

  useEffect(() => {
    let cancelled = false;
    if (!symbol) {
      setMapMeta(null);
      rebuildGrid(null);
      return;
    }
    getGeometricMap(symbol).then((data) => {
      if (cancelled) return;
      if (data) {
        setMapMeta({
          symbol: data.symbol,
          nBars: data.meta?.n_bars ?? 0,
          sha: (data.meta?.input_sha ?? '').slice(0, 8),
        });
        rebuildGrid(data);
        pushLog(`MAP LOADED · ${data.symbol} · ${data.meta?.n_bars ?? 0} BARS · SHA ${(data.meta?.input_sha ?? '').slice(0, 8)}`);
      } else {
        setMapMeta(null);
        rebuildGrid(null);
        pushLog(`NO MAP FOR ${symbol} · RUN BUILD FIRST`);
      }
    });
    return () => { cancelled = true; };
  }, [symbol, rebuildGrid, pushLog]);

  // ── Resize handling ─────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const onResize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = Math.max(64, Math.floor(rect.width));
      canvas.height = Math.max(64, Math.floor(rect.height));
      worldRef.current.width = canvas.width;
      worldRef.current.height = canvas.height;
      rebuildGrid(null);  // will be repopulated on next /map fetch
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [rebuildGrid]);

  // ── Render loop ─────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tickWorld = () => {
      const w = worldRef.current;
      w.tick += 1;
      const tick = w.tick;

      // ── Spontaneous behaviour ─────────────────────────────────────
      if (tick % SPONT_FIRE_TICKS === 0 && w.cells.length > 0) {
        const candidates: number[] = [];
        for (let i = 0; i < w.cells.length; i++) {
          const c = w.cells[i]!;
          if (c.active && c.type !== 'neutral') candidates.push(i);
        }
        if (candidates.length > 0) {
          const idx = candidates[Math.floor(Math.random() * candidates.length)]!;
          const c = w.cells[idx]!;
          c.fireTime = tick;
          for (const n of c.neighbors) {
            w.pulses.push(newPulse(idx, n, 0));
          }
        }
      }
      if (tick % SPONT_LEVEL_FIRE_TICKS === 0 && w.cells.length > 0) {
        const level = Math.floor(Math.random() * 8);
        for (let i = 0; i < w.cells.length; i++) {
          const c = w.cells[i]!;
          if (c.active && c.level === level && Math.random() < 0.5) {
            c.fireTime = tick;
          }
        }
      }
      if (tick % SPONT_PRICE_UPDATE_TICKS === 0) {
        const drift = (Math.random() - 0.5) * 0.001;
        const meanRev = (((w.priceMin + w.priceMax) / 2) - w.price) * 0.02;
        w.price = Math.min(w.priceMax, Math.max(w.priceMin, w.price + drift + meanRev));
      }
      if (tick % SPONT_STATS_UPDATE_TICKS === 0) {
        let active = 0, fakeout = 0;
        for (const c of w.cells) {
          if (c.active) {
            if (tick - c.fireTime < FIRE_DURATION_TICKS) active += 1;
            if (c.fakeout) fakeout += 1;
          }
        }
        const nodes = w.cells.filter((c) => c.active).length;
        const pulseCount = w.pulses.length;
        setStats({
          nodes,
          active,
          pulses: pulseCount,
          fakeout,
          energy: Number((pulseCount * 1.8 + active * 0.9).toFixed(2)),
        });
      }

      // Auto-clear fakeout state.
      for (const c of w.cells) {
        if (c.fakeout && tick >= c.fakeoutClearTick) {
          c.fakeout = false;
        }
        c.pulse += c.pulseSpd;
      }

      // Advance pulses; on arrival, probabilistically fire the destination.
      const survivors: Pulse[] = [];
      for (const p of w.pulses) {
        p.progress += p.speed;
        if (p.progress >= 1) {
          if (p.depth < MAX_PULSE_DEPTH) {
            const dst = w.cells[p.toIdx];
            if (dst) {
              const prob = cascadeProbability(dst.strength);
              if (Math.random() < prob) {
                dst.fireTime = tick;
                for (const n of dst.neighbors) {
                  if (n === p.fromIdx) continue;
                  survivors.push(newPulse(p.toIdx, n, p.depth + 1));
                }
              }
            }
          }
        } else {
          survivors.push(p);
        }
      }
      w.pulses = survivors;
    };

    const draw = () => {
      tickWorld();
      const w = worldRef.current;
      const tick = w.tick;
      const W = canvas.width;
      const H = canvas.height;

      // Motion-blur trail (Section 11 line 841).
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, W, H);

      // ── Cells ─────────────────────────────────────────────────────
      for (const c of w.cells) {
        const fireAge = tick - c.fireTime;
        const isFiring = fireAge >= 0 && fireAge < c.fireDur;
        const isScheduled = c.fireTime > tick;

        if (!c.active) {
          // INACTIVE neutral cell.
          drawHex(ctx, c.x, c.y, HEX_R, PALETTE.inactive, PALETTE.inactive);
          continue;
        }

        if (c.fakeout) {
          // FAKEOUT NODE: alternates active / borderDefault on pulse oscillator.
          const fillToggle = Math.sin(c.pulse * 2) >= 0 ? PALETTE.active : PALETTE.borderDefault;
          drawHex(ctx, c.x, c.y, HEX_R, fillToggle, PALETTE.active);
          // Outer dashed halo.
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = PALETTE.firing;
          ctx.lineWidth = 1;
          drawHexStroke(ctx, c.x, c.y, HEX_R + 4);
          ctx.restore();
        } else if (isFiring) {
          // FIRING NODE: bright fill fading through the green ladder.
          const progress = fireAge / c.fireDur;
          drawHex(ctx, c.x, c.y, HEX_R, fireProgressFill(progress), PALETTE.firing);
          // Outer glow ring.
          ctx.save();
          ctx.strokeStyle = PALETTE.firing;
          ctx.lineWidth = 1;
          drawHexStroke(ctx, c.x, c.y, HEX_R + 3);
          ctx.restore();
        } else if (isScheduled) {
          // Scheduled storm-burst cell — render as IDLE NODE until ignition.
          drawHex(ctx, c.x, c.y, HEX_R, strengthToFill(c.strength, c.pulse), PALETTE.borderDefault);
        } else {
          // IDLE NODE: brightness scales with strength + breathing oscillator.
          drawHex(ctx, c.x, c.y, HEX_R, strengthToFill(c.strength, c.pulse), PALETTE.borderDefault);
        }

        // Cell label (S/R/V/F).
        const label = cellLabel(c.type);
        if (label) {
          ctx.fillStyle = isFiring ? PALETTE.firing : PALETTE.labelDefault;
          ctx.font = `${isFiring ? 8 : 7}px "JetBrains Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, c.x, c.y);
        }
      }

      // ── Pulses ────────────────────────────────────────────────────
      for (const p of w.pulses) {
        const from = w.cells[p.fromIdx];
        const to = w.cells[p.toIdx];
        if (!from || !to) continue;
        const x = from.x + (to.x - from.x) * p.progress;
        const y = from.y + (to.y - from.y) * p.progress;
        const trailProgress = Math.max(0, p.progress - 0.15);
        const tx = from.x + (to.x - from.x) * trailProgress;
        const ty = from.y + (to.y - from.y) * trailProgress;
        ctx.strokeStyle = PALETTE.nearFiring;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = PALETTE.firing;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Price line overlay (dashed horizontal) ────────────────────
      const py = H * (1 - (w.price - w.priceMin) / Math.max(1e-9, w.priceMax - w.priceMin));
      ctx.save();
      ctx.setLineDash([4, 12]);
      ctx.strokeStyle = PALETTE.medium;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = PALETTE.dimText;
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('PRICE', 4, py - 6);
      ctx.restore();

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); };
  }, []);

  // ── Mouse: hover + click ────────────────────────────────────────────

  const lastHoverRef = useRef(0);
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const now = performance.now();
    if (now - lastHoverRef.current < HOVER_THROTTLE_MS) return;
    lastHoverRef.current = now;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = worldRef.current;
    let bestIdx = -1;
    let bestD2 = HEX_R * HEX_R;
    for (let i = 0; i < w.cells.length; i++) {
      const c = w.cells[i]!;
      if (!c.active) continue;
      const d2 = (c.x - mx) ** 2 + (c.y - my) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) setHover({ cellIdx: bestIdx, x: mx, y: my });
    else setHover(null);
  }, []);

  const onMouseLeave = useCallback(() => setHover(null), []);

  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = worldRef.current;
    let bestIdx = -1;
    let bestD2 = HEX_R * HEX_R;
    for (let i = 0; i < w.cells.length; i++) {
      const c = w.cells[i]!;
      if (!c.active) continue;
      const d2 = (c.x - mx) ** 2 + (c.y - my) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      const c = w.cells[bestIdx]!;
      c.fireTime = w.tick;
      for (const n of c.neighbors) w.pulses.push(newPulse(bestIdx, n, 0));
      pushLog(`MANUAL FIRE · ${c.type.toUpperCase()} · STRENGTH ${c.strength.toFixed(2)}`);
    }
  }, [pushLog]);

  // ── Terminal ────────────────────────────────────────────────────────

  const submitCmd = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const world: BeehiveWorld = {
      cells: worldRef.current.cells,
      pulses: worldRef.current.pulses,
      tick: worldRef.current.tick,
      log: pushLog,
    };
    dispatch(world, cmdInput);
    setCmdInput('');
  }, [cmdInput, pushLog]);

  const hoverCell = hover != null ? worldRef.current.cells[hover.cellIdx] : null;

  // ── Render ──────────────────────────────────────────────────────────

  // Probe placement: keep within container bounds.
  const probeStyle = useMemo(() => {
    if (!hover || !hoverCell) return { display: 'none' as const };
    const offX = hover.x + 12 > worldRef.current.width - 200 ? hover.x - 200 : hover.x + 12;
    const offY = hover.y + 120 > worldRef.current.height ? hover.y - 130 : hover.y + 12;
    return { left: offX, top: offY };
  }, [hover, hoverCell]);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />

      {/* Top-left stats panel — Section 11 lines 737-744 */}
      <div className="absolute top-3 left-3 font-mono text-[9px] tracking-[0.15em] pointer-events-none"
           style={{ color: '#0a4a0a' }}>
        <div className="flex gap-4">
          <div><span>NODES </span><span className="font-bold" style={{ color: '#1aff1a' }}>{stats.nodes}</span></div>
          <div><span>ACTIVE </span><span className="font-bold" style={{ color: '#1aff1a' }}>{stats.active}</span></div>
          <div><span>PULSES </span><span className="font-bold" style={{ color: '#1aff1a' }}>{stats.pulses}</span></div>
          <div><span>FAKEOUT </span><span className="font-bold" style={{ color: '#1aff1a' }}>{stats.fakeout}</span></div>
          <div><span>ENERGY </span><span className="font-bold" style={{ color: '#1aff1a' }}>{stats.energy.toFixed(2)}</span></div>
        </div>
      </div>

      {/* Top-centre mode label */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 font-mono text-[8px] pointer-events-none"
           style={{ letterSpacing: '0.3em', color: '#0a3a0a' }}>
        GEOMETRIC MAP · HIVE VIEW
      </div>

      {/* Top-right price ticker */}
      <div className="absolute top-3 right-3 font-mono text-right pointer-events-none">
        <div className="text-[24px] font-bold"
             style={{ color: '#1aff1a', letterSpacing: '0.1em', textShadow: '0 0 8px #0f0' }}>
          {worldRef.current.price.toFixed(5)}
        </div>
        <div className="text-[9px]" style={{ color: '#0a5a0a', letterSpacing: '0.05em' }}>
          {mapMeta ? `${mapMeta.symbol} · ${mapMeta.nBars} BARS · SHA ${mapMeta.sha}` : 'NO MAP LOADED'}
        </div>
      </div>

      {/* Hover probe */}
      {hover && hoverCell && (
        <div className="absolute pointer-events-none border bg-black p-2"
             style={{ ...probeStyle, position: 'absolute', borderColor: '#0f3a0f', minWidth: 180 }}>
          <div className="font-mono text-[9px]"
               style={{ color: '#1aff1a', letterSpacing: '0.05em' }}>
            {hoverCell.type.toUpperCase()} · LEVEL {hoverCell.level}
          </div>
          <div className="font-mono text-[8px] leading-relaxed" style={{ color: '#0aaa0a' }}>
            <div>OUTCOME    {hoverCell.outcome}</div>
            <div>TOUCHES    {hoverCell.touches}</div>
            <div>STRENGTH   {hoverCell.strength.toFixed(2)}</div>
            <div>SPREAD     {hoverCell.spread.toFixed(2)}</div>
            <div>SLIPPAGE   {hoverCell.slippage.toFixed(3)}</div>
            <div>MOMENTUM   {hoverCell.momentum.toFixed(2)}</div>
            <div>VOLUME     {hoverCell.volume.toFixed(2)}</div>
            <div>ATR        {hoverCell.atr.toFixed(2)}</div>
            {hoverCell.fakeout && (
              <div className="font-bold" style={{ color: '#3aff3a' }}>FAKEOUT ACTIVE</div>
            )}
          </div>
        </div>
      )}

      {/* Bottom: event log + terminal */}
      <div className="absolute left-0 right-0 bottom-0 px-3 pb-2 pointer-events-none">
        <div className="font-mono text-[8px] mb-1 space-y-0.5" style={{ letterSpacing: '0.05em' }}>
          {log.map((entry, i) => {
            // Fade older entries — newest = bright, oldest = dim.
            const age = log.length - i - 1;
            const colour = age === 0 ? '#1aff1a' : age <= 1 ? '#0aaa0a' : age <= 2 ? '#0a5a0a' : '#020a02';
            return (
              <div key={`${entry.tick}-${i}`} style={{ color: colour }}>
                [{entry.tick.toString().padStart(6, '0')}] {entry.message}
              </div>
            );
          })}
        </div>
        <form onSubmit={submitCmd} className="pointer-events-auto flex items-center gap-1 border-b"
              style={{ borderColor: '#0f3a0f' }}>
          <span className="font-mono text-[10px]" style={{ color: '#0a6a0a', letterSpacing: '0.05em' }}>
            root@geomap:~$
          </span>
          <input
            type="text"
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            placeholder="type cmd: fire / fakeout / storm / reset / help"
            className="flex-1 bg-transparent border-0 outline-0 font-mono text-[10px] py-1"
            style={{ color: '#1aff1a', letterSpacing: '0.05em' }}
          />
        </form>
      </div>
    </div>
  );
}

// ── Hex drawing primitives ────────────────────────────────────────────

function drawHex(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, stroke: string) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawHexStroke(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}
