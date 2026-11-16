// Préréglages et calculs de mise en page partagés.
// Le même code sert à l'aperçu (interface) et au rendu ffmpeg (processus principal),
// ce qui garantit que l'aperçu correspond exactement à la vidéo finale.

import type { Box, Framing, IntroStyle, LayoutId, Look, SubtitleStyle, Word } from './types'

export interface FontDef {
  id: string
  label: string
  /** Nom du fichier dans resources/fonts. */
  file: string
  /** Nom de famille lu par libass (table « name » de la police). */
  family: string
  /**
   * (usWinAscent + usWinDescent) / unitsPerEm. libass mesure la taille d'une police sur sa
   * hauteur totale, le navigateur sur le « em » : on multiplie par ce rapport pour que la
   * vidéo finale ait exactement la taille de l'aperçu.
   */
  cell: number
}

export const FONTS: FontDef[] = [
  { id: 'poppins', label: 'Poppins', file: 'Poppins-ExtraBold.ttf', family: 'Poppins ExtraBold', cell: 1.762 },
  { id: 'anton', label: 'Anton', file: 'Anton-Regular.ttf', family: 'Anton', cell: 1.7334 },
  { id: 'bebas', label: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', family: 'Bebas Neue', cell: 1.3 },
  { id: 'luckiest', label: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf', family: 'Luckiest Guy', cell: 1.2256 },
  { id: 'bangers', label: 'Bangers', file: 'Bangers-Regular.ttf', family: 'Bangers', cell: 1.757 },
  { id: 'russo', label: 'Russo One', file: 'RussoOne-Regular.ttf', family: 'Russo One', cell: 1.205 },
  { id: 'marker', label: 'Permanent Marker', file: 'PermanentMarker-Regular.ttf', family: 'Permanent Marker', cell: 1.4268 },
  { id: 'titan', label: 'Titan One', file: 'TitanOne-Regular.ttf', family: 'Titan One', cell: 1.145 },
  { id: 'lilita', label: 'Lilita One', file: 'LilitaOne-Regular.ttf', family: 'Lilita One', cell: 1.143 },
  { id: 'archivo', label: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', family: 'Archivo Black', cell: 1.347 },
  { id: 'kanit', label: 'Kanit', file: 'Kanit-ExtraBold.ttf', family: 'Kanit ExtraBold', cell: 1.58 },
  { id: 'barlow', label: 'Barlow Condensed', file: 'BarlowCondensed-ExtraBold.ttf', family: 'Barlow Condensed ExtraBold', cell: 1.349 }
]

export function fontById(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]
}

export interface SubtitlePreset {
  id: string
  label: string
  font: string
  size: number
  color: string
  base: string
  outline: number
  outlineColor: string
  shadow: number
  uppercase: boolean
  words: number
  pop: number
  karaoke: boolean
}

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  { id: 'classique', label: 'Classique', font: 'poppins', size: 78, color: '#FFE600', base: '#FFFFFF', outline: 7, outlineColor: '#000000', shadow: 3, uppercase: true, words: 3, pop: 1.1, karaoke: false },
  { id: 'impact', label: 'Impact', font: 'anton', size: 96, color: '#3BFF6C', base: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 4, uppercase: true, words: 2, pop: 1.2, karaoke: false },
  { id: 'karaoke', label: 'Karaoké', font: 'poppins', size: 72, color: '#33E0FF', base: '#FFFFFF', outline: 7, outlineColor: '#000000', shadow: 3, uppercase: true, words: 4, pop: 1, karaoke: true },
  { id: 'mot-a-mot', label: 'Mot à mot', font: 'bebas', size: 128, color: '#FFFFFF', base: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 4, uppercase: true, words: 1, pop: 1, karaoke: false },
  { id: 'cartoon', label: 'Cartoon', font: 'luckiest', size: 80, color: '#FFE600', base: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 5, uppercase: true, words: 3, pop: 1.15, karaoke: false },
  { id: 'comics', label: 'Comics', font: 'bangers', size: 92, color: '#FF3B3B', base: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 4, uppercase: true, words: 3, pop: 1.12, karaoke: false },
  { id: 'neon', label: 'Néon', font: 'russo', size: 76, color: '#33E0FF', base: '#FFFFFF', outline: 6, outlineColor: '#7A1FFF', shadow: 0, uppercase: true, words: 3, pop: 1.1, karaoke: false },
  { id: 'feutre', label: 'Feutre', font: 'marker', size: 80, color: '#FF4FD8', base: '#FFFFFF', outline: 7, outlineColor: '#000000', shadow: 3, uppercase: false, words: 3, pop: 1.15, karaoke: false },
  { id: 'bonbon', label: 'Bonbon', font: 'titan', size: 84, color: '#FF4FD8', base: '#FFE600', outline: 8, outlineColor: '#000000', shadow: 4, uppercase: true, words: 2, pop: 1.2, karaoke: false },
  { id: 'sobre', label: 'Sobre', font: 'kanit', size: 64, color: '#FFE600', base: '#FFFFFF', outline: 4, outlineColor: '#000000', shadow: 0, uppercase: false, words: 4, pop: 1, karaoke: false }
]

export function applySubtitlePreset(sub: SubtitleStyle, presetId: string): SubtitleStyle {
  const p = SUBTITLE_PRESETS.find((x) => x.id === presetId) ?? SUBTITLE_PRESETS[0]
  return {
    ...sub,
    preset: p.id,
    font: p.font,
    size: p.size,
    color: p.color,
    base: p.base,
    outline: p.outline,
    outlineColor: p.outlineColor,
    shadow: p.shadow,
    uppercase: p.uppercase,
    words: p.words,
    pop: p.pop,
    karaoke: p.karaoke
  }
}

export const LAYOUTS: { id: LayoutId; label: string; hint: string }[] = [
  { id: 'blur', label: 'Jeu + fond flou', hint: 'Le jeu au centre, le reste flouté' },
  { id: 'camera-game', label: 'Caméra + jeu', hint: 'La caméra et le jeu empilés' },
  { id: 'camera', label: 'Caméra plein cadre', hint: 'Seulement la caméra' },
  { id: 'game', label: 'Jeu plein cadre', hint: 'Le jeu recadré en vertical' },
  { id: 'horizontal', label: 'Horizontal 16:9', hint: 'Format YouTube classique' }
]

const FULL: Box = { x: 0, y: 0, w: 1, h: 1 }

export function defaultLook(): Look {
  return {
    framing: {
      layout: 'blur',
      camera: { x: 0, y: 0, w: 0.26, h: 0.34 },
      game: { ...FULL },
      split: 700,
      cameraOnTop: true
    },
    subtitles: applySubtitlePreset(
      {
        enabled: true,
        preset: 'classique',
        font: 'poppins',
        size: 78,
        color: '#FFE600',
        base: '#FFFFFF',
        outline: 7,
        outlineColor: '#000000',
        shadow: 3,
        uppercase: true,
        words: 3,
        pop: 1.1,
        karaoke: false,
        x: 0.5,
        y: 0.74
      },
      'classique'
    ),
    title: {
      enabled: false,
      font: 'poppins',
      size: 64,
      color: '#111111',
      background: '#FFFFFF',
      band: true,
      x: 0.5,
      y: 0.18,
      duration: 0
    },
    // Par défaut : comme avant la version 0.3 (clip figé et flouté, sans fondu).
    intro: { enabled: false, file: null, mode: 'pause', blur: 60, fade: 0 },
    outro: { enabled: false, file: null, mode: 'pause', blur: 60, fade: 0 },
    logo: { enabled: false, file: null, x: 0.84, y: 0.08, width: 0.2, opacity: 0.9 },
    music: { enabled: false, file: null, volume: 0.15 },
    sourceVolume: 1
  }
}

/** Réglages d'intro / outro valides (anciennes versions : pause, flou d'origine, sans fondu). */
export function normalizeIntro(input: unknown, d: IntroStyle): IntroStyle {
  const x = { ...d, ...((input && typeof input === 'object' ? input : {}) as Partial<IntroStyle>) }
  return {
    enabled: !!x.enabled,
    file: typeof x.file === 'string' ? x.file : null,
    mode: x.mode === 'play' ? 'play' : 'pause',
    blur: Number.isFinite(x.blur) ? Math.min(100, Math.max(0, Math.round(x.blur))) : d.blur,
    fade: Number.isFinite(x.fade) ? Math.min(2, Math.max(0, Math.round(x.fade * 10) / 10)) : d.fade
  }
}

/** Déroulé de la vidéo finale avec intro et outro (secondes, dans la vidéo finale). */
export interface ExtraTimeline {
  /** Image figée ajoutée avant / après le clip (mode « pause »). */
  padStart: number
  padEnd: number
  /** Fin de l'intro, début de l'outro. */
  introEnd: number
  outroStart: number
  /** Fondus réellement appliqués (intro → clip, clip → outro). */
  fadeIn: number
  fadeOut: number
  total: number
}

/**
 * Calcule où se placent l'intro et l'outro.
 * - pause : le clip attend la fin de l'intro (sa première image reste figée), et sa dernière
 *   image reste figée pendant l'outro : la vidéo s'allonge.
 * - play  : l'intro passe par-dessus le début du clip, l'outro par-dessus la fin : même durée.
 * Le fondu se fait sur la fin de l'intro (et le début de l'outro).
 */
export function extraTimeline(look: Pick<Look, 'intro' | 'outro'>, clipDuration: number, introDuration: number, outroDuration: number): ExtraTimeline {
  const D = Math.max(0.1, clipDuration)
  const I = Math.max(0, introDuration)
  const O = Math.max(0, outroDuration)
  const introPlay = I > 0 && look.intro.mode === 'play'
  const outroPlay = O > 0 && look.outro.mode === 'play'
  const padStart = I > 0 && !introPlay ? I : 0
  const padEnd = O > 0 && !outroPlay ? O : 0
  const total = padStart + D + padEnd
  const introEnd = I > 0 ? (introPlay ? Math.min(I, D) : I) : 0
  const outroStart = O > 0 ? (outroPlay ? Math.max(introEnd, padStart + D - O) : padStart + D) : total
  const fadeIn = I > 0 ? Math.min(Math.max(0, look.intro.fade), introEnd) : 0
  const fadeOut = O > 0 ? Math.min(Math.max(0, look.outro.fade), total - outroStart) : 0
  return { padStart, padEnd, introEnd, outroStart, fadeIn, fadeOut, total }
}

/** Rayon du flou (boxblur, image réduite au quart) pour une intensité 0..100 ; 60 = le flou d'origine. */
export function introBlurRadius(blur: number): number {
  return blur <= 0 ? 0 : Math.max(1, Math.round(blur * 0.16))
}

/** Complète un look lu sur le disque (anciennes versions, champs manquants). */
export function normalizeLook(input: unknown): Look {
  const d = defaultLook()
  const l = (input && typeof input === 'object' ? input : {}) as Partial<Look>
  return {
    framing: { ...d.framing, ...(l.framing ?? {}) },
    subtitles: { ...d.subtitles, ...(l.subtitles ?? {}) },
    title: { ...d.title, ...(l.title ?? {}) },
    intro: normalizeIntro(l.intro, d.intro),
    outro: normalizeIntro(l.outro, d.outro),
    logo: { ...d.logo, ...(l.logo ?? {}) },
    music: { ...d.music, ...(l.music ?? {}) },
    sourceVolume: typeof l.sourceVolume === 'number' ? l.sourceVolume : d.sourceVolume
  }
}

export function cloneLook(look: Look): Look {
  return JSON.parse(JSON.stringify(look)) as Look
}

/**
 * Empreinte de tout ce qui change la vidéo finale d'un clip. Si elle diffère de celle
 * du dernier rendu, le rendu n'est plus à jour (« modifications non validées »).
 */
export function editSignature(clip: { look: Look; title: string; start: number; end: number; words: Word[] | null }): string {
  const s = JSON.stringify([clip.look, clip.title.trim(), clip.start, clip.end, clip.words])
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(16)}-${s.length}`
}

export function outputSize(layout: LayoutId): { width: number; height: number } {
  return layout === 'horizontal' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 }
}

/** Position verticale conseillée pour les sous-titres selon la mise en page. */
export function suggestedSubtitleY(framing: Framing): number {
  switch (framing.layout) {
    case 'camera-game':
      return framing.cameraOnTop ? framing.split / 1920 : (1920 - framing.split) / 1920
    case 'camera':
    case 'game':
      return 0.72
    case 'horizontal':
      return 0.82
    default:
      return 0.74
  }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Zone source (px) et zone de destination (px) d'un élément de la composition. */
export interface Region {
  key: 'background' | 'camera' | 'game' | 'full'
  src: Rect
  dst: Rect
  blur: boolean
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

function clampBox(b: Box): Box {
  const w = Math.min(1, Math.max(0.02, b.w))
  const h = Math.min(1, Math.max(0.02, b.h))
  return { x: Math.min(1 - w, Math.max(0, b.x)), y: Math.min(1 - h, Math.max(0, b.y)), w, h }
}

/** Recadre une zone pour qu'elle ait exactement les proportions de la destination (sans déformer). */
export function coverCrop(box: Box, srcW: number, srcH: number, tw: number, th: number): Rect {
  const b = clampBox(box)
  let w = b.w * srcW
  let h = b.h * srcH
  let x = b.x * srcW
  let y = b.y * srcH
  const target = tw / th
  if (w / h > target) {
    const nw = h * target
    x += (w - nw) / 2
    w = nw
  } else {
    const nh = w / target
    y += (h - nh) / 2
    h = nh
  }
  w = Math.min(srcW, even(w))
  h = Math.min(srcH, even(h))
  x = Math.min(srcW - w, Math.max(0, Math.round(x)))
  y = Math.min(srcH - h, Math.max(0, Math.round(y)))
  return { x, y, w, h }
}

/** Calcule la composition finale : quelles zones de la source vont où dans la vidéo de sortie. */
export function computeRegions(framing: Framing, srcW: number, srcH: number): { width: number; height: number; regions: Region[] } {
  const { width: W, height: H } = outputSize(framing.layout)
  const full: Rect = { x: 0, y: 0, w: srcW, h: srcH }
  switch (framing.layout) {
    case 'horizontal': {
      // Image entière, centrée (bandes noires si la source n'est pas en 16:9).
      const scale = Math.min(W / srcW, H / srcH)
      const w = even(srcW * scale)
      const h = even(srcH * scale)
      return { width: W, height: H, regions: [{ key: 'full', src: full, dst: { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h }, blur: false }] }
    }
    case 'camera':
      return { width: W, height: H, regions: [{ key: 'camera', src: coverCrop(framing.camera, srcW, srcH, W, H), dst: { x: 0, y: 0, w: W, h: H }, blur: false }] }
    case 'game':
      return { width: W, height: H, regions: [{ key: 'game', src: coverCrop(framing.game, srcW, srcH, W, H), dst: { x: 0, y: 0, w: W, h: H }, blur: false }] }
    case 'camera-game': {
      const split = Math.min(1400, Math.max(400, even(framing.split)))
      const camDst: Rect = framing.cameraOnTop ? { x: 0, y: 0, w: W, h: split } : { x: 0, y: H - split, w: W, h: split }
      const gameDst: Rect = framing.cameraOnTop ? { x: 0, y: split, w: W, h: H - split } : { x: 0, y: 0, w: W, h: H - split }
      return {
        width: W,
        height: H,
        regions: [
          { key: 'camera', src: coverCrop(framing.camera, srcW, srcH, camDst.w, camDst.h), dst: camDst, blur: false },
          { key: 'game', src: coverCrop(framing.game, srcW, srcH, gameDst.w, gameDst.h), dst: gameDst, blur: false }
        ]
      }
    }
    default: {
      // Jeu + fond flou : la zone jeu garde ses proportions, pleine largeur, centrée.
      const b = clampBox(framing.game)
      const bw = b.w * srcW
      const bh = b.h * srcH
      let h = even((W * bh) / bw)
      let src: Rect = { x: Math.round(b.x * srcW), y: Math.round(b.y * srcH), w: even(bw), h: even(bh) }
      if (h > H) {
        h = H
        src = coverCrop(b, srcW, srcH, W, H)
      }
      src.w = Math.min(src.w, srcW - src.x)
      src.h = Math.min(src.h, srcH - src.y)
      return {
        width: W,
        height: H,
        regions: [
          { key: 'background', src: coverCrop(FULL, srcW, srcH, W, H), dst: { x: 0, y: 0, w: W, h: H }, blur: true },
          { key: 'game', src, dst: { x: 0, y: Math.round((H - h) / 2), w: W, h }, blur: false }
        ]
      }
    }
  }
}

/** Découpe une transcription en groupes de mots affichés ensemble. */
export function groupWords<T extends { text: string; start: number; end: number }>(words: T[], perGroup: number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  for (const w of words) {
    const prev = current[current.length - 1]
    const pause = prev ? w.start - prev.end > 0.6 : false
    const sentenceEnd = prev ? /[.!?…]$/.test(prev.text) : false
    if (current.length > 0 && (current.length >= Math.max(1, perGroup) || pause || sentenceEnd)) {
      groups.push(current)
      current = []
    }
    current.push(w)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
