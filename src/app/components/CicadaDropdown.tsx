/**
 * Custom dropdown: no border, matches Cicada design (green/orange on black).
 * Use for rebuild interval and other selectors.
 */

import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './ui/utils';

export interface CicadaDropdownOption<T = string | number> {
  value: T;
  label: string;
}

export interface CicadaDropdownProps<T = string | number> {
  options: CicadaDropdownOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  placeholder?: string;
  /** Trigger text color: 'green' | 'orange' */
  variant?: 'green' | 'orange';
  /** Compact for table cells */
  compact?: boolean;
  className?: string;
}

export function CicadaDropdown<T extends string | number>({
  options,
  value,
  onChange,
  placeholder = '— select —',
  variant = 'orange',
  compact = false,
  className,
}: CicadaDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedLabel = value != null
    ? options.find((o) => o.value === value)?.label ?? String(value)
    : placeholder;

  const colorClass = variant === 'green' ? 'text-[#00ff00]' : 'text-[#ff6600]';
  const hoverClass = variant === 'green' ? 'hover:text-[#00ff00]' : 'hover:text-[#ff6600]';

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-0.5 bg-transparent outline-none focus:outline-none',
          compact ? 'text-[10px] py-0.5' : 'text-[10px] py-1',
          colorClass,
          hoverClass,
          'opacity-90 hover:opacity-100 transition-opacity'
        )}
      >
        <span>{selectedLabel}</span>
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-0.5 z-50 min-w-[7rem] max-h-48 overflow-y-auto scrollbar-hide bg-black shadow-[0_0_12px_rgba(0,255,0,0.2)]"
          role="listbox"
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'w-full text-left px-2 py-1 text-[10px] transition-colors',
                  isSelected
                    ? 'bg-[#00ff0011] text-[#00ff00]'
                    : 'text-[#00ff00]/90 hover:bg-[#00ff0008] hover:text-[#00ff00]'
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
