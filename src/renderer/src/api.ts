import type { WindowApi } from '../../shared/api'
import { FONTS, fontById } from '../../shared/presets'

declare global {
  interface Window {
    api: WindowApi
  }
}

export const api = (): WindowApi => window.api

/** Adresse locale pour lire un fichier (vidéo, image, son) dans l'interface. */
export function mediaUrl(file: string | null | undefined): string {
  return file ? `media://fichier/${encodeURIComponent(file)}` : ''
}

export function fontFamily(fontId: string): string {
  return `ac-${fontById(fontId).id}`
}

/** Déclare les polices des sous-titres pour l'aperçu. */
export function installFonts(): void {
  const css = FONTS.map((f) => `@font-face { font-family: 'ac-${f.id}'; src: url('media://police/${f.file}'); font-display: block; }`).join('\n')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
