/**
 * Bot Registry: table of all bots per instrument with deploy/undeploy controls.
 * Standalone section (not in Instrument Registry). Supports individual and collective toggle.
 */

import { Zap, ZapOff, Bot, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useTradingStore } from '../store/TradingStore';

function statusLabel(status: string): string {
  switch (status) {
    case 'deployed':
      return 'DEPLOYED';
    case 'ready':
      return 'READY';
    case 'building':
      return 'BUILDING';
    case 'outdated':
      return 'OUTDATED';
    default:
      return status.toUpperCase();
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'deployed':
      return 'text-[#00ff00]';
    case 'ready':
      return 'text-[#ffff00]';
    case 'building':
      return 'text-[#ff6600]';
    case 'outdated':
      return 'text-[#ff6600]/80';
    default:
      return 'text-[#00ff00]/70';
  }
}

export function BotsOverview() {
  const { state, actions } = useTradingStore();
  const { bots, instruments, portfolio, brokers } = state;
  const selectedInstrumentId = instruments.find((i) => i.selected)?.id ?? null;

  /** Only bots that have actually been built (ready, deployed, building, or outdated with nnFeatureVector). */
  const builtBots = bots.filter(
    (b) =>
      ['ready', 'deployed', 'building'].includes(b.status) ||
      (b.status === 'outdated' && (b.nnFeatureVector?.length ?? 0) > 0)
  );
  const selectedBot = selectedInstrumentId ? builtBots.find((b) => b.instrumentId === selectedInstrumentId) : null;
  const canDeploySelected = selectedBot?.status === 'ready';
  const readyCount = builtBots.filter((b) => b.status === 'ready').length;
  const deployedCount = builtBots.filter((b) => b.status === 'deployed').length;
  const buildingCount = builtBots.filter((b) => b.status === 'building').length;
  const canDeployAll = readyCount > 0;
  const canUndeployAll = deployedCount > 0;

  const selectInstrument = (instrumentId: string) => {
    actions.setSelectedInstrument(instrumentId);
  };

  const sortedBots = [...builtBots].sort((a, b) => {
    const statusOrder = { deployed: 0, building: 1, ready: 2, outdated: 3 };
    const aOrder = statusOrder[a.status as keyof typeof statusOrder] ?? 4;
    const bOrder = statusOrder[b.status as keyof typeof statusOrder] ?? 4;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (a.instrumentSymbol ?? '').localeCompare(b.instrumentSymbol ?? '');
  });

  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[10px] text-[#00ff00] opacity-70">&gt; BOTS ({builtBots.length})</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => selectedBot && actions.deployBot(selectedBot.id)}
            disabled={!canDeploySelected}
            className="text-[10px] border-2 border-[#ff6600] text-[#ff6600] px-2 py-1 hover:bg-[#ff660011] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Zap className="w-3 h-3" />
            Deploy
          </button>
          <button
            type="button"
            onClick={() => actions.deployAllReadyBots()}
            disabled={!canDeployAll}
            className="text-[10px] border border-[#00ff00] text-[#00ff00] px-2 py-1 hover:bg-[#00ff0011] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Zap className="w-3 h-3" />
            Deploy all
          </button>
          <button
            type="button"
            onClick={() => actions.undeployAllBots()}
            disabled={!canUndeployAll}
            className="text-[10px] border border-[#ff6600] text-[#ff6600] px-2 py-1 hover:bg-[#ff660011] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <ZapOff className="w-3 h-3" />
            Undeploy all
          </button>
          <button
            type="button"
            onClick={() => actions.deleteAllBots()}
            disabled={sortedBots.length === 0}
            className="text-[10px] border border-[#ff4444] text-[#ff4444] px-2 py-1 hover:bg-[#ff444411] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            Delete all
          </button>
        </div>
      </div>

      <div className="overflow-x-auto max-h-48 overflow-y-auto scrollbar-hide">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-[#00ff00] opacity-70 border-b border-[#00ff00]/30">
              <th className="text-left py-1.5 font-normal">SYMBOL</th>
              <th className="text-left py-1.5 font-normal">STATUS</th>
              <th className="text-center py-1.5 font-normal w-10">POS</th>
              <th className="text-center py-1.5 font-normal w-8"></th>
            </tr>
          </thead>
          <tbody>
            {sortedBots.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-center text-[10px] text-[#ff6600]/90">
                  No built bots yet. Use [ BOT BUILDER ] above: select instrument, run backtest, then [ BUILD ].
                </td>
              </tr>
            ) : (
            sortedBots.map((bot) => {
              const inst = instruments.find((i) => i.id === bot.instrumentId);
              const isSelected = bot.instrumentId === selectedInstrumentId;
              const positionCount = portfolio.positions.filter((p) => p.botId === bot.id).length;
              const brokerConnected = inst?.brokerId
                ? brokers.find((b) => b.id === inst.brokerId)?.status === 'connected'
                : false;

              return (
                <tr
                  key={bot.id}
                  onClick={() => selectInstrument(bot.instrumentId)}
                  className={`border-b border-[#00ff00]/10 hover:bg-[#00ff0008 cursor-pointer transition-colors ${
                    isSelected ? 'bg-[#00ff0015]' : ''
                  }`}
                >
                  <td className="py-1.5">
                    <div className="flex items-center gap-1">
                      <Bot className="w-3 h-3 text-[#ff6600] flex-shrink-0" />
                      <span className={isSelected ? 'text-[#00ff00] font-medium' : 'text-[#00ff00]/90'}>
                        {bot.instrumentSymbol ?? inst?.symbol ?? bot.instrumentId}
                      </span>
                      {!brokerConnected && inst && (
                        <span className="text-[#ff6600]/70">
                          <AlertTriangle className="w-2.5 h-2.5" />
                        </span>
                      )}
                      {bot.lastError && (
                        <span className="text-[#ff4444]">
                          <AlertTriangle className="w-2.5 h-2.5" />
                        </span>
                      )}
                      {bot.driftDetectedAt && !bot.lastError && (
                        <span className="text-[#ffaa00]">
                          <AlertTriangle className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`py-1.5 ${statusColor(bot.status)}`}>
                    {bot.status === 'building' ? (
                      <span className="flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {bot.buildProgress}%
                      </span>
                    ) : (
                      statusLabel(bot.status)
                    )}
                  </td>
                  <td className="py-1.5 text-center text-[#00ff00]/80 w-10 tabular-nums">
                    {positionCount > 0 ? positionCount : '—'}
                  </td>
                  <td className="py-1.5 text-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.deleteBot(bot.id);
                      }}
                      className="text-[#ff4444]/70 hover:text-[#ff4444] p-0.5"
                      title="Delete bot"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              );
            })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-[9px] text-[#00ff00]/50 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>Click row to select instrument</span>
        {deployedCount > 0 && (
          <span>
            {deployedCount} deployed · Global: BOT EXECUTION {state.execution.enabled ? 'ON' : 'OFF'}
          </span>
        )}
        {buildingCount > 0 && <span>{buildingCount} building</span>}
      </div>
    </>
  );
}
