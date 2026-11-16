// Aperçu en direct du montage : la vidéo source est recomposée dans un canvas
// avec exactement les mêmes calculs que le rendu ffmpeg (shared/presets.ts).
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { computeRegions, coverCrop, groupWords, introBlurRadius, outputSize } from '../../../shared/presets'
import type { Box, Framing, IntroStyle, Look, Word } from '../../../shared/types'
import { fontFamily, mediaUrl } from '../api'

/** Ce qui fournit l'image du live : la vidéo d'un clip, ou une image (fausse image de stream, capture). */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement

/** Taille de l'image source, ou null si elle n'est pas encore prête. */
export function frameSize(src: FrameSource | null): { w: number; h: number } | null {
  if (!src) return null
  if (src instanceof HTMLVideoElement) return src.readyState >= 2 && src.videoWidth ? { w: src.videoWidth, h: src.videoHeight } : null
  if (src instanceof HTMLImageElement) return src.complete && src.naturalWidth ? { w: src.naturalWidth, h: src.naturalHeight } : null
  return src.width > 0 && src.height > 0 ? { w: src.width, h: src.height } : null
}

/** Aperçu en direct d'une intro (ou outro) par-dessus le clip, avec son flou et son fondu. */
export interface IntroOverlay {
  kind: 'intro' | 'outro'
  media: HTMLVideoElement | HTMLImageElement
  /** performance.now() au début de l'aperçu. */
  startedAt: number
  /** Durée de l'intro (ou de l'outro), en secondes. */
  duration: number
  style: IntroStyle
}

/** Opacité du flou et de l'intro à l'instant t de l'aperçu (mêmes règles que le rendu). */
export function overlayAlphas(ov: IntroOverlay, t: number): { blur: number; media: number } {
  const f = Math.min(Math.max(0, ov.style.fade), ov.duration)
  if (ov.kind === 'intro') {
    if (t >= ov.duration) return { blur: 0, media: 0 }
    const k = f > 0 ? Math.min(1, Math.max(0, (t - (ov.duration - f)) / f)) : 0
    return { blur: ov.style.blur > 0 ? 1 - k : 0, media: 1 - k }
  }
  const k = f > 0 ? Math.min(1, Math.max(0, t / f)) : 1
  return { blur: ov.style.blur > 0 ? k : 0, media: k }
}

/** Écart-type (px de la vidéo finale) qui correspond au flou de ffmpeg (boxblur 2 passes au quart). */
function blurSigma(blur: number): number {
  const r = introBlurRadius(blur)
  return r > 0 ? 4 * Math.sqrt((2 * r * (r + 1)) / 3) : 0
}

interface TimedWord {
  text: string
  start: number
  end: number
}

function useImage(file: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!file) return setImg(null)
    const i = new Image()
    i.onload = () => setImg(i)
    i.onerror = () => setImg(null)
    i.src = mediaUrl(file)
  }, [file])
  return img
}

function wrap(ctx: CanvasRenderingContext2D, items: { width: number }[], space: number, max: number): number[][] {
  const lines: number[][] = [[]]
  let width = 0
  items.forEach((it, i) => {
    const line = lines[lines.length - 1]
    const next = line.length === 0 ? it.width : width + space + it.width
    if (line.length > 0 && next > max) {
      lines.push([i])
      width = it.width
    } else {
      line.push(i)
      width = next
    }
  })
  void ctx
  return lines
}

/** Zone occupée par un élément dessiné (pixels du canvas), pour le glisser-déposer. */
export interface Hit {
  x: number
  y: number
  w: number
  h: number
}

/** Sous-titres affichés quand personne ne parle, pour pouvoir les placer. */
const PLACEHOLDER: TimedWord[] = [
  { text: 'Sous-titres', start: 0, end: 1 },
  { text: 'ici', start: 1, end: 2 }
]

