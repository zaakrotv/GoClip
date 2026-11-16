// Petits messages en bas de l'écran (« Clip mis à la corbeille — Annuler »).
// Ils survivent au changement de page (par exemple quand l'éditeur passe au clip suivant).
import { useEffect, useState } from 'react'

interface ToastItem {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

let seq = 0

export function toast(text: string, action?: { label: string; run: () => void }): void {
  window.dispatchEvent(new CustomEvent<ToastItem>('autoclip-toast', { detail: { id: ++seq, text, action } }))
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => {
    const on = (e: Event): void => {
      const item = (e as CustomEvent<ToastItem>).detail
      setItems((list) => [...list.slice(-2), item])
      window.setTimeout(() => setItems((list) => list.filter((x) => x.id !== item.id)), 6000)
    }
    window.addEventListener('autoclip-toast', on)
    return () => window.removeEventListener('autoclip-toast', on)
  }, [])
  if (items.length === 0) return null
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn small"
              onClick={() => {
                t.action!.run()
                setItems((list) => list.filter((x) => x.id !== t.id))
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
