import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { CicadaLogo } from '../components/CicadaLogo';
import { CicadaCheckbox } from '../components/CicadaCheckbox';
import { Lock, User, Server } from 'lucide-react';
import { postMt5Connect } from '../core/api';
import { useTradingStore } from '../store/TradingStore';

export default function Login() {
  const navigate = useNavigate();
  const { actions } = useTradingStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('');
  const [terminalText, setTerminalText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<'username' | 'password' | 'server' | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);

  const fullText = `> CICADA-5453 initializing...[OK]\n> Neural network loaded......[OK]\n> MetaTrader 5 link...........[OK]\n> Secure tunnel established..[OK]\n> Awaiting authentication.`;

  useEffect(() => {
    let i = 0;
    const iv = setInterval(() => {
      if (i <= fullText.length) { setTerminalText(fullText.slice(0, i)); i++; }
      else clearInterval(iv);
    }, 25);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const chars = '01アイウエオABCDEF0123456789◈◆▲►';
    const fontSize = 11;
    const columns = Math.floor(canvas.width / fontSize);
    const drops: number[] = Array(columns).fill(1).map(() => Math.random() * -50);
    const draw = () => {
      ctx.fillStyle = 'rgba(0,0,0,0.045)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < drops.length; i++) {
        ctx.fillStyle = i % 11 === 0 ? 'rgba(255,102,0,0.55)' : 'rgba(0,255,0,0.4)';
        ctx.font = `${fontSize}px JetBrains Mono, monospace`;
        ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * fontSize, drops[i] * fontSize);
        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
        drops[i] += 0.4;
      }
      animFrameRef.current = requestAnimationFrame(draw);
    };
    draw();
    const onResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(animFrameRef.current); window.removeEventListener('resize', onResize); };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    if (demoMode) {
      setTimeout(() => navigate('/dashboard'), 800);
      return;
    }
    try {
      const res = await postMt5Connect(username, password, server);
      if (res.connected && res.account) {
        actions.applyMt5LoginSuccess(
          { login: username.trim(), password, server: server.trim() },
          { balance: res.account.balance ?? 0, equity: res.account.equity }
        );
        setTerminalText((t) => t + `\n> MT5 authenticated: ${res.account!.login} @ ${res.account!.server}[OK]`);
        setTimeout(() => navigate('/dashboard'), 1000);
      } else {
        setError(res.message || 'MT5 connection failed');
        setIsLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setIsLoading(false);
    }
  };

  return (
    <div
      className="h-screen max-h-screen bg-black text-[#00ff00] font-mono flex items-center justify-center overflow-hidden relative"
      style={{ height: '100vh', minHeight: '100vh', maxHeight: '100vh', overflow: 'hidden', backgroundColor: '#000', color: '#00ff00' }}
    >

      {/* Fixed backgrounds */}
      <canvas ref={canvasRef} className="fixed inset-0 opacity-25 pointer-events-none" style={{ zIndex: 0 }} />
      <div className="fixed inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.88) 100%)', zIndex: 0 }} />
      <div className="fixed inset-0 pointer-events-none" style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.07) 3px, rgba(0,0,0,0.07) 4px)', zIndex: 0 }} />
      <div className="fixed top-0 left-1/4 w-80 h-80 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(0,255,0,0.05), transparent 70%)', filter: 'blur(40px)', zIndex: 0 }} />
      <div className="fixed bottom-0 right-1/4 w-80 h-80 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(255,102,0,0.04), transparent 70%)', filter: 'blur(40px)', zIndex: 0 }} />

      {/* Main card — two columns */}
      <div className="relative w-full max-w-3xl mx-4 border-2 border-[#00ff00] bg-black"
        style={{ zIndex: 2, boxShadow: '0 0 40px rgba(0,255,0,0.3), 0 0 80px rgba(0,255,0,0.1), inset 0 0 40px rgba(0,0,0,0.95)' }}>

        {/* Outer orange corner brackets */}
        {[['top-0 left-0','border-l-2 border-t-2','-translate-x-px -translate-y-px'],
          ['top-0 right-0','border-r-2 border-t-2','translate-x-px -translate-y-px'],
          ['bottom-0 left-0','border-l-2 border-b-2','-translate-x-px translate-y-px'],
          ['bottom-0 right-0','border-r-2 border-b-2','translate-x-px translate-y-px'],
        ].map(([pos, border, tr], i) => (
          <div key={i} className={`absolute ${pos} w-5 h-5 ${border} border-[#ff6600]`}
            style={{ boxShadow: '0 0 8px rgba(255,102,0,0.9)', transform: tr }} />
        ))}

        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#00ff00] border-opacity-30">
          <span className="text-[#ff6600] text-[9px] tracking-[0.3em]" style={{ textShadow: '0 0 7px rgba(255,102,0,0.9)' }}>◈ SYSTEM CORE ◈</span>
          <span className="text-[#00ff00] text-[9px] tracking-widest opacity-40">NEURAL_ALGO_ENGINE :: v5.4.5.3</span>
          <span className="text-[#00ff00] text-[9px] opacity-40">[ ENCRYPTED ]</span>
        </div>

        <div className="flex">
          {/* ── LEFT: Logo ─────────────────────────────── */}
          <div className="flex items-center justify-center p-6 border-r border-[#00ff00] border-opacity-20" style={{ minWidth: '260px' }}>
            <CicadaLogo size={155} showText={true} compact={false} />
          </div>

          {/* ── RIGHT: Terminal + Auth ──────────────────── */}
          <div className="flex-1 flex flex-col p-4 gap-3">

            {/* Terminal console */}
            <div className="relative">
              <div className="absolute -top-2.5 left-2 bg-black px-2">
                <span className="text-[#00ff00] text-[8px] tracking-widest opacity-60">[ SYSTEM CONSOLE ]</span>
              </div>
              <div className="border border-[#00ff00] border-opacity-50 bg-black p-3 relative"
                style={{ boxShadow: '0 0 10px rgba(0,255,0,0.15), inset 0 0 15px rgba(0,0,0,0.8)' }}>
                <div className="absolute top-0 left-0 w-2 h-2 border-l border-t border-[#00ff00]" />
                <div className="absolute top-0 right-0 w-2 h-2 border-r border-t border-[#00ff00]" />
                <div className="absolute bottom-0 left-0 w-2 h-2 border-l border-b border-[#00ff00]" />
                <div className="absolute bottom-0 right-0 w-2 h-2 border-r border-b border-[#00ff00]" />
                <pre className="text-[9px] leading-relaxed whitespace-pre-wrap text-[#00ff00]"
                  style={{ textShadow: '0 0 4px rgba(0,255,0,0.5)' }}>
                  {terminalText}<span>█</span>
                </pre>
              </div>
            </div>

            {/* Auth form */}
            <div className="relative">
              <div className="absolute -top-2.5 left-2 bg-black px-2">
                <span className="text-[#ff6600] text-[8px] tracking-widest" style={{ textShadow: '0 0 5px rgba(255,102,0,0.8)' }}>
                  [ AUTHENTICATION REQUIRED ]
                </span>
              </div>
              <div className="border-2 border-[#00ff00] bg-black p-4 relative"
                style={{ boxShadow: '0 0 20px rgba(0,255,0,0.2), inset 0 0 20px rgba(0,0,0,0.9)' }}>
                <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#ff6600]" style={{ boxShadow: '0 0 5px rgba(255,102,0,0.7)' }} />
                <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#ff6600]" style={{ boxShadow: '0 0 5px rgba(255,102,0,0.7)' }} />
                <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#ff6600]" style={{ boxShadow: '0 0 5px rgba(255,102,0,0.7)' }} />
                <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#ff6600]" style={{ boxShadow: '0 0 5px rgba(255,102,0,0.7)' }} />

                <form onSubmit={handleLogin} className="space-y-3">
                  {/* Username */}
                  <div>
                    <label className="text-[#00ff00] text-[9px] tracking-widest flex items-center gap-1.5 mb-1 opacity-75">
                      <User className="w-2.5 h-2.5" /> &gt; USER_IDENTIFIER
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      id="username"
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2.5 py-2 text-xs focus:outline-none"
                      style={{
                        boxShadow: focusedField === 'username'
                          ? '0 0 12px rgba(0,255,0,0.45), inset 0 0 8px rgba(0,0,0,0.8)'
                          : 'inset 0 0 8px rgba(0,0,0,0.8)',
                        transition: 'box-shadow 0.25s',
                        caretColor: '#00ff00',
                      }}
                      onFocus={() => setFocusedField('username')}
                      onBlur={() => setFocusedField(null)}
                      placeholder="MT5 account number..."
                      required={!demoMode}
                      disabled={demoMode}
                    />
                  </div>

                  {/* Password */}
                  <div>
                    <label className="text-[#00ff00] text-[9px] tracking-widest flex items-center gap-1.5 mb-1 opacity-75">
                      <Lock className="w-2.5 h-2.5" /> &gt; PASS_KEY
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      id="password"
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2.5 py-2 text-xs focus:outline-none"
                      style={{
                        boxShadow: focusedField === 'password'
                          ? '0 0 12px rgba(0,255,0,0.45), inset 0 0 8px rgba(0,0,0,0.8)'
                          : 'inset 0 0 8px rgba(0,0,0,0.8)',
                        transition: 'box-shadow 0.25s',
                        caretColor: '#00ff00',
                      }}
                      onFocus={() => setFocusedField('password')}
                      onBlur={() => setFocusedField(null)}
                      placeholder="enter_cipher_key..."
                      required={!demoMode}
                      disabled={demoMode}
                    />
                  </div>

                  {/* Server (MT5 broker server name) */}
                  <div>
                    <label className="text-[#00ff00] text-[9px] tracking-widest flex items-center gap-1.5 mb-1 opacity-75">
                      <Server className="w-2.5 h-2.5" /> &gt; SERVER (optional)
                    </label>
                    <input
                      type="text"
                      value={server}
                      onChange={e => setServer(e.target.value)}
                      id="server"
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2.5 py-2 text-xs focus:outline-none"
                      style={{
                        boxShadow: focusedField === 'server'
                          ? '0 0 12px rgba(0,255,0,0.45), inset 0 0 8px rgba(0,0,0,0.8)'
                          : 'inset 0 0 8px rgba(0,0,0,0.8)',
                        transition: 'box-shadow 0.25s',
                        caretColor: '#00ff00',
                      }}
                      onFocus={() => setFocusedField('server')}
                      onBlur={() => setFocusedField(null)}
                      placeholder="Broker-Server or leave empty"
                      disabled={demoMode}
                    />
                  </div>

                  {error && (
                    <div className="text-[#ff4444] text-[10px] border border-[#ff4444] bg-black/80 px-2 py-1.5">
                      {error}
                    </div>
                  )}

                  {/* Skip MT5 and enter dashboard */}
                  <CicadaCheckbox
                    checked={demoMode}
                    onChange={(v) => { setDemoMode(v); setError(null); }}
                    label="Continue without MT5"
                    size="sm"
                  />

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full bg-black border-2 border-[#00ff00] text-[#00ff00] py-2.5 text-xs tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      boxShadow: isLoading ? '0 0 25px rgba(255,102,0,0.5)' : '0 0 8px rgba(0,255,0,0.25)',
                      textShadow: '0 0 7px rgba(0,255,0,0.8)',
                    }}
                    onMouseEnter={e => { if (!isLoading) { (e.currentTarget.style.boxShadow = '0 0 20px rgba(0,255,0,0.5)'); (e.currentTarget.style.background = 'rgba(0,255,0,0.04)'); }}}
                    onMouseLeave={e => { (e.currentTarget.style.boxShadow = '0 0 8px rgba(0,255,0,0.25)'); (e.currentTarget.style.background = 'transparent'); }}
                  >
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2" style={{ color: '#ff6600', textShadow: '0 0 7px rgba(255,102,0,0.9)' }}>
                        <span className="animate-spin">◈</span> AUTHENTICATING... <span className="animate-spin" style={{ animationDirection: 'reverse' }}>◈</span>
                      </span>
                    ) : '◄ INITIATE SECURE ACCESS ►'}
                  </button>
                </form>
              </div>
            </div>

            {/* Warning strip */}
            <div className="border border-[#ff6600] bg-black px-3 py-2 text-center"
              style={{ boxShadow: '0 0 12px rgba(255,102,0,0.2)' }}>
              <span className="text-[#ff6600] text-[9px] tracking-[0.25em]" style={{ textShadow: '0 0 5px rgba(255,102,0,0.8)' }}>
                ⚠ AUTHORIZED ACCESS ONLY — ALL ACTIVITY MONITORED ⚠
              </span>
            </div>

          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[#00ff00] border-opacity-20 px-4 py-1.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {[['#ff6600','ARMED'],['#00ff00','ONLINE'],['#00ff00','SECURE']].map(([color, label]) => (
              <div key={label} className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: color, boxShadow: `0 0 5px ${color}` }} />
                <span className="text-[8px] tracking-wider" style={{ color, opacity: 0.8 }}>{label}</span>
              </div>
            ))}
          </div>
          <span className="text-[#00ff00] text-[8px] opacity-30 tracking-widest">CICADA-5453 :: ENCRYPTED CHANNEL</span>
        </div>
      </div>
    </div>
  );
}