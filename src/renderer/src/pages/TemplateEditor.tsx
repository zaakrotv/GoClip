// Créer ou modifier une patte sans ouvrir de clip : sur une fausse image de stream (jeu + caméra),
// sur une capture de ton vrai stream, ou sur l'image d'un de tes clips.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cloneLook, defaultLook } from '../../../shared/presets'
import type { Box, Look, Word } from '../../../shared/types'
import { api, errorText, mediaUrl } from '../api'
import { LOOK_TABS, LookTabContent, type LookTab } from '../components/LookPanel'
import { VerticalPreview, type FrameSource, type IntroOverlay, type MoveTarget } from '../components/Preview'
import { Pill, Section, Select } from '../components/ui'
import { useClips, useSettings, useTemplates } from '../hooks'

type Corner = 'tl' | 'tr' | 'bl' | 'br'
const CAM_W = 0.26
const CAM_H = 0.34
const STILL = /\.(png|jpe?g|webp|bmp)$/i

/** Zone caméra (même taille que celle du montage par défaut) dans un coin de l'image. */
function cornerBox(c: Corner): Box {
  return { x: c.endsWith('l') ? 0 : 1 - CAM_W, y: c.startsWith('t') ? 0 : 1 - CAM_H, w: CAM_W, h: CAM_H }
}

