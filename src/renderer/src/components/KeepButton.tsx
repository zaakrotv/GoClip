// « ✓ Garder » avec une flèche pour choisir la patte appliquée au passage.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Template } from '../../../shared/types'
import { api, errorText } from '../api'

export function KeepButton(props: {
  ids: string[]
  templates: Template[]
  /** Patte actuelle (celle du clip, ou celle de sa chaîne). */
  current: string | null
  small?: boolean
  label?: string
  onDone?: () => void
  onError?: (m: string) => void
  /** Remplace l'action par défaut (l'éditeur applique la patte lui-même, pour pouvoir l'annuler). */
  onKeep?: (templateId?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<CSSProperties>({})
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const hide = (): void => setOpen(false)
    window.addEventListener('mousedown', close)
    // Le menu est placé en position fixe : on le ferme si la page bouge.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [open])
  const toggle = (): void => {
    if (open || !ref.current) return setOpen(false)
    const r = ref.current.getBoundingClientRect()
    const right = Math.max(8, window.innerWidth - r.right)
    const below = window.innerHeight - r.bottom
    // Ouvre vers le haut s'il n'y a pas la place en dessous.
    setPos(below < 60 + props.templates.length * 34 && r.top > below ? { right, bottom: window.innerHeight - r.top + 4 } : { right, top: r.bottom + 4 })
    setOpen(true)
  }

  const keep = (templateId?: string): void => {
    setOpen(false)
    if (props.onKeep) return props.onKeep(templateId)
    void api()
      .keepClips(props.ids, templateId)
      .then(() => props.onDone?.())
      .catch((e) => props.onError?.(errorText(e)))
  }
  const size = props.small ? 'small' : ''
  return (
    <span className="split-btn" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className={`btn ${size} primary`} onClick={() => keep()} title="Garder ce clip pour le monter (avec sa patte actuelle)">
        {props.label ?? '✓ Garder'}
      </button>
      <button className={`btn ${size} primary split-arrow`} onClick={toggle} title="Garder avec la patte de ton choix">
        ▾
      </button>
      {open && (
        <div className="split-menu" style={pos}>
          <div className="split-menu-title">Garder avec la patte…</div>
          {props.templates.length === 0 ? (
            <span className="muted small">Pas encore de patte : crée-en une dans « Pattes ».</span>
          ) : (
            props.templates.map((t) => (
              <button key={t.id} onClick={() => keep(t.id)}>
                {t.id === props.current ? '✓ ' : ''}
                {t.name}
              </button>
            ))
          )}
        </div>
      )}
    </span>
  )
}