function drawSubtitles(ctx: CanvasRenderingContext2D, look: Look, groups: TimedWord[][], now: number, W: number, H: number, s: number, ghost: boolean): Hit | null {
  const sub = look.subtitles
  let gi = -1
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const end = i + 1 < groups.length ? Math.min(groups[i + 1][0].start, g[g.length - 1].end + 0.5) : g[g.length - 1].end + 0.5
    if (now >= g[0].start && now < end) {
      gi = i
      break
    }
  }
  if (gi < 0 && !ghost) return null
  const group = gi >= 0 ? groups[gi] : PLACEHOLDER.map((w) => ({ ...w, text: sub.uppercase ? w.text.toLocaleUpperCase('fr-FR') : w.text }))
  if (gi < 0) ctx.globalAlpha = 0.45
  let active = 0
  group.forEach((w, i) => {
    if (gi < 0 ? i === 0 : w.start <= now) active = i
  })
  const size = sub.size * s
  ctx.font = `${size}px "${fontFamily(sub.font)}"`
  ctx.textBaseline = 'alphabetic'
  const items = group.map((w, i) => ({ text: w.text, width: ctx.measureText(w.text).width * (i === active ? sub.pop : 1) }))
  const space = ctx.measureText(' ').width
  const lines = wrap(ctx, items, space, (W - 140) * s)
  const lineH = size * 1.12
  const cx = (Number.isFinite(sub.x) ? sub.x : 0.5) * W * s
  const top = sub.y * H * s - (lines.length * lineH) / 2
  let y = top + size * 0.82
  let widest = 0
  for (const line of lines) {
    const total = line.reduce((a, i) => a + items[i].width, 0) + space * (line.length - 1)
    widest = Math.max(widest, total)
    let x = cx - total / 2
    for (const i of line) {
      const it = items[i]
      const highlighted = i === active || (sub.karaoke && i < active)
      const scale = i === active ? sub.pop : 1
      ctx.save()
      ctx.translate(x + it.width / 2, y)
      ctx.scale(scale, scale)
      const half = it.width / scale / 2
      ctx.lineJoin = 'round'
      if (sub.shadow > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.lineWidth = sub.outline * 2 * s
        const o = sub.shadow * s
        if (sub.outline > 0) ctx.strokeText(it.text, -half + o, o)
        ctx.fillText(it.text, -half + o, o)
      }
      if (sub.outline > 0) {
        ctx.strokeStyle = sub.outlineColor
        ctx.lineWidth = sub.outline * 2 * s
        ctx.strokeText(it.text, -half, 0)
      }
      ctx.fillStyle = highlighted ? sub.color : sub.base
      ctx.fillText(it.text, -half, 0)
      ctx.restore()
      x += it.width + space
    }
    y += lineH
  }
  ctx.globalAlpha = 1
  return { x: cx - widest / 2, y: top, w: widest, h: lines.length * lineH }
}

function drawTitle(ctx: CanvasRenderingContext2D, look: Look, title: string, now: number, W: number, H: number, s: number, ghost: boolean): Hit | null {
  const t = look.title
  if (!t.enabled) return null
  const text0 = title.trim() || (ghost ? 'Ton titre ici' : '')
  if (!text0) return null
  if (t.duration > 0 && now > t.duration && !ghost) return null
  if (!title.trim()) ctx.globalAlpha = 0.45
  const size = t.size * s
  ctx.font = `${size}px "${fontFamily(t.font)}"`
  const words = text0.split(/\s+/).map((w) => ({ text: w, width: ctx.measureText(w).width }))
  const space = ctx.measureText(' ').width
  const lines = wrap(ctx, words, space, (W - 180) * s)
  const lineH = size * 1.25
  const pad = size * 0.28
  const cx = (Number.isFinite(t.x) ? t.x : 0.5) * W * s
  const top = t.y * H * s - (lines.length * lineH) / 2
  let y = top
  let widest = 0
  for (const line of lines) {
    const text = line.map((i) => words[i].text).join(' ')
    const w = ctx.measureText(text).width
    widest = Math.max(widest, w + pad * 2)
    const x = cx - w / 2
    if (t.band) {
      ctx.fillStyle = t.background
      ctx.beginPath()
      ctx.roundRect(x - pad, y, w + pad * 2, lineH, size * 0.18)
      ctx.fill()
    } else {
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 8 * s
      ctx.lineJoin = 'round'
      ctx.strokeText(text, x, y + size * 0.98)
    }
    ctx.fillStyle = t.color
    ctx.fillText(text, x, y + size * 0.98)
    y += lineH
  }
  ctx.globalAlpha = 1
  return { x: cx - widest / 2, y: top, w: widest, h: lines.length * lineH }
}

