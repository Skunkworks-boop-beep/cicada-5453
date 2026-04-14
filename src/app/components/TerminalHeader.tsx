export function TerminalHeader() {
  const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });
  const currentDate = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });

  return (
    <div className="border-b border-[#00ff00] bg-black p-4">
      <div className="flex items-center justify-between">
        <pre className="text-[#00ff00] text-sm">
          {`╔═══════════════════════════════════════╗
║  TRADEX TERMINAL v2.1.0 - HOMEBREW   ║
╚═══════════════════════════════════════╝`}
        </pre>
        <div className="text-right text-[#00ff00]">
          <div className="text-xl font-mono">{currentTime}</div>
          <div className="text-xs opacity-70">{currentDate}</div>
        </div>
      </div>
    </div>
  );
}
