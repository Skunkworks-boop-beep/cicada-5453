/**
 * Optional remote server for offload. Login with username, IP, password.
 * When no server is set, use this machine (default). When connected, all backend
 * requests (bot build, MT5 connect/status/OHLC) use getNnApiBaseUrl() and go to
 * the remote server — production, no simulation.
 */

import { useState } from 'react';
import { Server, Cpu, Cloud, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { getRemoteServerUrl, setRemoteServerUrl, getNnApiBaseUrl, isLocalBackendUrl } from '../core/config';
import { testServerConnection } from '../core/api';

const DEFAULT_PORT = '8000';

function buildServerUrl(host: string, port: string): string {
  const h = host.trim();
  const p = (port.trim() || DEFAULT_PORT).replace(/^\D+/, '');
  const portNum = p ? parseInt(p, 10) : 8000;
  const safePort = Number.isFinite(portNum) && portNum > 0 && portNum < 65536 ? portNum : 8000;
  const hasScheme = /^https?:\/\//i.test(h);
  const hostOnly = h.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  return hasScheme ? `${h.split('/')[0]}:${safePort}` : `http://${hostOnly}:${safePort}`;
}

export function ServerOffload() {
  const [username, setUsername] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [, setTick] = useState(0);

  const handleUseThisMachine = () => {
    setRemoteServerUrl(null);
    setUsername('');
    setIpAddress('');
    setPassword('');
    setPort(DEFAULT_PORT);
    setMessage(null);
    setTick((t) => t + 1);
  };

  const handleConnect = async () => {
    const user = username.trim();
    const ip = ipAddress.trim();
    const pass = password;
    const p = port.trim() || DEFAULT_PORT;

    setMessage(null);

    if (!user) {
      setMessage({ type: 'error', text: 'Enter username.' });
      return;
    }
    if (!ip) {
      setMessage({ type: 'error', text: 'Enter server IP or hostname.' });
      return;
    }
    if (!pass) {
      setMessage({ type: 'error', text: 'Enter password.' });
      return;
    }

    const baseUrl = buildServerUrl(ip, p);
    setConnecting(true);
    try {
      const result = await testServerConnection(baseUrl, {
        timeoutMs: 12_000,
        username: user,
        password: pass,
      });
      if (result.success) {
        setRemoteServerUrl(baseUrl);
        setMessage({ type: 'success', text: `${result.message} (user: ${user})` });
        setTick((t) => t + 1);
      } else {
        setMessage({ type: 'error', text: result.message });
      }
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof Error ? e.message : 'Connection failed.',
      });
    } finally {
      setConnecting(false);
    }
  };

  const remote = getRemoteServerUrl();
  const isOffloading = remote != null && remote.length > 0 && !isLocalBackendUrl(remote);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <Server className="w-3.5 h-3.5" />
        <span>[ SERVER / OFFLOAD ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="text-[10px]">Username, IP, password — connect to remote server</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]" />
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]" />
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]" />
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]" />

        <div className="space-y-3">
          <div className={`flex items-center gap-2 px-2 py-1.5 border text-[10px] font-medium ${isOffloading ? 'border-[#ff6600] bg-[#ff660008] text-[#ff6600]' : 'border-[#00ff00] bg-[#00ff0008] text-[#00ff00]'}`}>
            {isOffloading ? (
              <>
                <Cloud className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Offloading to: {remote}</span>
              </>
            ) : (
              <>
                <Cpu className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Using this machine — backend: {getNnApiBaseUrl()}</span>
              </>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-[#00ff00] text-[10px] block">Server login (optional — to offload to remote)</label>
            <input
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setMessage(null); }}
              placeholder="Username"
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1.5 text-xs placeholder:text-[#00ff00]/40 focus:outline-none focus:ring-1 focus:ring-[#00ff00]"
              autoComplete="username"
            />
            <input
              type="text"
              value={ipAddress}
              onChange={(e) => { setIpAddress(e.target.value); setMessage(null); }}
              placeholder="IP address or hostname"
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1.5 text-xs placeholder:text-[#00ff00]/40 focus:outline-none focus:ring-1 focus:ring-[#00ff00]"
              autoComplete="off"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setMessage(null); }}
              placeholder="Password"
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1.5 text-xs placeholder:text-[#00ff00]/40 focus:outline-none focus:ring-1 focus:ring-[#00ff00]"
              autoComplete="current-password"
            />
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="Port (default 8000)"
              className="w-full bg-black border border-[#00ff00] text-[#00ff00] px-2 py-1.5 text-xs placeholder:text-[#00ff00]/40 focus:outline-none focus:ring-1 focus:ring-[#00ff00]"
            />
            {message && (
              <div className={`flex items-center gap-2 px-2 py-1.5 border text-[10px] ${message.type === 'success' ? 'border-[#00ff00] bg-[#00ff0008] text-[#00ff00]' : 'border-[#ff4444] bg-[#ff444408] text-[#ff4444]'}`}>
                {message.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                <span>{message.text}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="border border-[#ff6600] text-[#ff6600] px-2 py-1 text-[10px] hover:bg-[#ff660011] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  {connecting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  {connecting ? 'Connecting…' : 'Connect to server'}
                </button>
              <button
                  type="button"
                  onClick={handleUseThisMachine}
                  className="border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] hover:bg-[#00ff0011]"
                >
                  Use this machine
                </button>
            </div>
          </div>

          <div className="text-[10px] text-[#00ff00]/70 border-t border-[#00ff00]/30 pt-2">
            Leave empty to run on this machine. Enter username, IP, and password then Connect to offload to the remote server. Connection is tested before saving.
          </div>
        </div>
      </div>
    </div>
  );
}
