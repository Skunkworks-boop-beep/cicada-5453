import { useEffect, useState, useRef } from 'react';

interface CicadaLogoProps {
  size?: number;
  showText?: boolean;
  compact?: boolean;
}

// ─── Geometric SVG Cicada ─────────────────────────────────────────────────────
function CicadaSVG({ width, glitch, pulse }: { width: number; glitch: boolean; pulse: number }) {
  const g = 0.55 + 0.45 * Math.sin((pulse * Math.PI) / 180);
  const mainColor   = glitch ? '#ff6600' : '#00ff00';
  const accentColor = '#ff6600';
  const wingFill    = glitch ? 'rgba(255,102,0,0.04)' : `rgba(0,255,0,${0.03 + 0.03 * g})`;
  const wingStroke  = glitch ? 'rgba(255,102,0,0.7)' : `rgba(0,255,0,${0.55 + 0.3 * g})`;
  const bodyGlow    = glitch ? 'url(#glowOrange)' : 'url(#glowGreen)';
  const veinOpacity = 0.3 + 0.2 * g;

  // viewBox: 0 0 280 210, center X = 140
  const vb = 280;
  const scale = width / vb;

  return (
    <svg
      viewBox="0 0 280 210"
      width={width}
      height={width * (210 / 280)}
      style={{ overflow: 'visible', display: 'block' }}
    >
      <defs>
        {/* Green phosphor glow */}
        <filter id="glowGreen" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Tight body glow */}
        <filter id="glowBody" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Orange glow */}
        <filter id="glowOrange" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Eye glow */}
        <filter id="eyeGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Subtle wing glow */}
        <filter id="wingGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Radial gradient for wing fill */}
        <radialGradient id="wingGradL" cx="70%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#00ff00" stopOpacity={0.08 * g} />
          <stop offset="100%" stopColor="#00ff00" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="wingGradR" cx="30%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#00ff00" stopOpacity={0.08 * g} />
          <stop offset="100%" stopColor="#00ff00" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ── AMBIENT BODY HALO ─────────────────────────────────── */}
      <ellipse cx="140" cy="90" rx="28" ry="60"
        fill="none"
        stroke={mainColor}
        strokeWidth="0"
        filter="url(#glowGreen)"
        opacity={0.12 * g}
      />

      {/* ══════════════════════════════════════════════════════════
          WINGS — drawn behind body
      ══════════════════════════════════════════════════════════ */}

      {/* ── UPPER LEFT WING ──────────────────────────────────── */}
      <polygon
        points="124,54 94,26 56,12 20,22 12,52 34,76 78,90 120,84 124,69"
        fill="url(#wingGradL)"
        stroke={wingStroke}
        strokeWidth="1.2"
        filter="url(#wingGlow)"
      />
      {/* Upper left veins — geometric circuit traces */}
      <g stroke={mainColor} strokeWidth="0.7" opacity={veinOpacity} fill="none">
        {/* Primary diagonal */}
        <line x1="124" y1="54" x2="34" y2="76" />
        {/* Secondary diagonal */}
        <line x1="94" y1="26" x2="78" y2="90" />
        {/* Cross cells */}
        <line x1="56" y1="12" x2="34" y2="76" />
        <line x1="20" y1="22" x2="78" y2="90" />
        {/* Node dots at intersections */}
        <circle cx="68" cy="48" r="1.8" fill={mainColor} opacity={0.5} />
        <circle cx="46" cy="62" r="1.5" fill={mainColor} opacity={0.4} />
        <circle cx="82" cy="66" r="1.5" fill={mainColor} opacity={0.4} />
        <circle cx="58" cy="34" r="1.5" fill={mainColor} opacity={0.4} />
      </g>
      {/* Wing cell fill accents */}
      <polygon points="68,48 94,26 56,12 34,22 20,52 46,62" fill={mainColor} opacity={0.02} />

      {/* ── UPPER RIGHT WING (mirror) ────────────────────────── */}
      <polygon
        points="156,54 186,26 224,12 260,22 268,52 246,76 202,90 160,84 156,69"
        fill="url(#wingGradR)"
        stroke={wingStroke}
        strokeWidth="1.2"
        filter="url(#wingGlow)"
      />
      <g stroke={mainColor} strokeWidth="0.7" opacity={veinOpacity} fill="none">
        <line x1="156" y1="54" x2="246" y2="76" />
        <line x1="186" y1="26" x2="202" y2="90" />
        <line x1="224" y1="12" x2="246" y2="76" />
        <line x1="260" y1="22" x2="202" y2="90" />
        <circle cx="212" cy="48" r="1.8" fill={mainColor} opacity={0.5} />
        <circle cx="234" cy="62" r="1.5" fill={mainColor} opacity={0.4} />
        <circle cx="198" cy="66" r="1.5" fill={mainColor} opacity={0.4} />
        <circle cx="222" cy="34" r="1.5" fill={mainColor} opacity={0.4} />
      </g>

      {/* ── LOWER LEFT WING ──────────────────────────────────── */}
      <polygon
        points="120,84 78,90 46,106 40,128 66,138 104,122 122,98"
        fill={wingFill}
        stroke={wingStroke}
        strokeWidth="1"
        opacity="0.85"
        filter="url(#wingGlow)"
      />
      <g stroke={mainColor} strokeWidth="0.6" opacity={veinOpacity * 0.8} fill="none">
        <line x1="120" y1="84" x2="66" y2="138" />
        <line x1="78" y1="90" x2="104" y2="122" />
        <line x1="46" y1="106" x2="104" y2="122" />
        <circle cx="86" cy="110" r="1.4" fill={mainColor} opacity={0.4} />
        <circle cx="66" cy="118" r="1.2" fill={mainColor} opacity={0.35} />
      </g>

      {/* ── LOWER RIGHT WING ─────────────────────────────────── */}
      <polygon
        points="160,84 202,90 234,106 240,128 214,138 176,122 158,98"
        fill={wingFill}
        stroke={wingStroke}
        strokeWidth="1"
        opacity="0.85"
        filter="url(#wingGlow)"
      />
      <g stroke={mainColor} strokeWidth="0.6" opacity={veinOpacity * 0.8} fill="none">
        <line x1="160" y1="84" x2="214" y2="138" />
        <line x1="202" y1="90" x2="176" y2="122" />
        <line x1="234" y1="106" x2="176" y2="122" />
        <circle cx="194" cy="110" r="1.4" fill={mainColor} opacity={0.4} />
        <circle cx="214" cy="118" r="1.2" fill={mainColor} opacity={0.35} />
      </g>

      {/* ══════════════════════════════════════════════════════════
          LEGS — 3 pairs, geometric bent lines
      ══════════════════════════════════════════════════════════ */}
      <g stroke={mainColor} strokeWidth="1.1" fill="none" opacity={0.7} filter="url(#glowBody)">
        {/* Front pair */}
        <polyline points="126,54 108,42 94,48 80,42" />
        <polyline points="154,54 172,42 186,48 200,42" />
        {/* Mid pair */}
        <polyline points="124,62 100,60 84,70 70,64" />
        <polyline points="156,62 180,60 196,70 210,64" />
        {/* Rear pair */}
        <polyline points="124,70 102,84 88,94 74,90" />
        <polyline points="156,70 178,84 192,94 206,90" />
        {/* Joint nodes */}
        {[
          [108,42],[186,48],[100,60],[180,60],[102,84],[178,84],
          [94,48],[172,42],[84,70],[196,70],[88,94],[192,94],
        ].map(([cx,cy],i) => (
          <circle key={i} cx={cx} cy={cy} r="1.8" fill={mainColor} stroke="none" opacity={0.6} />
        ))}
      </g>

      {/* ══════════════════════════════════════════════════════════
          BODY — head, thorax, abdomen
      ══════════════════════════════════════════════════════════ */}

      {/* ── THORAX (hexagon) ─────────────────────────────────── */}
      <polygon
        points="140,42 158,52 158,72 140,82 122,72 122,52"
        fill="black"
        stroke={mainColor}
        strokeWidth="1.8"
        filter={bodyGlow}
      />
      {/* Thorax inner detail — smaller inset hex */}
      <polygon
        points="140,50 151,56 151,68 140,74 129,68 129,56"
        fill="none"
        stroke={mainColor}
        strokeWidth="0.7"
        opacity={0.4}
      />
      {/* Thorax center dot */}
      <circle cx="140" cy="62" r="3" fill={accentColor} filter="url(#eyeGlow)" opacity={0.9} />
      {/* Thorax circuit lines */}
      <g stroke={accentColor} strokeWidth="0.8" opacity={0.5}>
        <line x1="130" y1="56" x2="134" y2="62" />
        <line x1="150" y1="56" x2="146" y2="62" />
        <line x1="130" y1="68" x2="134" y2="62" />
        <line x1="150" y1="68" x2="146" y2="62" />
      </g>

      {/* ── HEAD (hexagon) ───────────────────────────────────── */}
      <polygon
        points="140,14 154,22 154,38 140,46 126,38 126,22"
        fill="black"
        stroke={mainColor}
        strokeWidth="1.8"
        filter={bodyGlow}
      />
      {/* Head inner ring */}
      <polygon
        points="140,20 149,25 149,36 140,41 131,36 131,25"
        fill="none"
        stroke={mainColor}
        strokeWidth="0.7"
        opacity={0.35}
      />

      {/* ── COMPOUND EYES (orange glowing diamonds) ──────────── */}
      <polygon
        points="129,25 134,30 129,35 124,30"
        fill={accentColor}
        opacity={0.85}
        filter="url(#eyeGlow)"
      />
      <polygon
        points="151,25 156,30 151,35 146,30"
        fill={accentColor}
        opacity={0.85}
        filter="url(#eyeGlow)"
      />
      {/* Eye inner highlight */}
      <polygon points="129,27 132,30 129,33 126,30" fill="black" opacity={0.6} />
      <polygon points="151,27 154,30 151,33 148,30" fill="black" opacity={0.6} />

      {/* ── ANTENNAE ─────────────────────────────────────────── */}
      <g filter={bodyGlow} opacity={0.9}>
        {/* Left antenna — two segments with angle */}
        <line x1="133" y1="16" x2="116" y2="6" stroke={mainColor} strokeWidth="1.2" />
        <line x1="116" y1="6" x2="106" y2="2" stroke={mainColor} strokeWidth="0.9" opacity={0.7} />
        {/* Tip diamond */}
        <polygon points="106,0 109,2 106,4 103,2" fill={mainColor} opacity={0.9} />
        {/* Elbow node */}
        <circle cx="116" cy="6" r="1.8" fill={accentColor} opacity={0.8} />

        {/* Right antenna */}
        <line x1="147" y1="16" x2="164" y2="6" stroke={mainColor} strokeWidth="1.2" />
        <line x1="164" y1="6" x2="174" y2="2" stroke={mainColor} strokeWidth="0.9" opacity={0.7} />
        <polygon points="174,0 177,2 174,4 171,2" fill={mainColor} opacity={0.9} />
        <circle cx="164" cy="6" r="1.8" fill={accentColor} opacity={0.8} />
      </g>

      {/* ── ABDOMEN (5 tapering segments + pointed tip) ──────── */}
      {/* Seg 1 */}
      <polygon points="128,82 152,82 149,95 131,95"
        fill="black" stroke={mainColor} strokeWidth="1.5" filter={bodyGlow} />
      <line x1="128" y1="88" x2="152" y2="88" stroke={mainColor} strokeWidth="0.5" opacity={0.25} />
      {/* Seg 1 orange accent mark */}
      <line x1="136" y1="85" x2="144" y2="85" stroke={accentColor} strokeWidth="1.2" opacity={0.6} />

      {/* Seg 2 */}
      <polygon points="131,95 149,95 146,107 134,107"
        fill="black" stroke={mainColor} strokeWidth="1.5" filter={bodyGlow} />
      <line x1="131" y1="101" x2="149" y2="101" stroke={mainColor} strokeWidth="0.5" opacity={0.25} />
      <line x1="137" y1="98" x2="143" y2="98" stroke={accentColor} strokeWidth="1.2" opacity={0.5} />

      {/* Seg 3 */}
      <polygon points="134,107 146,107 144,118 136,118"
        fill="black" stroke={mainColor} strokeWidth="1.4" filter={bodyGlow} />
      <line x1="134" y1="112" x2="146" y2="112" stroke={mainColor} strokeWidth="0.5" opacity={0.25} />
      <line x1="138" y1="110" x2="142" y2="110" stroke={accentColor} strokeWidth="1.1" opacity={0.45} />

      {/* Seg 4 */}
      <polygon points="136,118 144,118 142,128 138,128"
        fill="black" stroke={mainColor} strokeWidth="1.3" filter={bodyGlow} />
      <line x1="138" y1="122" x2="142" y2="122" stroke={accentColor} strokeWidth="1" opacity={0.4} />

      {/* Tip */}
      <polygon points="138,128 142,128 140,142"
        fill="black" stroke={mainColor} strokeWidth="1.2" filter={bodyGlow} />

      {/* ── DECORATIVE CORNER NODES (tech aesthetic) ─────────── */}
      {/* Wing attachment nodes */}
      <circle cx="124" cy="54" r="3" fill="black" stroke={accentColor} strokeWidth="1.2"
        filter="url(#eyeGlow)" opacity={0.8} />
      <circle cx="156" cy="54" r="3" fill="black" stroke={accentColor} strokeWidth="1.2"
        filter="url(#eyeGlow)" opacity={0.8} />
      <circle cx="122" cy="72" r="2.5" fill="black" stroke={mainColor} strokeWidth="1"
        opacity={0.6} />
      <circle cx="158" cy="72" r="2.5" fill="black" stroke={mainColor} strokeWidth="1"
        opacity={0.6} />

      {/* ── CENTRAL SPINE LINE ───────────────────────────────── */}
      <line x1="140" y1="82" x2="140" y2="130"
        stroke={mainColor} strokeWidth="0.6" opacity={0.2} strokeDasharray="3 3" />
    </svg>
  );
}

