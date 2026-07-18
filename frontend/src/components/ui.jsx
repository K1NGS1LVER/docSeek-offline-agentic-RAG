/**
 * Shared UI primitives — the only place component shapes are defined.
 *
 * Every color/font/size/radius resolves to theme.css tokens (mapped to
 * utilities in tailwind.css). The fixed design language:
 *   cards/panels/modals  → rounded-xl / rounded-2xl
 *   buttons/inputs       → rounded-lg, FIXED heights (sm 32 / md 40 / lg 48)
 *   chips/toggles        → pill (rounded-full), 28px
 *   disabled state       → disabled/disabled-fg tokens, never opacity hacks
 *   spacing              → 8pt grid (gap/p in 2/4/6/8 steps)
 */
import { X, Loader2 } from 'lucide-react';

export function SectionLabel({ children, className = '' }) {
  return (
    <div className={`font-mono text-2xs tracking-[0.14em] uppercase text-text-muted ${className}`}>
      {children}
    </div>
  );
}

export function Card({ children, className = '', ...props }) {
  return (
    <div {...props} className={`bg-surface border border-border rounded-xl ${className}`}>
      {children}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-on-accent border-accent hover:bg-accent-hover hover:border-accent-hover',
  ghost: 'bg-transparent text-text-dim border-border-bright hover:text-text hover:bg-surface-2',
  danger: 'bg-transparent text-caution border-caution/40 hover:bg-caution-soft hover:border-caution',
  dangerSolid: 'bg-caution text-on-accent border-caution',
};

const BUTTON_SIZES = {
  sm: 'h-8 px-3',
  md: 'h-10 px-4',
};

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  icon: Icon,
  children,
  className = '',
  ...props
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border text-sm font-medium
        whitespace-nowrap transition-all
        disabled:bg-disabled disabled:text-disabled-fg disabled:border-transparent disabled:pointer-events-none
        ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
    </button>
  );
}

const ICON_BUTTON_SIZES = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
};

export function IconButton({ icon: Icon, size = 'sm', danger = false, className = '', ...props }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-lg transition-colors
        disabled:bg-disabled disabled:text-disabled-fg disabled:pointer-events-none
        ${ICON_BUTTON_SIZES[size]} ${
          danger
            ? 'text-text-muted hover:text-caution hover:bg-caution-soft'
            : 'text-text-muted hover:text-text hover:bg-surface-2'
        } ${className}`}
    >
      <Icon className={size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
    </button>
  );
}

/** Pill toggle between a few options. options: [{ value, label }].
    `block` stretches it to the container width (tab-style). */
export function Segmented({ options, value, onChange, mono = false, block = false }) {
  return (
    <div className={`${block ? 'flex w-full' : 'inline-flex'} bg-panel border border-border rounded-full p-1 gap-0.5`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-6 px-3 rounded-full text-xs font-medium transition-all ${
            block ? 'flex-1' : ''
          } ${mono ? 'font-mono uppercase' : ''} ${
            value === o.value
              ? 'bg-accent text-on-accent'
              : 'text-text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Pill chip — suggested questions, source citations, filters. */
export function Chip({ icon: Icon, active = false, mono = false, children, className = '', ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full border transition-all
        ${mono ? 'font-mono text-xs' : 'text-sm'}
        ${
          active
            ? 'bg-accent-soft border-accent text-accent'
            : 'bg-surface border-border-bright text-text-dim hover:border-accent hover:text-accent hover:bg-accent-soft'
        } ${className}`}
    >
      {Icon && <Icon className="w-3 h-3 flex-shrink-0" />}
      {children}
    </button>
  );
}

/** Styled native checkbox (check glyph drawn in index.css `.checkbox`). */
export function Checkbox({ className = '', ...props }) {
  return <input type="checkbox" className={`checkbox ${className}`} {...props} />;
}

/** Shared text input / textarea classes (rounded-lg, fixed 40px height). */
export const inputCls =
  'h-10 w-full bg-carbon border border-border rounded-lg px-4 text-sm text-text ' +
  'placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors ' +
  'disabled:bg-disabled disabled:text-disabled-fg';

/** Textarea variant — same language, flexible height. */
export const textareaCls =
  'w-full bg-carbon border border-border rounded-lg px-4 py-2 text-sm text-text ' +
  'placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-y';

/** Modal dialog: fixed overlay + surface card. */
export function Modal({ title, onClose, children, wide = false }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`w-full ${wide ? 'max-w-[720px]' : 'max-w-[560px]'} max-h-[85vh] overflow-y-auto
          bg-surface border border-border-bright rounded-2xl shadow-2xl`}
      >
        <div className="flex items-center justify-between pt-6 px-6">
          <h3 className="font-serif text-xl font-medium text-text">{title}</h3>
          <IconButton icon={X} onClick={onClose} title="Close" />
        </div>
        <div className="p-6 space-y-4">{children}</div>
      </div>
    </div>
  );
}

/** Settings-style operation row: title + description on the left, control on the right. */
export function OpRow({ title, sub, danger = false, children }) {
  return (
    <div
      className={`flex items-center justify-between gap-6 px-6 py-4 border rounded-xl ${
        danger ? 'border-caution/30 bg-caution-soft' : 'border-border bg-panel'
      }`}
    >
      <span className="min-w-0">
        <h4 className={`text-sm font-semibold ${danger ? 'text-caution' : 'text-text'}`}>{title}</h4>
        <p className="text-xs text-text-dim mt-0.5">{sub}</p>
      </span>
      {children}
    </div>
  );
}
