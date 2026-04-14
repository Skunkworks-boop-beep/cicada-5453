/**
 * Custom radio-style control: deactivated = hollow circle (ring); activated = solid green dot that replaces the circle.
 * Used as on/off toggle (one per row). Same API as checkbox for toggle use.
 */

export interface CicadaRadioProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  id?: string;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
  /** Size: 'sm' (default), 'xs' (smaller inline) */
  size?: 'sm' | 'xs';
}

const controlSize = { sm: 'w-2 h-2', xs: 'w-1.5 h-1.5' };

export function CicadaRadio({
  checked,
  onChange,
  label,
  id,
  disabled = false,
  className = '',
  labelClassName = '',
  size = 'sm',
}: CicadaRadioProps) {
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
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`${controlSize[size]} rounded-full flex items-center justify-center transition-colors pointer-events-none ${
            checked
              ? 'bg-[#00ff00]'
              : `border-2 border-[#00ff00] bg-black ${disabled ? '' : 'group-hover:bg-[#00ff0008]'}`
          }`}
        />
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
  if (className) {
    return <div className={className}>{el}</div>;
  }
  return el;
}