// ─── Main Logo Component ──────────────────────────────────────────────────────
export function CicadaLogo({ size = 200, showText = true, compact = false }: CicadaLogoProps) {
  const [glitchActive, setGlitchActive] = useState(false);
  const [pulse, setPulse] = useState(0);
  const [bootText, setBootText] = useState<string[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const triggerGlitch = () => {
      setGlitchActive(true);
      setTimeout(() => setGlitchActive(false), 120);
    };
    const id = setInterval(() => {
      if (Math.random() > 0.6) triggerGlitch();
    }, 3000 + Math.random() * 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setPulse(p => (p + 1) % 360), 20);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!showText || compact) return;
    const lines = ['SYS://INIT_SEQUENCE', 'NEURAL.NET: LOADED', 'ALGO_CORE: ARMED'];
    let i = 0;
    intervalRef.current = setInterval(() => {
      if (i < lines.length) { setBootText(prev => [...prev, lines[i]]); i++; }
      else if (intervalRef.current) clearInterval(intervalRef.current);
    }, 700);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [showText, compact]);

  const g = 0.55 + 0.45 * Math.sin((pulse * Math.PI) / 180);

  // ── COMPACT (dashboard header) ──────────────────────────────
  if (compact) {
    return (
      <div className="flex items-center gap-3">
        <div style={{ filter: `drop-shadow(0 0 6px rgba(0,255,0,${0.6 + 0.3 * g}))` }}>
          <CicadaSVG width={52} glitch={glitchActive} pulse={pulse} />
        </div>
        <div>
          <div
            className="font-mono tracking-[0.35em]"
            style={{
              color: glitchActive ? '#ff6600' : '#00ff00',
              textShadow: glitchActive
                ? '0 0 10px #ff6600, 0 0 20px rgba(255,102,0,0.5)'
                : '0 0 10px #00ff00, 0 0 20px rgba(0,255,0,0.5)',
              transition: 'color 0.1s',
            }}
          >
            {glitchActive ? 'C1C4D4-5453' : 'CICADA-5453'}
          </div>
          <div className="text-[#ff6600] text-[9px] tracking-widest font-mono opacity-80"
            style={{ textShadow: '0 0 6px rgba(255,102,0,0.7)' }}>
            ALGORITHMIC TRADING SYSTEM
          </div>
        </div>
      </div>
    );
  }

  // ── FULL LOGO ───────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center" style={{ fontFamily: 'JetBrains Mono, monospace' }}>

      {/* Corner bracket frame */}
      <div className="relative inline-block">
        <div className="absolute -top-3 -left-3 w-7 h-7 border-l-2 border-t-2 border-[#ff6600]"
          style={{ boxShadow: '0 0 10px rgba(255,102,0,0.8)' }} />
        <div className="absolute -top-3 -right-3 w-7 h-7 border-r-2 border-t-2 border-[#ff6600]"
          style={{ boxShadow: '0 0 10px rgba(255,102,0,0.8)' }} />
        <div className="absolute -bottom-3 -left-3 w-7 h-7 border-l-2 border-b-2 border-[#ff6600]"
          style={{ boxShadow: '0 0 10px rgba(255,102,0,0.8)' }} />
        <div className="absolute -bottom-3 -right-3 w-7 h-7 border-r-2 border-b-2 border-[#ff6600]"
          style={{ boxShadow: '0 0 10px rgba(255,102,0,0.8)' }} />

        {/* Glitch offset copy */}
        {glitchActive && (
          <div style={{
            position: 'absolute', top: 0, left: 0,
            transform: 'translate(4px, -3px)',
            opacity: 0.3, filter: 'hue-rotate(160deg)',
            pointerEvents: 'none',
          }}>
            <CicadaSVG width={size} glitch={false} pulse={pulse} />
          </div>
        )}

        {/* Main SVG insect */}
        <div style={{
          filter: `drop-shadow(0 0 ${8 + 6 * g}px rgba(0,255,0,${0.6 + 0.3 * g})) drop-shadow(0 0 ${20 + 10 * g}px rgba(0,255,0,${0.25 + 0.15 * g}))`,
          transform: glitchActive ? `translate(${(Math.random()-0.5)*4}px,${(Math.random()-0.5)*3}px)` : 'none',
          transition: 'transform 0.05s',
        }}>
          <CicadaSVG width={size} glitch={glitchActive} pulse={pulse} />
        </div>
      </div>

      {/* ── TEXT BLOCK ─────────────────────────────────────── */}
      {showText && (
        <div className="text-center mt-5" style={{ width: size + 30 }}>
          {/* Separator */}
          <div className="flex items-center gap-2 mb-3">
            <div className="h-px flex-1" style={{
              background: 'linear-gradient(to right, transparent, #ff6600, transparent)',
              boxShadow: '0 0 4px rgba(255,102,0,0.8)',
            }} />
            <span className="text-[#ff6600] text-[9px]" style={{ textShadow: '0 0 6px rgba(255,102,0,0.9)' }}>◈</span>
            <div className="h-px flex-1" style={{
              background: 'linear-gradient(to right, transparent, #ff6600, transparent)',
              boxShadow: '0 0 4px rgba(255,102,0,0.8)',
            }} />
          </div>

          {/* Title */}
          <div
            className="tracking-[0.4em] font-mono"
            style={{
              fontSize: size * 0.185,
              color: glitchActive ? '#ff6600' : '#00ff00',
              textShadow: glitchActive
                ? '0 0 8px #ff6600, 0 0 20px rgba(255,102,0,0.7)'
                : `0 0 8px rgba(0,255,0,1), 0 0 20px rgba(0,255,0,0.7), 0 0 40px rgba(0,255,0,0.35)`,
              transition: 'color 0.1s, text-shadow 0.1s',
            }}
          >
            {glitchActive ? 'C1C4D4-5453' : 'CICADA-5453'}
          </div>

          {/* Subtitle */}
          <div
            className="tracking-[0.28em] mt-1 font-mono"
            style={{
              fontSize: size * 0.069,
              color: '#ff6600',
              textShadow: '0 0 6px rgba(255,102,0,0.9), 0 0 15px rgba(255,102,0,0.4)',
            }}
          >
            ◄ ALGORITHMIC TRADING SYSTEM ►
          </div>

          {/* Boot lines */}
          <div className="mt-3 space-y-1 min-h-[46px]">
            {bootText.map((line, i) => (
              <div key={i} className="font-mono opacity-60"
                style={{
                  fontSize: size * 0.063,
                  letterSpacing: '0.14em',
                  color: '#00ff00',
                  textShadow: '0 0 5px rgba(0,255,0,0.5)',
                }}>
                &gt; {line}{i === bootText.length - 1 && <span>_</span>}
              </div>
            ))}
          </div>

          {/* Bottom rule */}
          <div className="flex items-center gap-2 mt-3">
            <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, transparent, rgba(0,255,0,0.5), transparent)' }} />
            <span className="text-[#00ff00] text-[8px] tracking-widest opacity-50">[ v5.4.5.3 ]</span>
            <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, transparent, rgba(0,255,0,0.5), transparent)' }} />
          </div>

          {/* Status indicators */}
          <div className="flex justify-center gap-5 mt-2">
            {(['ARMED', 'ONLINE', 'SECURE'] as const).map((label, i) => (
              <div key={label} className="flex items-center gap-1.5" style={{ fontSize: size * 0.058 }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{
                    background: i === 0 ? '#ff6600' : '#00ff00',
                    boxShadow: `0 0 6px ${i === 0 ? 'rgba(255,102,0,1)' : 'rgba(0,255,0,1)'}`,
                  }} />
                <span className="font-mono tracking-wider"
                  style={{
                    color: i === 0 ? '#ff6600' : '#00ff00',
                    textShadow: `0 0 5px ${i === 0 ? 'rgba(255,102,0,0.7)' : 'rgba(0,255,0,0.7)'}`,
                    opacity: 0.85,
                  }}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
