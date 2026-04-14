import { useEffect, useRef } from 'react';
import { Bot, Settings, CheckCircle, Zap, Hammer, XCircle } from 'lucide-react';
import { useTradingStore } from '../store/TradingStore';
import { logLevelToTextClass } from '../core/logTheme';
import { CicadaCheckbox } from './CicadaCheckbox';
import { EtaDisplay } from './EtaDisplay';
import { ALL_TRADE_STYLES, ALL_TIMEFRAMES } from '../core/scope';
import { getWarmupScaleFactor, WARMUP_HOURS, WARMUP_SIZE_SCALE } from '../core/bot';
import { formatRebuildInterval } from '../core/rebuildInterval';

export function BotBuilder() {
  const { state, actions } = useTradingStore();
  const { bots, instruments, strategies, schedule, backtest, botBuildLog } = state;
  const buildLogRef = useRef<HTMLDivElement>(null);
  const activeInstruments = instruments.filter((i) => i.status === 'active');
  const selectedInstrument = instruments.find((i) => i.selected) ?? activeInstruments[0] ?? null;
  const selectedInstrumentId = selectedInstrument?.id ?? null;

  const completedResults = backtest.results.filter((r) => r.status === 'completed');
  const hasBacktestResults = completedResults.length > 0;
  /** Build requires a fully completed backtest (not cancelled). */
  const hasFullBacktest = backtest.status === 'completed' && hasBacktestResults;
  const backtestInstrumentIds = new Set(completedResults.map((r) => r.instrumentId));
  const selectedInstrumentInBacktest = selectedInstrumentId ? backtestInstrumentIds.has(selectedInstrumentId) : false;

  const bot = selectedInstrumentId ? bots.find((b) => b.instrumentId === selectedInstrumentId) : null;
  /** NEXT REBUILD: derived from rebuild schedule (single source of truth); fallback to bot.nextRebuildAt */
  const scheduleEntry = selectedInstrumentId ? schedule.find((e) => e.instrumentId === selectedInstrumentId) : null;
  const nextRebuildDisplay = scheduleEntry?.nextRunAt ?? bot?.nextRebuildAt ?? null;

  useEffect(() => {
    if (selectedInstrumentId && !bot) actions.getOrCreateBot(selectedInstrumentId);
  }, [selectedInstrumentId, bot, actions]);

  useEffect(() => {
    if (bot?.status === 'building' && buildLogRef.current) {
      buildLogRef.current.scrollTop = buildLogRef.current.scrollHeight;
    }
  }, [bot?.status, botBuildLog.length]);

  const startBuild = async () => {
    if (!bot) return;
    await actions.buildBot(bot.id, (p) => {});
  };

  const rebuild = () => bot && actions.rebuildBot(bot.id);

  const allTimeframesSelected = bot ? bot.timeframes.length === ALL_TIMEFRAMES.length : false;
  const noTimeframesSelected = bot ? bot.timeframes.length === 0 : true;

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ BOT BUILDER ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="text-[10px]">Neural bot per instrument · Timeframes · Regimes · Styles</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        {!selectedInstrument ? (
          <div className="text-[#ff6600] text-xs">Select an instrument in Instrument Selection (above) to build or manage its bot.</div>
        ) : !bot ? (
          <div className="text-[#ff6600] text-xs">No bot for this instrument yet. Click [ BUILD ] after running a backtest.</div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#00ff00]">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-[#ff6600]" />
                <span className="text-[#ff6600] text-sm">{bot.name}</span>
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                {bot.status === 'deployed' ? (
                  <span className="text-[#00ff00] flex items-center gap-1"><Zap className="w-3 h-3" /> DEPLOYED</span>
                ) : bot.status === 'building' ? (
                  <span className="text-[#ff6600]">BUILDING... {bot.buildProgress}%</span>
                ) : bot.status === 'ready' ? (
                  <span className="text-[#ffff00]">READY TO DEPLOY</span>
                ) : (
                  <span className="text-[#ff6600]">OUTDATED / BUILD</span>
                )}
              </div>
            </div>

            {bot.lastError && (
              <div className="mb-3 text-[10px] text-[#ff4444] border border-[#ff4444]/50 bg-black/80 px-2 py-1.5">
                {bot.lastError}
              </div>
            )}

            {bot.status === 'deployed' && getWarmupScaleFactor(bot) < 1 && (
              <div className="mb-3 text-[10px] text-[#00ff00]/90 border border-[#00ff00]/50 px-2 py-1.5">
                Cold start: position size scaled to {(WARMUP_SIZE_SCALE * 100).toFixed(0)}% for {WARMUP_HOURS}h after deploy.
              </div>
            )}

            {(botBuildLog.length > 0 || bot.status === 'building') && (
              <div className="mb-4 border border-[#00ff00]/35 bg-black/90">
                <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[#00ff00]/25">
                  <span className="text-[#00ff00] text-[10px] font-mono tracking-tight">[ BUILD LOG ]</span>
                  <span className="text-[#00ff00]/45 text-[9px] hidden sm:inline">
                    Timestamps + [+ms] from session start · echoed to console as [bot-build]
                  </span>
                  <button
                    type="button"
                    onClick={() => actions.clearBotBuildLog()}
                    className="text-[9px] border border-[#ff6600]/60 text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660014]"
                  >
                    CLEAR
                  </button>
                </div>
                <div
                  ref={buildLogRef}
                  className="h-40 max-h-52 overflow-auto p-2 font-mono text-[9px] leading-snug space-y-0.5 scrollbar-hide"
                >
                  {bot.status === 'building' && botBuildLog.length === 0 && (
                    <div className="text-[#00ff00]/50">&gt; Starting…</div>
                  )}
                  {botBuildLog.map((entry, i) => (
                    <div
                      key={`${entry.timestamp}-${i}`}
                      className={`whitespace-pre-wrap break-words ${logLevelToTextClass(entry.level as Parameters<typeof logLevelToTextClass>[0])}`}
                    >
                      <span className="text-[#00ff00]/40">{entry.timestamp.slice(11, 23)}</span>{' '}
                      &gt; {entry.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {bot.status === 'building' && (
              <div className="mb-4">
                <div className="h-2 border border-[#00ff00] bg-black mb-2">
                  <div
                    className="h-full bg-[#00ff00] transition-all shadow-[0_0_10px_rgba(0,255,0,0.5)]"
                    style={{ width: `${bot.buildProgress}%` }}
                  />
                </div>
                <EtaDisplay
                  isActive={true}
                  progress={bot.buildProgress}
                  status="running"
                  fallbackEtaSec={420}
                  label=""
                  className="mt-1"
                />
                {bot.buildProgress >= 52 && bot.buildProgress < 100 && (
                  <div className="text-[10px] text-[#00ff00]/70 mt-1">
                    Training on NN API (PyTorch) — progress advances slowly; large bar sets / detection mode can take several minutes. Not a deadlock.
                  </div>
                )}
              </div>
            )}

            <div className="mb-4">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className="text-[#00ff00] opacity-70 text-[10px]">&gt; TIMEFRAMES (M1 → weekly)</span>
                <span className="text-[#ff6600] text-[10px]">({bot.timeframes.length} selected)</span>
                <button
                  type="button"
                  onClick={() => actions.setBot({ ...bot, timeframes: [...ALL_TIMEFRAMES] })}
                  className={`text-[10px] border border-[#00ff00] text-[#00ff00] px-1.5 py-0.5 hover:bg-[#00ff0011] transition-opacity duration-200 ${allTimeframesSelected ? 'opacity-40 hover:opacity-70' : 'opacity-100'}`}
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => actions.setBot({ ...bot, timeframes: [] })}
                  className={`text-[10px] border border-[#ff6600] text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660011] transition-opacity duration-200 ${noTimeframesSelected ? 'opacity-40 hover:opacity-70' : 'opacity-100'}`}
                >
                  Deselect all
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_TIMEFRAMES.map((tf) => {
                  const selected = bot.timeframes.includes(tf);
                  const instrumentSupports = selectedInstrument?.timeframes.includes(tf) ?? true;
                  return (
                    <div
                      key={tf}
                      className={`flex items-center gap-1.5 border px-2 py-1 transition-colors ${
                        selected ? 'border-[#00ff00] bg-[#00ff0011 text-[#00ff00]' : 'border-[#00ff00]/40 text-[#00ff00]/60 hover:border-[#00ff00]/70'
                      } ${!instrumentSupports ? 'opacity-80' : ''}`}
                    >
                      <CicadaCheckbox
                        checked={selected}
                        onChange={() => {
                          const next = selected
                            ? bot.timeframes.filter((t) => t !== tf)
                            : [...bot.timeframes, tf];
                          actions.setBot({ ...bot, timeframes: next });
                        }}
                        label={tf}
                        size="xs"
                        labelClassName="cursor-pointer"
                      />
                    </div>
                  );
                })}
              </div>
              <div className="text-[10px] text-[#00ff0080] mt-1.5">
                Bots trade each selected TF according to analysed trade mode (scope); scope ↔ TF map in core/scope.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-[10px] mb-4">
              <div>
                <span className="text-[#00ff00] opacity-70">&gt; STYLES: </span>
                <span className="text-[#ff6600]">{bot.styles.join(', ')}</span>
                {bot.styles.length < ALL_TRADE_STYLES.length && (
                  <button
                    type="button"
                    onClick={() => actions.setBot({ ...bot, styles: [...ALL_TRADE_STYLES] })}
                    className="ml-2 text-[10px] border border-[#00ff00] text-[#00ff00] px-1.5 py-0.5 hover:bg-[#00ff0011]"
                  >
                    Use all
                  </button>
                )}
              </div>
              <div>
                <span className="text-[#00ff00] opacity-70">&gt; REGIMES: </span>
                <span className="text-[#ff6600] block">{bot.regimes.join(', ')}</span>
              </div>
              <div>
                <span className="text-[#00ff00] opacity-70">&gt; NEXT REBUILD: </span>
                <span className="text-[#ffff00]">
                  {nextRebuildDisplay ? new Date(nextRebuildDisplay).toLocaleString() : '—'}
                </span>
              </div>
            </div>
            <div className="text-[10px] text-[#00ff0080] mb-2">
              Training uses selected timeframes × regimes × strategies. Live trading uses analysed trade mode (scope) to pick timeframe dynamically.
            </div>

            <div className="text-[10px] text-[#00ff0080] mb-4">
              Strategies come from Strategy Library (enabled only). Backtest and build use those — configure in Strategy Library.
            </div>

            <div className="flex flex-wrap gap-1">
              <button
                onClick={startBuild}
                disabled={bot.status === 'building' || !hasFullBacktest || noTimeframesSelected}
                className="border-2 border-[#00ff00] text-[#00ff00] p-2 text-xs hover:bg-[#00ff0011] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1 transition-all"
              >
                <Hammer className="w-3 h-3" />
                [ BUILD ]
              </button>
              <button
                onClick={() => { rebuild(); setTimeout(startBuild, 100); }}
                disabled={
                  bot.status === 'building' ||
                  (bot.driftDetectedAt ? !hasBacktestResults : !hasFullBacktest) ||
                  noTimeframesSelected ||
                  (!bot.driftDetectedAt && bot.status === 'outdated' && (bot.nnFeatureVector?.length ?? 0) === 0)
                }
                className={`border-2 p-2 text-xs flex items-center justify-center gap-1 transition-all ${
                  bot.driftDetectedAt
                    ? 'border-[#ffaa00] text-[#ffaa00] hover:bg-[#ffaa0011]'
                    : 'border-[#ff6600] text-[#ff6600] hover:bg-[#ff660011]'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Settings className="w-3 h-3" />
                {bot.driftDetectedAt ? '[ REBUILD NOW — drift detected ]' : '[ REBUILD NOW ]'}
              </button>
              {bot.status === 'deployed' && (
                <button
                  type="button"
                  onClick={() => actions.setDriftDetected(bot.id)}
                  className="border border-[#ffaa00] text-[#ffaa00] p-2 text-[10px] hover:bg-[#ffaa0011]"
                >
                  Mark drift
                </button>
              )}
              <button
                onClick={() => actions.cancelBuildBot(bot.id)}
                disabled={bot.status !== 'building'}
                className="border-2 border-[#ff4444] text-[#ff4444] p-2 text-xs hover:bg-[#ff444411] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1 transition-all"
              >
                <XCircle className="w-3 h-3" />
                [ CANCEL BUILD ]
              </button>
            </div>
            {noTimeframesSelected && (
              <div className="mt-2 text-[10px] text-[#ff6600]">
                Select at least one timeframe above to build.
              </div>
            )}
            {bot.driftDetectedAt && !hasBacktestResults && !noTimeframesSelected && (
              <div className="mt-2 text-[10px] text-[#ffaa00]">
                Run a backtest (and let it complete) to enable [ REBUILD NOW ].
              </div>
            )}
            {!hasFullBacktest && !noTimeframesSelected && !(bot.driftDetectedAt && !hasBacktestResults) && (
              <div className="mt-2 text-[10px] text-[#ff6600]">
                {backtest.status === 'cancelled'
                  ? 'Full backtest required. Run a backtest and let it complete (do not cancel), then [ BUILD ].'
                  : !hasBacktestResults
                    ? 'Run a full backtest (Backtest Engine above) first. Then click [ BUILD ] to train the NN.'
                    : 'Run a backtest and let it complete fully (do not cancel). Build uses only full backtest data.'}
              </div>
            )}
            {hasFullBacktest && (
              <div className={`mt-2 text-[10px] ${selectedInstrumentInBacktest ? 'text-[#00ff0080]' : 'text-[#ff6600]'}`}>
                {selectedInstrumentInBacktest
                  ? 'Full backtest completed. Build uses those results (best configs) to train the NN.'
                  : 'Last backtest did not include this instrument. Select this instrument in Instrument Selection, run backtest to completion, then build.'}
              </div>
            )}
            {hasFullBacktest && (bot.status === 'outdated' || bot.status === 'ready') && selectedInstrumentInBacktest && (
              <div className="mt-1 text-[10px] text-[#00ff0080]">
                Build trains the PyTorch model (real training, no simulation). Model saved to checkpoints/instrument_bot_nn_*.pt. Uses best backtest configs (train slice); validation slice never sent.
              </div>
            )}
            {bot.status === 'ready' && (
              <div className="mt-1 text-[10px] text-[#ffff00]/80">
                Ready to deploy. Use Deploy in Instrument Selection or Bot Registry.
                {bot.oosAccuracy != null && bot.oosSampleCount != null && bot.oosSampleCount > 0 && (
                  <span className="ml-1 text-[#00ff00]/90">OOS accuracy: {(bot.oosAccuracy * 100).toFixed(1)}% (n={bot.oosSampleCount})</span>
                )}
              </div>
            )}
            <div className="mt-2 text-[10px] text-[#00ff0080]">
              Rebuilds run on the interval set per instrument (Instrument Registry); [ REBUILD NOW ] runs immediately and reschedules using that interval.
            </div>
          </>
        )}

        {/* Rebuild schedule summary — only instruments with a bot built at least once (ready/deployed) */}
        <div className="mt-4 pt-3 border-t border-[#00ff00]">
          <div className="text-[10px] text-[#00ff00] opacity-70 mb-2">&gt; REBUILD SCHEDULE</div>
          {schedule.length === 0 ? (
            <div className="text-[10px] text-[#ff6600]/90 py-2">
              No rebuild schedule. Rebuilds only apply to instruments with a bot built at least once (ready or deployed).
            </div>
          ) : (
            <>
              <div className="space-y-1 text-[10px]">
                {schedule.slice(0, 10).map((e) => (
                  <div key={e.instrumentId} className="flex justify-between">
                    <span className="text-[#ff6600]">{e.instrumentSymbol}</span>
                    <span className="text-[#00ff00]">{new Date(e.nextRunAt).toLocaleString()} ({formatRebuildInterval(e.intervalHours)})</span>
                  </div>
                ))}
              </div>
              {schedule.length > 10 && (
                <div className="text-[10px] text-[#00ff00]/70 mt-1">+{schedule.length - 10} more</div>
              )}
              <div className="text-[10px] text-[#00ff00]/60 mt-2">{schedule.length} instrument(s) with scheduled rebuilds</div>
            </>
          )}
          {bots.some((b) => b.lastError) && (
            <div className="text-[10px] text-[#ff4444] mt-2 border border-[#ff4444]/50 bg-[#ff444408] px-2 py-1">
              Some bots have errors. Check each bot and fix or rebuild.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
