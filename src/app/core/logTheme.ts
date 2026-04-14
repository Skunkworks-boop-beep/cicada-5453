/**
 * Log level styling for research, backtest, and execution logs.
 * Matches the terminal-style theme: green (success/info), orange (warning), red (error), yellow (progress).
 */

export type LogLevel = 'info' | 'progress' | 'success' | 'warning' | 'error';

/** Tailwind text color class per level. */
export function logLevelToTextClass(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'text-[#ff4444]';
    case 'warning':
      return 'text-[#ff6600]';
    case 'success':
      return 'text-[#00ff00]';
    case 'progress':
      return 'text-[#ffff00]/90';
    case 'info':
    default:
      return 'text-[#00ff00]/90';
  }
}
