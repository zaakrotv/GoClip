// Petits composants d'interface réutilisables.
import type { ReactNode } from 'react'

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle ${props.disabled ? 'disabled' : ''}`}>
      <span className="toggle-text">
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
    </label>
  )
}

export function Slider(props: { label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="field slider">
      <span className="field-label">
        {props.label}
        <b>{props.format ? props.format(props.value) : props.value}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  )
}

export function ColorInput(props: { label: ReactNode; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field color">
      <span className="field-label">{props.label}</span>
      <span className="color-box">
        <input type="color" value={props.value} onChange={(e) => props.onChange(e.target.value.toUpperCase())} />
        <code>{props.value}</code>
      </span>
    </label>
  )
}

export function Select<T extends string | number>(props: { label?: ReactNode; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="field">
      {props.label && <span className="field-label">{props.label}</span>}
      <select
        value={String(props.value)}
        onChange={(e) => {
          const found = props.options.find((o) => String(o.value) === e.target.value)
          if (found) props.onChange(found.value)
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Section(props: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${props.className ?? ''}`}>
      <header>
        <h3>{props.title}</h3>
        {props.right}
      </header>
      {props.children}
    </section>
  )
}

export function Progress(props: { value: number; tone?: 'accent' | 'ok' }) {
  return (
    <div className={`progress ${props.tone ?? 'accent'}`}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, props.value)) * 100)}%` }} />
    </div>
  )
}

export function Pill(props: { tone?: 'live' | 'ok' | 'warn' | 'muted' | 'accent' | 'danger'; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${props.tone ?? 'muted'}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function Empty(props: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">{props.icon ?? '✂️'}</div>
      <h3>{props.title}</h3>
      {props.children && <div className="empty-body">{props.children}</div>}
    </div>
  )
}

export function FilePicker(props: { label: ReactNode; file: string | null; onPick: () => void; onClear: () => void; empty?: string }) {
  const name = props.file ? props.file.split(/[\\/]/).pop()?.replace(/^[0-9a-f]{10}-/, '') : null
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="file-picker">
        <span className={name ? 'file-name' : 'file-name muted'}>{name ?? props.empty ?? 'Aucun fichier'}</span>
        <button className="btn small" onClick={props.onPick}>
          {name ? 'Changer' : 'Choisir…'}
        </button>
        {name && (
          <button className="btn small ghost" onClick={props.onClear} title="Retirer">
            ✕
          </button>
        )}
      </div>
    </div>
  )
}
