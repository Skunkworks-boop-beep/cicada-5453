/**
 * Multi-broker management: Deriv and eXness as defaults; add/connect/disconnect brokers.
 * Execution is routed per instrument via instrument.brokerId.
 */

import { useEffect, useState, useMemo } from 'react';
import { useTradingStore } from '../store/TradingStore';
import type { BrokerConfig, BrokerType } from '../core/types';
import { BROKER_DERIV_ID, BROKER_EXNESS_ID, BROKER_EXNESS_API_ID } from '../core/registries';
import {
  getActiveSyntheticSymbols,
  validateDerivSynthetics,
  isConnected as derivIsConnected,
  type DerivSyntheticGroup,
  type DerivSyntheticValidation,
} from '../core/derivApi';
import { getBridgeHealth, type BridgeHealth } from '../core/api';
import { Server, Plus, Settings2, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
function statusColor(status: string) {
  switch (status) {
    case 'connected': return 'text-[#00ff00]';
    case 'connecting': return 'text-[#ffaa00]';
    case 'error': return 'text-[#ff4444]';
    default: return 'text-[#00ff00] opacity-60';
  }
}

function typeLabel(type: BrokerType) {
  if (type === 'exness_api') return 'eXness API (data-only)';
  if (type === 'mt5') return 'MT5';
  return 'Deriv API (data-only)';
}

const DERIV_GROUP_ORDER: DerivSyntheticGroup[] = [
  'Volatility', 'Crash/Boom', 'Jump', 'Step', 'Range Break', 'World', 'Uncategorized',
];

export function BrokersManager() {
  const { state, actions } = useTradingStore();
  const { brokers, instruments } = state;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'mt5' as BrokerType, login: '', password: '', server: '', appId: '', apiKey: '', baseUrl: '' });
  const [derivApiResult, setDerivApiResult] = useState<Awaited<ReturnType<typeof getActiveSyntheticSymbols>> | null>(null);
  const [derivValidationLoading, setDerivValidationLoading] = useState(false);
  const [derivValidationError, setDerivValidationError] = useState<string | null>(null);
  // Stage 2A: bridge health pill (polled, no global store coupling)
  const [bridge, setBridge] = useState<BridgeHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const h = await getBridgeHealth();
      if (!cancelled) setBridge(h);
    };
    void tick();
    const id = setInterval(() => void tick(), 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  /** Validation is derived from current instruments + last API result so it updates when instruments change (e.g. after Add all). */
  const derivValidation = useMemo((): DerivSyntheticValidation | null => {
    if (!derivApiResult) return null;
    return validateDerivSynthetics(instruments, derivApiResult);
  }, [derivApiResult, instruments]);

  const derivConnected = brokers.find((b) => b.id === BROKER_DERIV_ID)?.status === 'connected';

  const isDefault = (id: string) => id === BROKER_DERIV_ID || id === BROKER_EXNESS_ID || id === BROKER_EXNESS_API_ID;
  const isMt5Addon = (id: string) => id === BROKER_EXNESS_ID;
  const instrumentCount = (brokerId: string) => instruments.filter((i) => i.brokerId === brokerId).length;
  /** MT5 add-on: show 0 instruments until connected and fetched from MT5; eXness/Deriv show registry count. */
  const displayInstrumentCount = (b: BrokerConfig) =>
    b.id === BROKER_EXNESS_ID && b.status !== 'connected' ? 0 : instrumentCount(b.id);

  const refreshDerivSynthetics = async () => {
    const derivBroker = brokers.find((b) => b.id === BROKER_DERIV_ID);
    const hasDerivCreds = derivBroker?.config.appId && derivBroker?.config.password;
    if (!derivBroker || (!derivConnected && !hasDerivCreds)) return;
    setDerivValidationError(null);
    setDerivValidationLoading(true);
    try {
      if (derivConnected && !derivIsConnected()) {
        await actions.connectBroker(BROKER_DERIV_ID);
      }
      const apiResult = await getActiveSyntheticSymbols();
      setDerivApiResult(apiResult);
    } catch (e) {
      setDerivValidationError(e instanceof Error ? e.message : 'Failed to fetch Deriv symbols');
      setDerivApiResult(null);
    } finally {
      setDerivValidationLoading(false);
    }
  };

  const handleConnect = async (b: BrokerConfig) => {
    if (b.type === 'exness_api') {
      if (b.config.apiKey) {
        await actions.connectBroker(b.id, b.config);
      } else {
        setForm((f) => ({ ...f, apiKey: b.config.apiKey ?? '', baseUrl: b.config.baseUrl ?? '' }));
        setEditingId(b.id);
      }
    } else if (b.type === 'mt5') {
      const hasCreds = b.config.login || b.config.password;
      if (hasCreds) {
        await actions.connectBroker(b.id, b.config);
      } else {
        setForm((f) => ({ ...f, login: b.config.login ?? '', password: b.config.password ?? '', server: b.config.server ?? '' }));
        setEditingId(b.id);
      }
    } else {
      if (b.config.appId && b.config.password) {
        await actions.connectBroker(b.id, b.config);
      } else {
        setForm((f) => ({ ...f, appId: b.config.appId ?? '', password: b.config.password ?? '' }));
        setEditingId(b.id);
      }
    }
  };

  const handleSaveCredentials = async (id: string) => {
    const b = brokers.find((x) => x.id === id);
    if (!b) return;
    if (b.type === 'exness_api') {
      await actions.connectBroker(id, { apiKey: form.apiKey, baseUrl: form.baseUrl || undefined });
    } else if (b.type === 'mt5') {
      await actions.connectBroker(id, { login: form.login, password: form.password, server: form.server });
    } else {
      await actions.connectBroker(id, { appId: form.appId, password: form.password });
    }
    setForm({ name: '', type: 'mt5', login: '', password: '', server: '', appId: '', apiKey: '', baseUrl: '' });
    setEditingId(null);
  };

  /** Save credentials only (no connect). User clicks Connect separately. */
  const handleSaveOnly = (id: string) => {
    const b = brokers.find((x) => x.id === id);
    if (!b) return;
    if (b.type === 'exness_api') {
      actions.updateBroker(id, { config: { ...b.config, apiKey: form.apiKey, baseUrl: form.baseUrl || undefined } });
    } else if (b.type === 'mt5') {
      actions.updateBroker(id, { config: { ...b.config, login: form.login, password: form.password, server: form.server } });
    } else {
      actions.updateBroker(id, { config: { ...b.config, appId: form.appId, password: form.password } });
    }
    setForm({ name: '', type: 'mt5', login: '', password: '', server: '', appId: '', apiKey: '', baseUrl: '' });
    setEditingId(null);
  };

  const handleAddBroker = () => {
    if (!form.name.trim()) return;
    const id = 'broker-' + form.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const config = form.type === 'exness_api'
      ? { apiKey: form.apiKey, baseUrl: form.baseUrl || undefined }
      : form.type === 'mt5'
        ? { login: form.login, password: form.password, server: form.server }
        : { appId: form.appId, password: form.password };
    actions.addBroker({
      id,
      name: form.name.trim(),
      type: form.type,
      status: 'disconnected',
      config,
      order: brokers.length,
    });
    setForm({ name: '', type: 'mt5', login: '', password: '', server: '', appId: '', apiKey: '', baseUrl: '' });
    setAddOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-[10px] mb-1">
        <Server className="w-3.5 h-3.5" />
        <span>[ BROKERS ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span>Deriv & eXness: standalone. MT5 add-on: live balance/positions.</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]" />
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]" />
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]" />
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]" />

        <div className="space-y-3">
          {/* Stage 2A: MT5 BRIDGE pill — first row, same visual recipe as broker rows */}
          <div className="border border-[#00ff00]/40 bg-black/50 p-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className={`flex items-center gap-1.5 font-medium text-xs ${
                bridge?.reachable ? 'text-[#00ff00]' : 'text-[#ff6600]'
              }`}>
                {bridge?.reachable ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                MT5 BRIDGE
              </span>
              <span className="text-[10px] text-[#ff6600]">(localhost:5000 → Windows VM)</span>
              <span className={`text-[10px] ${
                bridge == null ? 'text-[#00ff00]/60'
                  : !bridge.reachable ? 'text-[#ff4444]'
                    : bridge.mt5_connected ? 'text-[#00ff00]'
                      : 'text-[#ff6600]'
              }`}>
                {bridge == null
                  ? 'PROBING...'
                  : !bridge.reachable
                    ? 'BRIDGE UNREACHABLE'
                    : bridge.mt5_connected
                      ? `BRIDGE OK · ${bridge.account ?? '—'}`
                      : 'MT5 OFFLINE INSIDE VM'}
              </span>
            </div>
            {bridge?.error ? (
              <span className="text-[10px] text-[#ff4444]/80 truncate max-w-[40%]">{bridge.error}</span>
            ) : null}
          </div>
          {brokers.map((b) => (
            <div
              key={b.id}
              className="border border-[#00ff00]/40 bg-black/50 p-3 flex flex-wrap items-center justify-between gap-2"
            >
              <div className="flex items-center gap-3">
                <span className="text-[#00ff00] font-medium text-xs">{b.name}</span>
                <span className="text-[10px] text-[#ff6600]">({typeLabel(b.type)})</span>
                <span className={`text-[10px] ${statusColor(b.status)}`}>
                  {b.status === 'connecting' && <Loader2 className="w-3 h-3 inline animate-spin mr-1" />}
                  {b.status.toUpperCase()}
                </span>
                <span className="text-[10px] text-[#00ff00]/60">{displayInstrumentCount(b)} instruments</span>
              </div>
              {isMt5Addon(b.id) && (b.config.login || b.config.password) && b.status !== 'connected' && (
                <div className="w-full text-[10px] text-[#00ff00]/80">
                  Uses MT5 account from login. Connect to use this account, or set credentials to switch.
                </div>
              )}
              {b.lastError && (
                <div className="w-full text-[10px] text-[#ff4444] border border-[#ff4444]/50 bg-black/80 px-2 py-1">
                  {b.lastError}
                </div>
              )}
              {editingId === b.id && b.type === 'mt5' && (
                <div className="w-full grid grid-cols-2 gap-2 mt-2 p-2 border border-[#ff6600]/50">
                  <input type="text" placeholder="Login (account)" value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
                  <input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
                  <input type="text" placeholder="Server (optional)" value={form.server} onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs col-span-2" />
                  <div className="col-span-2 flex gap-2">
                    <button onClick={() => handleSaveOnly(b.id)} className="flex-1 border border-[#00ff00] text-[#00ff00] py-1 px-2 text-xs hover:bg-[#00ff0011]">Save</button>
                    <button onClick={() => { setEditingId(null); setForm({ name: '', type: 'mt5', login: '', password: '', server: '', appId: '' }); }} className="border border-[#ff6600] text-[#ff6600] py-1 text-xs px-2 hover:bg-[#ff660011]">Cancel</button>
                  </div>
                </div>
              )}
              {editingId === b.id && b.type === 'exness_api' && (
                <div className="w-full grid grid-cols-2 gap-2 mt-2 p-2 border border-[#ff6600]/50">
                  <input type="password" placeholder="API key (Exness Personal Area → API)" value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs col-span-2" />
                  <input type="text" placeholder="Base URL (optional, e.g. https://api.exness.com)" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs col-span-2" />
                  <div className="col-span-2 flex gap-2">
                    <button onClick={() => handleSaveOnly(b.id)} className="flex-1 border border-[#00ff00] text-[#00ff00] py-1 px-2 text-xs hover:bg-[#00ff0011]">Save</button>
                    <button onClick={() => { setEditingId(null); setForm((f) => ({ ...f, apiKey: '', baseUrl: '' })); }} className="border border-[#ff6600] text-[#ff6600] py-1 text-xs px-2 hover:bg-[#ff660011]">Cancel</button>
                  </div>
                </div>
              )}
              {editingId === b.id && b.type === 'deriv_api' && (
                <div className="w-full grid grid-cols-2 gap-2 mt-2 p-2 border border-[#ff6600]/50">
                  <input type="text" placeholder="App ID (api.deriv.com)" value={form.appId} onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs col-span-2" />
                  <input type="password" placeholder="Token (Personal Access Token)" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs col-span-2" />
                  <div className="col-span-2 flex gap-2">
                    <button onClick={() => handleSaveOnly(b.id)} className="flex-1 border border-[#00ff00] text-[#00ff00] py-1 px-2 text-xs hover:bg-[#00ff0011]">Save</button>
                    <button onClick={() => { setEditingId(null); setForm((f) => ({ ...f, appId: '', password: '' })); }} className="border border-[#ff6600] text-[#ff6600] py-1 text-xs px-2 hover:bg-[#ff660011]">Cancel</button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-1">
                {(b.type === 'mt5' || b.type === 'deriv_api' || b.type === 'exness_api') && b.status !== 'connected' && (
                    <button
                    onClick={() => {
                      if (b.type === 'exness_api') setForm((f) => ({ ...f, apiKey: b.config.apiKey ?? '', baseUrl: b.config.baseUrl ?? '' }));
                      else if (b.type === 'mt5') setForm((f) => ({ ...f, login: b.config.login ?? '', password: b.config.password ?? '', server: b.config.server ?? '' }));
                      else setForm((f) => ({ ...f, appId: b.config.appId ?? '', password: b.config.password ?? '' }));
                      setEditingId(editingId === b.id ? null : b.id);
                    }}
                    className="p-1 border border-[#ff6600] text-[#ff6600] hover:bg-[#ff660011] text-[10px] transition-all duration-200"
                  >
                    <Settings2 className="w-3 h-3" />
                  </button>
                )}
                {(b.type === 'mt5' || b.type === 'exness_api') && b.status === 'connected' && (
                    <button
                    onClick={() => {
                      if (b.type === 'exness_api') setForm((f) => ({ ...f, apiKey: b.config.apiKey ?? '', baseUrl: b.config.baseUrl ?? '' }));
                      else setForm((f) => ({ ...f, login: b.config.login ?? '', password: b.config.password ?? '', server: b.config.server ?? '' }));
                      setEditingId(editingId === b.id ? null : b.id);
                    }}
                    className="p-1 border border-[#ff6600]/60 text-[#ff6600]/80 hover:bg-[#ff660008] text-[10px] transition-all duration-200"
                  >
                    <Settings2 className="w-3 h-3" />
                  </button>
                )}
                {b.status === 'connected' ? (
                  <button
                      onClick={() => actions.disconnectBroker(b.id)}
                      className="border border-[#ff4444] text-[#ff4444] px-2 py-1 text-[10px] hover:bg-[#ff444411] transition-all duration-200"
                    >
                      Disconnect
                    </button>
                ) : (
                  <button
                      onClick={() => handleConnect(b)}
                      disabled={b.status === 'connecting'}
                      className="flex items-center gap-1.5 border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] hover:bg-[#00ff0011] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all duration-200"
                    >
                      {b.status === 'connecting' ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      {b.status === 'connecting' ? 'Connecting…' : 'Connect'}
                    </button>
                )}
                {!isDefault(b.id) && (
                  <button
                      onClick={() => actions.removeBroker(b.id)}
                      className="border border-[#ff6600] text-[#ff6600] px-2 py-1 text-[10px] hover:bg-[#ff660011] transition-all duration-200"
                    >
                      Remove
                    </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {derivConnected && (
          <div className="mt-3 p-3 border border-[#00ff00]/40 bg-black/30">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <span className="text-[#00ff00] text-[10px]">Deriv synthetic instruments (validated via API)</span>
              <button
                  onClick={refreshDerivSynthetics}
                  disabled={derivValidationLoading}
                  className="flex items-center gap-1 border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] hover:bg-[#00ff0011] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all duration-200"
                >
                  <RefreshCw className={`w-3 h-3 ${derivValidationLoading ? 'animate-spin' : ''}`} />
                  {derivValidationLoading ? 'Fetching…' : 'Refresh'}
                </button>
            </div>
            {derivValidationError && (
              <div className="text-[10px] text-[#ff4444] mb-2">{derivValidationError}</div>
            )}
            {derivValidation && derivApiResult && (
              <>
                <div className="text-[10px] border-b border-[#00ff00]/30 pb-2 mb-2">
                  <div className="text-[#00ff00] font-medium mb-1">Instrument codes from Deriv API (use these in registry)</div>
                  {DERIV_GROUP_ORDER.map((group) => {
                    const apiCodes = derivApiResult.byGroup[group];
                    if (!apiCodes?.length) return null;
                    return (
                      <div key={group} className="mb-1">
                        <span className="text-[#00ff00]/90">{group}:</span>
                        <span className="text-[#00ff00]/80 ml-1">{apiCodes.slice(0, 20).join(', ')}{apiCodes.length > 20 ? ` (+${apiCodes.length - 20} more)` : ''}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="text-[10px] space-y-1 mb-2">
                  <div className="text-[#00ff00]/90 font-medium mb-1">Verification (registry vs API codes above)</div>
                  {DERIV_GROUP_ORDER.map((group) => {
                    const g = derivValidation.byGroup[group];
                    if (!g || g.total === 0) return null;
                    const ok = g.validated === g.total;
                    return (
                      <div key={group} className={`flex justify-between ${ok ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
                        <span>{group}:</span>
                        <span>{g.validated}/{g.total} validated{g.missing.length ? ` (missing: ${g.missing.join(', ')})` : ''}</span>
                      </div>
                    );
                  })}
                </div>
                {derivValidation.apiSymbolsNotInApp.length > 0 && (
                  <div className="text-[10px] border-t border-[#00ff00]/30 pt-2 mt-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[#ff6600]">On Deriv but not in app ({derivValidation.apiSymbolsNotInApp.length}):</span>
                    <button
                        onClick={() => {
                          if (!derivValidation) return;
                          actions.addInstrumentsFromDeriv(derivValidation.apiSymbolsNotInApp);
                          // Validation updates automatically: it's derived from instruments + derivApiResult, and instruments just changed.
                        }}
                          className="border border-[#00ff00] text-[#00ff00] px-2 py-0.5 text-[10px] hover:bg-[#00ff0011] transition-all duration-200"
                        >
                          Add all to Instrument Registry
                        </button>
                    </div>
                    <span className="text-[#00ff00]/80 block">{derivValidation.apiSymbolsNotInApp.slice(0, 15).join(', ')}{derivValidation.apiSymbolsNotInApp.length > 15 ? ` +${derivValidation.apiSymbolsNotInApp.length - 15} more` : ''}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {addOpen ? (
          <div className="mt-3 p-3 border border-[#ff6600]/50 space-y-2">
            <input
              type="text"
              placeholder="Broker name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs"
            />
            <div className="flex items-center gap-4 text-xs">
              <span className="text-[#00ff00] opacity-80">Connect via:</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="brokerType" checked={form.type === 'exness_api'} onChange={() => setForm((f) => ({ ...f, type: 'exness_api' }))} className="accent-[#00ff00]" />
                <span className="text-[#00ff00]">eXness API</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="brokerType" checked={form.type === 'deriv_api'} onChange={() => setForm((f) => ({ ...f, type: 'deriv_api' }))} className="accent-[#00ff00]" />
                <span className="text-[#00ff00]">Deriv API</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="brokerType" checked={form.type === 'mt5'} onChange={() => setForm((f) => ({ ...f, type: 'mt5' }))} className="accent-[#00ff00]" />
                <span className="text-[#ff6600]">MT5</span>
              </label>
            </div>
            {form.type === 'exness_api' && (
              <>
                <input type="password" placeholder="API key (Exness Personal Area → API)" value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
                <input type="text" placeholder="Base URL (optional)" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
              </>
            )}
            {form.type === 'mt5' && (
              <>
                <input type="text" placeholder="Login" value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
                <input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
                <input type="text" placeholder="Server (optional)" value={form.server} onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
              </>
            )}
            {form.type === 'deriv_api' && (
              <>
                <input type="text" placeholder="App ID (api.deriv.com)" value={form.appId} onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
                <input type="password" placeholder="Token (Personal Access Token)" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1 text-xs" />
              </>
            )}
            <div className="flex gap-2">
              <button onClick={handleAddBroker} className="flex-1 border border-[#00ff00] text-[#00ff00] py-1.5 px-3 text-xs hover:bg-[#00ff0011]">Add broker</button>
              <button onClick={() => { setAddOpen(false); setForm({ name: '', type: 'mt5', login: '', password: '', server: '', appId: '', apiKey: '', baseUrl: '' }); }} className="border border-[#ff6600] text-[#ff6600] py-1.5 px-3 text-xs hover:bg-[#ff660011]">Cancel</button>
            </div>
          </div>
        ) : (
          <button
              onClick={() => setAddOpen(true)}
              className="mt-3 w-full flex items-center justify-center gap-2 border border-dashed border-[#00ff00]/60 text-[#00ff00]/80 py-3 px-4 text-xs hover:bg-[#00ff0008]"
            >
              <Plus className="w-3.5 h-3.5" /> Add broker
            </button>
        )}

        <div className="mt-3 text-[10px] text-[#00ff00] opacity-50 border-t border-[#00ff00] pt-2">
          Defaults: Deriv (API), eXness (API key from Personal Area), MT5 add-on. Connect via API or MT5 as needed.
        </div>
      </div>
    </div>
  );
}
