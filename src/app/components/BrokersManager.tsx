/**
 * Bridge Manager. Each row is a named MT5 account credential set ("a
 * bridge"). The bridge runtime (the FastAPI process inside the Windows
 * VM at localhost:5000) is shared — switching bridges = re-logging MT5
 * with that bridge's credentials.
 *
 * Persistence still uses the brokers[] / BrokerConfig shape so old
 * snapshots load, but everything in this UI talks about bridges. The
 * deriv_api / exness_api types are stripped on load by
 * src/app/store/slices/brokerHydration.ts; this component only ever
 * sees mt5 rows.
 */

import { useEffect, useState } from 'react';
import { useTradingStore } from '../store/TradingStore';
import type { BrokerConfig } from '../core/types';
import { BROKER_EXNESS_ID } from '../core/registries';
import { getBridgeHealth, getMt5Tick, type BridgeHealth, type LiveTick } from '../core/api';
import { Server, Plus, Settings2, Loader2, Wifi, WifiOff, CheckCircle2, Trash2, X } from 'lucide-react';

function statusLabel(b: BrokerConfig): { text: string; cls: string } {
  if (b.status === 'connected') return { text: 'ACTIVE', cls: 'text-[#00ff00]' };
  if (b.status === 'connecting') return { text: 'CONNECTING', cls: 'text-[#ffff00]' };
  if (b.status === 'error') return { text: 'ERROR', cls: 'text-[#ff4444]' };
  return { text: 'IDLE', cls: 'text-[#00ff00]/50' };
}

function maskLogin(login: string | undefined): string {
  if (!login) return '—';
  const s = String(login);
  if (s.length <= 4) return s;
  return `…${s.slice(-4)}`;
}

interface BridgeForm {
  name: string;
  login: string;
  password: string;
  server: string;
}

const EMPTY_FORM: BridgeForm = { name: '', login: '', password: '', server: '' };

