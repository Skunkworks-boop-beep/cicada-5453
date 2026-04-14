/**
 * Bot Registry: standalone section listing all bots per instrument.
 * Deploy/undeploy controls, individual and collective. Not part of Instrument Registry.
 */

import { BotsOverview } from './BotsOverview';

export function BotRegistry() {
  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ BOT REGISTRY ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="text-[10px]">Click row to select instrument</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        <BotsOverview />
      </div>
    </div>
  );
}