export type MoveTarget = 'subtitles' | 'title' | 'logo'

export function VerticalPreview(props: {
  video: FrameSource | null
  look: Look
  words: Word[] | null
  clipStart: number
  clipEnd: number
  title: string
  height: number
  /** Montre les zones déplaçables (vidéo en pause). */
  guides?: boolean
  /** Glisser-déposer : nouvelle position (0..1) d'un élément. */
  onMove?: (target: MoveTarget, x: number, y: number) => void
  /** Temps (s, depuis le début du clip) quand la source n'est pas une vidéo. */
  clock?: () => number
  /** Aperçu de l'intro / outro en cours. */
  overlay?: IntroOverlay | null
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { look, words, clipStart, clipEnd, title, video } = props
  const clockRef = useRef(props.clock)
  clockRef.current = props.clock
  const overlay = props.overlay ?? null
  const { width: W, height: H } = outputSize(look.framing.layout)
  const k = props.height / Math.max(W, H)
  const dpr = window.devicePixelRatio || 1
  const s = k * dpr
  const logo = useImage(look.logo.enabled ? look.logo.file : null)
  const hits = useRef<Partial<Record<MoveTarget, Hit>>>({})
  const hover = useRef<MoveTarget | null>(null)
  const drag = useRef<{ target: MoveTarget; startX: number; startY: number; x0: number; y0: number } | null>(null)
  const guides = props.guides ?? false

  const groups = useMemo(() => {
    if (!words || !look.subtitles.enabled) return []
    const rel = words
      .filter((w) => w.end > clipStart && w.start < clipEnd)
      .map((w) => ({ text: look.subtitles.uppercase ? w.text.toLocaleUpperCase('fr-FR') : w.text, start: w.start - clipStart, end: w.end - clipStart }))
    return groupWords(rel, look.subtitles.words)
  }, [words, clipStart, clipEnd, look.subtitles.enabled, look.subtitles.uppercase, look.subtitles.words])

  useEffect(() => {
    void document.fonts.load(`20px "${fontFamily(look.subtitles.font)}"`)
    void document.fonts.load(`20px "${fontFamily(look.title.font)}"`)
  }, [look.subtitles.font, look.title.font])

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.filter = 'none'
      ctx.globalAlpha = 1
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, c.width, c.height)
      // Les textes et le logo sont dessinés même si la vidéo n'est pas encore prête,
      // pour qu'on puisse toujours les attraper à la souris.
      const size = frameSize(video)
      const alphas = overlay ? overlayAlphas(overlay, (performance.now() - overlay.startedAt) / 1000) : null
      if (video && size) {
        const { regions } = computeRegions(look.framing, size.w, size.h)
        for (const r of regions) {
          ctx.filter = r.blur ? `blur(${Math.round(14 * s)}px) brightness(0.93)` : 'none'
          ctx.drawImage(video, r.src.x, r.src.y, r.src.w, r.src.h, r.dst.x * s, r.dst.y * s, r.dst.w * s, r.dst.h * s)
        }
        // Aperçu de l'intro : le clip flouté par-dessus, qui s'efface en fondu.
        if (overlay && alphas && alphas.blur > 0) {
          ctx.globalAlpha = alphas.blur
          ctx.filter = `blur(${Math.max(1, Math.round(blurSigma(overlay.style.blur) * s))}px) brightness(0.92)`
          for (const r of regions) ctx.drawImage(video, r.src.x, r.src.y, r.src.w, r.src.h, r.dst.x * s, r.dst.y * s, r.dst.w * s, r.dst.h * s)
          ctx.globalAlpha = 1
        }
      }
      ctx.filter = 'none'
      const now = clockRef.current ? clockRef.current() : (video instanceof HTMLVideoElement ? video.currentTime : clipStart) - clipStart
      const ghost = guides || drag.current !== null
      const found: Partial<Record<MoveTarget, Hit>> = {}
      found.title = drawTitle(ctx, look, title, now, W, H, s, ghost) ?? undefined
      if (look.subtitles.enabled) found.subtitles = drawSubtitles(ctx, look, groups, now, W, H, s, ghost) ?? undefined
      // La vidéo de l'intro (transparente ou non), centrée, par-dessus.
      if (overlay && alphas && alphas.media > 0) {
        const m = overlay.media
        const mw = m instanceof HTMLVideoElement ? m.videoWidth : m.naturalWidth
        const mh = m instanceof HTMLVideoElement ? m.videoHeight : m.naturalHeight
        const ready = m instanceof HTMLVideoElement ? m.readyState >= 2 : m.complete
        if (ready && mw && mh) {
          const k2 = Math.min((W * s) / mw, (H * s) / mh)
          ctx.globalAlpha = alphas.media
          ctx.drawImage(m, (W * s - mw * k2) / 2, (H * s - mh * k2) / 2, mw * k2, mh * k2)
          ctx.globalAlpha = 1
        }
      }
      if (logo && look.logo.enabled) {
        const lw = look.logo.width * W * s
        const lh = (lw * logo.naturalHeight) / Math.max(1, logo.naturalWidth)
        ctx.globalAlpha = look.logo.opacity
        const lx = Math.max(0, Math.min(W * s - lw, look.logo.x * W * s - lw / 2))
        const ly = Math.max(0, Math.min(H * s - lh, look.logo.y * H * s - lh / 2))
        ctx.drawImage(logo, lx, ly, lw, lh)
        ctx.globalAlpha = 1
        found.logo = { x: lx, y: ly, w: lw, h: lh }
      }
      hits.current = found
      // Cadre pointillé autour de l'élément survolé ou déplacé.
      const shown = drag.current?.target ?? (props.onMove ? hover.current : null)
      const box = shown ? found[shown] : undefined
      if (box) {
        ctx.save()
        ctx.setLineDash([6 * dpr, 4 * dpr])
        ctx.lineWidth = 2 * dpr
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.95)'
        ctx.strokeRect(box.x - 6 * dpr, box.y - 4 * dpr, box.w + 12 * dpr, box.h + 8 * dpr)
        ctx.restore()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [video, look, groups, clipStart, title, logo, W, H, s, dpr, guides, props.onMove, overlay])

  /** Élément sous le pointeur (le logo passe devant, puis le titre, puis les sous-titres). */
  const hitTest = (e: ReactPointerEvent<HTMLCanvasElement>): MoveTarget | null => {
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    if (!r.width || !r.height) return null
    // Pixels du canvas, quelle que soit la mise à l'échelle CSS (zoom, devicePixelRatio…).
    const px = ((e.clientX - r.left) * c.width) / r.width
    const py = ((e.clientY - r.top) * c.height) / r.height
    const m = 10 * (c.width / r.width)
    for (const t of ['logo', 'title', 'subtitles'] as MoveTarget[]) {
      const b = hits.current[t]
      if (b && px >= b.x - m && px <= b.x + b.w + m && py >= b.y - m && py <= b.y + b.h + m) return t
    }
    return null
  }

  const position = (t: MoveTarget): { x: number; y: number } => (t === 'logo' ? look.logo : t === 'title' ? look.title : look.subtitles)

  return (
    <canvas
      ref={canvas}
      className="preview-canvas"
      width={Math.round(W * s)}
      height={Math.round(H * s)}
      style={{ width: Math.round(W * k), height: Math.round(H * k) }}
      onPointerDown={(e) => {
        if (!props.onMove) return
        const t = hitTest(e)
        if (!t) return
        e.currentTarget.setPointerCapture(e.pointerId)
        const p = position(t)
        drag.current = { target: t, startX: e.clientX, startY: e.clientY, x0: Number.isFinite(p.x) ? p.x : 0.5, y0: p.y }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) {
          hover.current = props.onMove ? hitTest(e) : null
          e.currentTarget.style.cursor = hover.current ? 'move' : 'default'
          return
        }
        const r = e.currentTarget.getBoundingClientRect()
        const clamp = (v: number): number => Math.min(0.97, Math.max(0.03, v))
        props.onMove?.(d.target, clamp(d.x0 + (e.clientX - d.startX) / r.width), clamp(d.y0 + (e.clientY - d.startY) / r.height))
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onPointerLeave={() => {
        if (!drag.current) hover.current = null
      }}
    />
  )
}

