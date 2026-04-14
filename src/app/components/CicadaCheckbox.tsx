/**
 * Custom checkbox: black square with green border; green tick when checked.
 * Matches app design (login/dashboard). Use everywhere a checkbox is needed.
 */

export interface CicadaCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  id?: string;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
  /** Size: 'sm' (login-style), 'xs' (smaller inline) */
  size?: 'sm' | 'xs';
}

const boxSize = { sm: 'w-4 h-4', xs: 'w-3.5 h-3.5' };
const tickSize = { sm: 'w-2.5 h-2.5', xs: 'w-2 h-2' };

export function CicadaCheckbox({
  checked,
  onChange,
  label,
  id,
  disabled = false,
  className = '',
  labelClassName = '',
  size = 'sm',
}: CicadaCheckboxProps) {
  const textSize = size === 'sm' ? 'text-[9px]' : 'text-[10px]';
  const el = (
    <label
      className={`group flex items-center gap-2 text-[#00ff00] cursor-pointer opacity-80 ${textSize} ${labelClassName} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      htmlFor={id}
    >
      <span className="relative inline-flex flex-shrink-0">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`${boxSize[size]} border-2 border-[#00ff00] bg-black flex items-center justify-center transition-colors pointer-events-none ${disabled ? '' : 'group-hover:bg-[#00ff0008]'}`}
        >
          {checked && (
            <svg className={`${tickSize[size]} text-[#00ff00]`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
  if (className) {
    return <div className={className}>{el}</div>;
  }
  return el;
}