/** Dessine une fausse image de stream 1920×1080 : un jeu (ciel, décor, viseur, HUD) et une caméra. */
function fakeStream(corner: Corner): HTMLCanvasElement {
  const W = 1920
  const H = 1080
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  // Ciel et décor.
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#1b2a6b')
  sky.addColorStop(0.55, '#5b8ce0')
  sky.addColorStop(0.56, '#3b5d2f')
  sky.addColorStop(1, '#1f2e18')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#2c3f6e'
  g.beginPath()
  g.moveTo(0, 600)
  for (let x = 0; x <= W; x += 120) g.lineTo(x, 600 - 140 * Math.abs(Math.sin(x / 310)) - 40 * Math.sin(x / 90))
  g.lineTo(W, 610)
  g.closePath()
  g.fill()
  // Bâtiments.
  const buildings = [
    [260, 420, 180, 200],
    [520, 380, 140, 240],
    [1240, 400, 220, 220],
    [1520, 440, 160, 180]
  ]
  for (const [x, y, w, h] of buildings) {
    g.fillStyle = '#3d4458'
    g.fillRect(x, y, w, h)
    g.fillStyle = '#f6d365'
    for (let wy = y + 20; wy < y + h - 30; wy += 46) for (let wx = x + 18; wx < x + w - 24; wx += 40) if ((wx + wy) % 3 !== 0) g.fillRect(wx, wy, 16, 22)
  }
  // Un personnage au centre et le viseur.
  g.fillStyle = '#c0392b'
  g.beginPath()
  g.arc(980, 560, 26, 0, Math.PI * 2)
  g.fill()
  g.fillRect(958, 586, 44, 90)
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.lineWidth = 4
  g.beginPath()
  g.arc(W / 2, H / 2, 22, 0, Math.PI * 2)
  g.moveTo(W / 2 - 46, H / 2)
  g.lineTo(W / 2 - 28, H / 2)
  g.moveTo(W / 2 + 28, H / 2)
  g.lineTo(W / 2 + 46, H / 2)
  g.stroke()
  // HUD (évite le coin de la caméra).
  const camLeft = corner.endsWith('l')
  const camTop = corner.startsWith('t')
  g.fillStyle = 'rgba(0,0,0,0.45)'
  g.fillRect(W / 2 - 260, H - 90, 520, 44)
  g.fillStyle = '#22c55e'
  g.fillRect(W / 2 - 252, H - 82, 380, 28)
  g.fillStyle = 'white'
  g.font = 'bold 30px Segoe UI, sans-serif'
  g.fillText('100', W / 2 + 150, H - 57)
  const mapX = camLeft ? W - 230 : 30
  const mapY = camTop ? H - 330 : 30
  g.fillStyle = 'rgba(0,0,0,0.45)'
  g.fillRect(mapX, mapY, 200, 200)
  g.strokeStyle = 'rgba(255,255,255,0.6)'
  g.strokeRect(mapX, mapY, 200, 200)
  g.fillStyle = '#fbbf24'
  g.beginPath()
  g.arc(mapX + 100, mapY + 100, 8, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(255,255,255,0.12)'
  g.font = 'bold 120px Segoe UI, sans-serif'
  g.textAlign = 'center'
  g.fillText('IMAGE DU JEU', W / 2, 330)
  g.textAlign = 'left'
  // Caméra.
  const b = cornerBox(corner)
  const cx = b.x * W
  const cy = b.y * H
  const cw = b.w * W
  const ch = b.h * H
  const room = g.createLinearGradient(cx, cy, cx + cw, cy + ch)
  room.addColorStop(0, '#4c2a6b')
  room.addColorStop(1, '#1d1033')
  g.fillStyle = room
  g.fillRect(cx, cy, cw, ch)
  g.fillStyle = '#ec4899'
  g.fillRect(cx + cw * 0.08, cy + ch * 0.12, cw * 0.1, ch * 0.5)
  // Silhouette avec casque.
  g.fillStyle = '#f2c4a0'
  g.beginPath()
  g.arc(cx + cw / 2, cy + ch * 0.45, ch * 0.17, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#2d2d3a'
  g.beginPath()
  g.ellipse(cx + cw / 2, cy + ch * 1.02, cw * 0.32, ch * 0.36, 0, Math.PI, 0)
  g.fill()
  g.strokeStyle = '#111'
  g.lineWidth = 10
  g.beginPath()
  g.arc(cx + cw / 2, cy + ch * 0.43, ch * 0.21, Math.PI * 1.1, Math.PI * 1.9)
  g.stroke()
  g.fillStyle = '#111'
  g.fillRect(cx + cw / 2 - ch * 0.24, cy + ch * 0.4, ch * 0.07, ch * 0.13)
  g.fillRect(cx + cw / 2 + ch * 0.17, cy + ch * 0.4, ch * 0.07, ch * 0.13)
  g.fillStyle = 'rgba(255,255,255,0.85)'
  g.font = 'bold 28px Segoe UI, sans-serif'
  g.fillText('CAM', cx + 16, cy + 38)
  g.strokeStyle = '#ec4899'
  g.lineWidth = 6
  g.strokeRect(cx + 3, cy + 3, cw - 6, ch - 6)
  return c
}

/** Sous-titres d'exemple qui défilent en boucle. */
const SAMPLE: Word[] = [
  { text: 'Ça', start: 0.1, end: 0.4 },
  { text: 'c’est', start: 0.4, end: 0.75 },
  { text: 'ma', start: 0.75, end: 1.05 },
  { text: 'patte', start: 1.05, end: 1.7 },
  { text: 'pour', start: 2.1, end: 2.4 },
  { text: 'tous', start: 2.4, end: 2.7 },
  { text: 'mes', start: 2.7, end: 3.0 },
  { text: 'clips', start: 3.0, end: 3.7 }
]
const LOOP = 4.2

export function TemplateEditorPage({ id }: { id: string | null }) {
  const [templates] = useTemplates()
  const [clips] = useClips()
  const [settings] = useSettings()
  const existing = id ? (templates.find((t) => t.id === id) ?? null) : null
  const [look, setLookRaw] = useState<Look>(() => defaultLook())
  const [name, setName] = useState('')
  const [loaded, setLoaded] = useState<string | null>(null)
  const [tab, setTab] = useState<LookTab>('cadrage')
  const [kind, setKind] = useState<'fake' | 'image' | 'clip'>('fake')
  const [corner, setCorner] = useState<Corner>('tl')
  const fake = useMemo(() => fakeStream(corner), [corner])
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [clipId, setClipId] = useState('')
  const [clipVideo, setClipVideo] = useState<HTMLVideoElement | null>(null)
  const [title, setTitle] = useState('IL A PAS VU VENIR LE COUP 😱')
  const [animate, setAnimate] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<IntroOverlay | null>(null)
  const undo = useRef<Look[]>([])
  const redo = useRef<Look[]>([])
  const lastChange = useRef(0)
  const [, tick] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageHeight, setStageHeight] = useState(600)

  // Patte existante : on part de son montage.
  useEffect(() => {
    if (existing && loaded !== existing.id) {
      lookRef.current = cloneLook(existing.look)
      setLookRaw(lookRef.current)
      setName(existing.name)
      setLoaded(existing.id)
    }
  }, [existing, loaded])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setStageHeight(Math.round(e.contentRect.height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const lookRef = useRef(look)
  lookRef.current = look
  const replace = (next: Look): void => {
    lookRef.current = next
    setLookRaw(next)
    tick((x) => x + 1)
  }
  /** Modifie le montage ; les changements rapprochés comptent pour une seule étape d'annulation. */
  const setLook = useCallback((fn: (l: Look) => Look) => {
    const now = Date.now()
    if (now - lastChange.current > 800) {
      undo.current = [...undo.current.slice(-99), lookRef.current]
      redo.current = []
    }
    lastChange.current = now
    replace(fn(lookRef.current))
  }, [])
  const doUndo = useCallback(() => {
    const prev = undo.current.pop()
    if (!prev) return
    redo.current.push(lookRef.current)
    lastChange.current = 0
    replace(prev)
  }, [])
  const doRedo = useCallback(() => {
    const next = redo.current.pop()
    if (!next) return
    undo.current.push(lookRef.current)
    lastChange.current = 0
    replace(next)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doUndo, doRedo])

  // La fausse caméra change de coin : la zone caméra du montage suit.
  const moveCamera = (c: Corner): void => {
    setCorner(c)
    setLook((l) => ({ ...l, framing: { ...l.framing, camera: cornerBox(c) } }))
  }

  const source: FrameSource | null = kind === 'fake' ? fake : kind === 'image' ? image : clipVideo
  const clip = clips.find((c) => c.id === clipId) ?? null
  const freeze = useRef(1.2)
  const clock = useCallback(() => (animate ? (performance.now() / 1000) % LOOP : freeze.current), [animate])

  const pickImage = async (): Promise<void> => {
    const f = await api().chooseFile('image')
    if (!f) return
    const img = new Image()
    img.onload = () => {
      setImage(img)
      setKind('image')
    }
    img.src = mediaUrl(f)
  }

  const previewIntro = (which: 'intro' | 'outro'): void => {
    const slot = look[which]
    if (!slot.enabled || !slot.file) return
    const begin = (media: HTMLVideoElement | HTMLImageElement, duration: number): void => {
      if (media instanceof HTMLVideoElement) void media.play().catch(() => {})
      setOverlay({ kind: which, media, startedAt: performance.now(), duration, style: slot })
      window.setTimeout(() => {
        if (media instanceof HTMLVideoElement) media.pause()
        setOverlay(null)
      }, duration * 1000 + 600)
    }
    if (STILL.test(slot.file)) {
      const img = new Image()
      img.onload = () => begin(img, 3)
      img.src = mediaUrl(slot.file)
    } else {
      const v = document.createElement('video')
      v.crossOrigin = 'anonymous'
      v.onloadeddata = () => begin(v, Math.min(30, Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 3))
      v.src = mediaUrl(slot.file)
    }
  }

  const moveElement = (target: MoveTarget, x: number, y: number): void => {
    setLook((l) => (target === 'logo' ? { ...l, logo: { ...l.logo, x, y } } : target === 'title' ? { ...l, title: { ...l.title, x, y } } : { ...l, subtitles: { ...l.subtitles, x, y } }))
  }

  const save = async (): Promise<void> => {
    setMessage(null)
    try {
      if (existing) {
        await api().updateTemplate(existing.id, { name, look })
        setMessage(`Patte « ${name || existing.name} » enregistrée.`)
      } else {
        const t = await api().createTemplate(name, look)
        setLoaded(t.id)
        window.location.hash = `#/patte/${t.id}`
        setMessage(`Patte « ${t.name} » créée.`)
      }
    } catch (e) {
      setMessage(errorText(e))
    }
  }
  const isDefault = !!existing && settings?.defaultTemplateId === existing.id

  return (
    <div className="editor template-editor">
      <header className="editor-head">
        <button className="btn ghost" onClick={() => (window.location.hash = '#/pattes')}>
          ← Pattes
        </button>
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la patte (ex : Ma patte Valorant)" />
        <div className="row">
          <button className="btn ghost icon" onClick={doUndo} disabled={undo.current.length === 0} title="Annuler (Ctrl+Z)">
            ↶
          </button>
          <button className="btn ghost icon" onClick={doRedo} disabled={redo.current.length === 0} title="Rétablir (Ctrl+Y)">
            ↷
          </button>
          {existing && (
            <button className="btn" onClick={() => void api().setDefaultTemplate(isDefault ? null : existing.id)}>
              {isDefault ? '✓ Patte par défaut' : 'Utiliser par défaut'}
            </button>
          )}
          <button className="btn primary" onClick={() => void save()} disabled={!name.trim()} title={name.trim() ? undefined : 'Donne un nom à ta patte'}>
            {existing ? '💾 Enregistrer' : '💾 Créer la patte'}
          </button>
        </div>
      </header>
      {message && (
        <div className="banner ok" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
      <div className="editor-body">
        <div className="editor-stage">
          <div className="tabs view-switch">
            <button className={kind === 'fake' ? 'active' : ''} onClick={() => setKind('fake')}>
              🎮 Fausse image
            </button>
            <button className={kind === 'image' ? 'active' : ''} onClick={() => (image ? setKind('image') : void pickImage())}>
              🖼 Ma capture
            </button>
            <button className={kind === 'clip' ? 'active' : ''} onClick={() => setKind('clip')} disabled={clips.length === 0}>
              🎬 Un de mes clips
            </button>
          </div>
          {kind === 'clip' && clip && <video ref={setClipVideo} src={mediaUrl(clip.source)} crossOrigin="anonymous" className="hidden-video" preload="auto" onLoadedData={(e) => (e.currentTarget.currentTime = clip.peak)} />}
          <div className="stage-preview" ref={stageRef}>
            <VerticalPreview
              video={source}
              look={look}
              words={SAMPLE}
              clipStart={0}
              clipEnd={LOOP}
              title={title}
              guides={!animate}
              onMove={moveElement}
              clock={clock}
              overlay={overlay}
              height={look.framing.layout === 'horizontal' ? Math.min(stageHeight, 420) : Math.max(240, stageHeight - 4)}
            />
          </div>
          <div className="transport">
            <button className="btn small" onClick={() => setAnimate(!animate)}>
              {animate ? '⏸ Figer les sous-titres' : '▶ Animer les sous-titres'}
            </button>
            {kind === 'fake' && (
              <Select
                value={corner}
                options={[
                  { value: 'tl', label: 'Caméra en haut à gauche' },
                  { value: 'tr', label: 'Caméra en haut à droite' },
                  { value: 'bl', label: 'Caméra en bas à gauche' },
                  { value: 'br', label: 'Caméra en bas à droite' }
                ]}
                onChange={moveCamera}
              />
            )}
            {kind === 'image' && (
              <button className="btn small" onClick={() => void pickImage()}>
                Changer d’image
              </button>
            )}
            {kind === 'clip' && (
              <Select
                value={clipId}
                options={[{ value: '', label: 'Choisis un clip…' }, ...clips.filter((c) => c.status !== 'trash').map((c) => ({ value: c.id, label: `${c.channel} — ${c.title || new Date(c.momentAt).toLocaleString('fr-FR')}` }))]}
                onChange={setClipId}
              />
            )}
          </div>
          <p className="muted small center">
            {kind === 'fake'
              ? 'Fausse image de stream : place la caméra au même endroit que sur ton vrai stream, puis règle tout comme pour un clip. Pour être précis, prends une capture de ton stream (🖼).'
              : 'Déplace titre, sous-titres et logo à la souris · Ctrl+Z = annuler'}
          </p>
        </div>

        <aside className="editor-panel">
          <div className="tabs vertical-tabs">
            {LOOK_TABS.map(([t, label]) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>
          <div className="panel-scroll">
            <LookTabContent
              tab={tab}
              look={look}
              setLook={setLook}
              source={source}
              title={title}
              onTitle={setTitle}
              wordsSection={
                <Section title="Texte">
                  <p className="muted small">Ici les sous-titres sont un exemple : sur tes clips, ce sera ce qui est dit, mot par mot.</p>
                </Section>
              }
              onPreviewIntro={previewIntro}
              previewing={overlay?.kind ?? null}
            />
          </div>
          <div className="panel-foot muted small">
            {existing ? <Pill tone="accent">Patte : {existing.name}</Pill> : <Pill>Nouvelle patte</Pill>}
            <span>{clips.filter((c) => c.templateId === existing?.id).length} clip(s) l’utilisent</span>
          </div>
        </aside>
      </div>
    </div>
  )
}