export function BrokersManager() {
  const { state, actions } = useTradingStore();
  const { brokers } = state;
  // Hide any deprecated rows that somehow survive (defensive — hydration migration handles this).
  const bridges = brokers.filter((b) => b.type === 'mt5');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<BridgeForm>(EMPTY_FORM);
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [liveTick, setLiveTick] = useState<LiveTick | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const h = await getBridgeHealth();
      if (!cancelled) setBridgeHealth(h);
    };
    void tick();
    const id = setInterval(() => void tick(), 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Stage 9: live-tick strip in the runtime row. EURUSD as the canonical
  // probe symbol because every MT5 broker has it; the value is just a
  // "is the bridge feeding ticks" reality check — per-instrument ticks
  // live on the PriceChart / BotExecutionLog.
  useEffect(() => {
    if (!bridgeHealth?.reachable || !bridgeHealth?.mt5_connected) {
      setLiveTick(null);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      const t = await getMt5Tick('EURUSD');
      if (!cancelled) setLiveTick(t);
    };
    void probe();
    const id = setInterval(() => void probe(), 2_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [bridgeHealth?.reachable, bridgeHealth?.mt5_connected]);

  const isBuiltIn = (id: string) => id === BROKER_EXNESS_ID;

  const useBridge = async (b: BrokerConfig) => {
    if (b.status === 'connecting') return;
    if (!b.config.login || !b.config.password) {
      // No credentials yet — open the editor so the operator can fill them.
      setForm({
        name: b.name,
        login: String(b.config.login ?? ''),
        password: String(b.config.password ?? ''),
        server: String(b.config.server ?? ''),
      });
      setEditingId(b.id);
      return;
    }
    // Mark every other bridge as IDLE — the MT5 terminal can only host one
    // login at a time, so at most one bridge is ACTIVE.
    bridges.forEach((other) => {
      if (other.id !== b.id && other.status === 'connected') {
        actions.disconnectBroker(other.id);
      }
    });
    await actions.connectBroker(b.id, b.config);
  };

  const saveBridgeEdit = (id: string) => {
    const b = bridges.find((x) => x.id === id);
    if (!b) return;
    actions.updateBroker(id, {
      name: form.name.trim() || b.name,
      config: { ...b.config, login: form.login, password: form.password, server: form.server },
    });
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const handleAddBridge = () => {
    if (!form.name.trim()) return;
    const baseId = 'bridge-' + form.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    let id = baseId;
    let suffix = 2;
    while (bridges.some((b) => b.id === id)) id = `${baseId}-${suffix++}`;
    actions.addBroker({
      id,
      name: form.name.trim(),
      type: 'mt5',
      status: 'disconnected',
      config: { login: form.login, password: form.password, server: form.server },
      order: bridges.length,
    });
    setForm(EMPTY_FORM);
    setAddOpen(false);
  };

  const cancelForm = () => {
    setAddOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-[10px] mb-1 tracking-wider">
        <Server className="w-3.5 h-3.5" />
        <span>[ MT5 BRIDGES ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="opacity-70">switch between MT5 accounts via the shared VM bridge</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]" />
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]" />
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]" />
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]" />

        <div className="space-y-3">
          {/* Bridge runtime health — first row, distinct visual recipe so it doesn't read as a switchable bridge */}
          <div className="border border-[#00ff00]/50 bg-[#00ff0008] p-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className={`flex items-center gap-1.5 text-[10px] tracking-wider ${
                bridgeHealth?.reachable ? 'text-[#00ff00]' : 'text-[#ff6600]'
              }`}>
                {bridgeHealth?.reachable ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                [ BRIDGE RUNTIME ]
              </span>
              <span className="text-[10px] text-[#00ff00]/60">localhost:5000 → Windows VM</span>
              <span className={`text-[10px] tracking-wider ${
                bridgeHealth == null ? 'text-[#00ff00]/60'
                  : !bridgeHealth.reachable ? 'text-[#ff4444]'
                    : bridgeHealth.mt5_connected ? 'text-[#00ff00]'
                      : 'text-[#ff6600]'
              }`}>
                {bridgeHealth == null
                  ? 'PROBING…'
                  : !bridgeHealth.reachable
                    ? 'UNREACHABLE'
                    : bridgeHealth.mt5_connected
                      ? `OK · acct ${bridgeHealth.account ?? '—'}`
                      : 'MT5 OFFLINE'}
              </span>
            </div>
            {bridgeHealth?.error ? (
              <span className="text-[10px] text-[#ff4444]/80 truncate max-w-[40%]">{bridgeHealth.error}</span>
            ) : null}
            {bridgeHealth?.reachable && bridgeHealth?.mt5_connected ? (
              <div className="flex items-center gap-2 text-[10px] tracking-wider w-full pt-1 border-t border-[#00ff00]/15 mt-1">
                <span className="text-[#00ff00]/50">live tick · EURUSD</span>
                {liveTick ? (
                  <>
                    <span className="text-[#00ff00]">bid {liveTick.bid.toFixed(5)}</span>
                    <span className="text-[#00ff00]">ask {liveTick.ask.toFixed(5)}</span>
                    <span className="text-[#ff6600]">spread {(liveTick.spread * 10000).toFixed(1)}p</span>
                  </>
                ) : (
                  <span className="text-[#00ff00]/40">probing…</span>
                )}
              </div>
            ) : null}
          </div>

          {bridges.length === 0 ? (
            <div className="border border-dashed border-[#00ff00]/40 p-3 text-[10px] text-[#00ff00]/60 text-center">
              No bridges configured. Add one to log into MT5.
            </div>
          ) : null}

          {bridges.map((b) => {
            const sl = statusLabel(b);
            const isEditing = editingId === b.id;
            return (
              <div
                key={b.id}
                className={`border ${b.status === 'connected' ? 'border-[#00ff00]' : 'border-[#00ff00]/30'} bg-black/50 p-3 space-y-2`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    {b.status === 'connected' && <CheckCircle2 className="w-3.5 h-3.5 text-[#00ff00]" />}
                    <span className="text-[#00ff00] text-xs tracking-wider">{b.name}</span>
                    <span className="text-[10px] text-[#00ff00]/60">login {maskLogin(b.config.login as string | undefined)}</span>
                    {b.config.server ? (
                      <span className="text-[10px] text-[#00ff00]/40">· {String(b.config.server)}</span>
                    ) : null}
                    <span className={`text-[10px] tracking-wider ${sl.cls}`}>
                      {b.status === 'connecting' && <Loader2 className="w-3 h-3 inline animate-spin mr-1" />}
                      [ {sl.text} ]
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {b.status === 'connected' ? (
                      <button
                        onClick={() => actions.disconnectBroker(b.id)}
                        className="border border-[#ff4444] text-[#ff4444] px-2 py-1 text-[10px] tracking-wider hover:bg-[#ff444411] transition-colors"
                      >
                        [ DISCONNECT ]
                      </button>
                    ) : (
                      <button
                        onClick={() => useBridge(b)}
                        disabled={b.status === 'connecting'}
                        className="border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider hover:bg-[#00ff0011] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        [ {b.status === 'connecting' ? 'CONNECTING…' : 'USE'} ]
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (isEditing) {
                          cancelForm();
                        } else {
                          setForm({
                            name: b.name,
                            login: String(b.config.login ?? ''),
                            password: String(b.config.password ?? ''),
                            server: String(b.config.server ?? ''),
                          });
                          setEditingId(b.id);
                          setAddOpen(false);
                        }
                      }}
                      title="Edit credentials"
                      className="p-1 border border-[#ff6600] text-[#ff6600] hover:bg-[#ff660011] transition-colors"
                    >
                      <Settings2 className="w-3 h-3" />
                    </button>
                    {!isBuiltIn(b.id) && (
                      <button
                        onClick={() => actions.removeBroker(b.id)}
                        title="Remove bridge"
                        className="p-1 border border-[#ff4444]/60 text-[#ff4444]/80 hover:bg-[#ff444411] transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {b.lastError ? (
                  <div className="text-[10px] text-[#ff4444] border border-[#ff4444]/50 bg-black/80 px-2 py-1">
                    {b.lastError}
                  </div>
                ) : null}

                {isEditing ? (
                  <div className="border border-[#ff6600]/50 p-2 space-y-1.5">
                    <input
                      type="text"
                      placeholder="Bridge name"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
                    />
                    <input
                      type="text"
                      placeholder="MT5 login (account number)"
                      value={form.login}
                      onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
                    />
                    <input
                      type="password"
                      placeholder="MT5 password"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
                    />
                    <input
                      type="text"
                      placeholder="MT5 server (e.g. Exness-Real42; optional)"
                      value={form.server}
                      onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
                      className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
                    />
                    <div className="flex gap-2">
                      <button onClick={() => saveBridgeEdit(b.id)} className="flex-1 border border-[#00ff00] text-[#00ff00] py-1 text-[10px] tracking-wider hover:bg-[#00ff0011] transition-colors">
                        [ SAVE ]
                      </button>
                      <button onClick={cancelForm} className="border border-[#ff6600] text-[#ff6600] py-1 px-3 text-[10px] tracking-wider hover:bg-[#ff660011] transition-colors">
                        [ CANCEL ]
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {addOpen ? (
          <div className="mt-3 p-3 border border-[#ff6600]/50 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#ff6600] tracking-wider">[ NEW BRIDGE ]</span>
              <button onClick={cancelForm} className="text-[#ff6600] hover:text-[#ff8833]"><X className="w-3 h-3" /></button>
            </div>
            <input
              type="text"
              placeholder="Bridge name (e.g. Exness Demo, Live Prop A1)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
            />
            <input
              type="text"
              placeholder="MT5 login (account number)"
              value={form.login}
              onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
            />
            <input
              type="password"
              placeholder="MT5 password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
            />
            <input
              type="text"
              placeholder="MT5 server (e.g. Exness-Real42; optional)"
              value={form.server}
              onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] tracking-wider focus:outline-none focus:border-[#00ff00] focus:shadow-[0_0_4px_rgba(0,255,0,0.4)]"
            />
            <div className="flex gap-2 pt-1">
              <button onClick={handleAddBridge} disabled={!form.name.trim()} className="flex-1 border border-[#00ff00] text-[#00ff00] py-1 text-[10px] tracking-wider hover:bg-[#00ff0011] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                [ ADD BRIDGE ]
              </button>
              <button onClick={cancelForm} className="border border-[#ff6600] text-[#ff6600] py-1 px-3 text-[10px] tracking-wider hover:bg-[#ff660011] transition-colors">
                [ CANCEL ]
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setAddOpen(true); setEditingId(null); setForm(EMPTY_FORM); }}
            className="mt-3 w-full flex items-center justify-center gap-2 border border-dashed border-[#00ff00]/60 text-[#00ff00]/80 py-2 text-[10px] tracking-wider hover:bg-[#00ff0008] hover:border-[#00ff00] hover:text-[#00ff00] transition-colors"
          >
            <Plus className="w-3 h-3" /> [ ADD BRIDGE ]
          </button>
        )}

        <div className="mt-3 text-[10px] text-[#00ff00]/50 border-t border-[#00ff00]/40 pt-2 leading-relaxed">
          One bridge runtime hosts one MT5 login at a time. <span className="text-[#00ff00]/70">[ USE ]</span> on any bridge re-logs the runtime with that bridge&apos;s credentials. The previously active bridge becomes IDLE. See <span className="text-[#ff6600]/80">bridge/SETUP_RUNBOOK.md</span> for VM provisioning.
        </div>
      </div>
    </div>
  );
}
