// Liste des clips qu'on parcourt dans l'éditeur (‹ précédent / suivant ›) : celle de l'onglet
// de la page Clips d'où on vient (À trier, Gardés…), dans le même ordre.
const KEY = 'autoclip.nav'

export interface ClipNav {
  ids: string[]
  label: string
}

export function setClipNav(ids: string[], label: string): void {
  sessionStorage.setItem(KEY, JSON.stringify({ ids, label }))
}

export function getClipNav(): ClipNav | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as ClipNav | null
    return v && Array.isArray(v.ids) ? v : null
  } catch {
    return null
  }
}

/** Ouvre un clip dans l'éditeur en retenant la liste parcourue. */
export function openClip(id: string, list: string[], label: string, tab?: string): void {
  setClipNav(list, label)
  window.location.hash = `#/clip/${id}${tab ? `/${tab}` : ''}`
}
