import { ReactNode } from 'react';

interface RetroBoxProps {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  className?: string;
  icon?: ReactNode;
}

export function RetroBox({ title, children, collapsible = false, className = '', icon }: RetroBoxProps) {
  return (
    <div className={`relative ${className}`}>
      {/* Top border */}
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ {title} ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        {collapsible && <span>[−]</span>}
      </div>

      {/* Content box */}
      <div className="border-2 border-[#00ff00] bg-black p-3 shadow-[0_0_15px_rgba(0,255,0,0.2)]">
        {/* Corner decorations */}
        <div className="absolute top-5 left-0 w-2 h-2 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-5 right-0 w-2 h-2 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2 border-[#00ff00]"></div>

        {children}
      </div>
    </div>
  );
}