type BoxKey = 'camera' | 'game'

/** Image source entière avec les zones « caméra » et « jeu » déplaçables. */
export function SourceFramer(props: { video: FrameSource | null; framing: Framing; onChange: (f: Framing) => void; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const { video, framing, width } = props
  const [dims, setDims] = useState({ w: 1920, h: 1080 })
  const height = Math.round((width * dims.h) / dims.w)
  const keys: BoxKey[] = framing.layout === 'camera-game' ? ['game', 'camera'] : framing.layout === 'camera' ? ['camera'] : framing.layout === 'horizontal' ? [] : ['game']

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const size = frameSize(video)
      if (!video || !size) return
      if (size.w !== dims.w || size.h !== dims.h) setDims({ w: size.w, h: size.h })
      ctx.drawImage(video, 0, 0, c.width, c.height)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [video, dims])

  const drag = (key: BoxKey, mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = wrapRef.current!.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY }
    const b0 = { ...framing[key] }
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - start.x) / rect.width
      const dy = (ev.clientY - start.y) / rect.height
      let b: Box
      if (mode === 'move') b = { ...b0, x: Math.min(1 - b0.w, Math.max(0, b0.x + dx)), y: Math.min(1 - b0.h, Math.max(0, b0.y + dy)) }
      else b = { ...b0, w: Math.min(1 - b0.x, Math.max(0.05, b0.w + dx)), h: Math.min(1 - b0.y, Math.max(0.05, b0.h + dy)) }
      props.onChange({ ...framing, [key]: b })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Zone réellement utilisée (recadrée aux bonnes proportions), en pointillés.
  const used = (key: BoxKey): Box | null => {
    const { regions } = computeRegions(framing, dims.w, dims.h)
    const r = regions.find((x) => x.key === key)
    if (!r) return null
    const c = key === 'game' && framing.layout === 'blur' ? r.src : coverCrop(framing[key], dims.w, dims.h, r.dst.w, r.dst.h)
    return { x: c.x / dims.w, y: c.y / dims.h, w: c.w / dims.w, h: c.h / dims.h }
  }

  return (
    <div className="framer" ref={wrapRef} style={{ width, height }}>
      <canvas ref={canvas} width={width * 2} height={height * 2} style={{ width, height }} />
      {keys.map((key) => {
        const b = framing[key]
        const u = used(key)
        return (
          <div key={key}>
            {u && <div className={`framer-used ${key}`} style={{ left: `${u.x * 100}%`, top: `${u.y * 100}%`, width: `${u.w * 100}%`, height: `${u.h * 100}%` }} />}
            <div className={`framer-box ${key}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} onPointerDown={drag(key, 'move')}>
              <span>{key === 'camera' ? 'Caméra' : 'Jeu'}</span>
              <i onPointerDown={drag(key, 'resize')} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
