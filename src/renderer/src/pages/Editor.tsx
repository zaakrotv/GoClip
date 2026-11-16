// Éditeur de montage d'un clip, avec aperçu vertical en direct.
// Chaque modification est enregistrée automatiquement. « Valider » fabrique la vidéo,
// qu'on peut revoir dans l'onglet « Rendu final » ; « Terminé » envoie le clip dans Rendus.
// ‹ › (ou Alt+← / Alt+→) passent au clip précédent / suivant sans revenir à la liste.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cloneLook, editSignature, formatDuration, LAYOUTS } from '../../../shared/presets'
import type { AppState, Clip, ClipStatus, Look, Template } from '../../../shared/types'
import { api, errorText, mediaUrl } from '../api'
import { KeepButton } from '../components/KeepButton'
import { LOOK_TABS, LookTabContent, type LookTab } from '../components/LookPanel'
import { VerticalPreview, type IntroOverlay, type MoveTarget } from '../components/Preview'
import { toast } from '../components/Toast'
import { Pill, Progress, Section, Select, Toggle } from '../components/ui'
import { WordsEditor } from '../components/WordsEditor'
import { useClips, useSettings, useTemplates } from '../hooks'
import { getClipNav, setClipNav } from '../nav'

type Tab = LookTab | 'patte'
const TABS: [Tab, string][] = [...LOOK_TABS, ['patte', 'Patte']]
const STILL = /\.(png|jpe?g|webp|bmp)$/i

/** Ce que Ctrl+Z / Ctrl+Y restaurent. */
type Snapshot = Pick<Clip, 'look' | 'title' | 'start' | 'end' | 'words' | 'templateId'>
const snapshot = (c: Clip): Snapshot => ({ look: c.look, title: c.title, start: c.start, end: c.end, words: c.words, templateId: c.templateId })
/** Les changements rapprochés (glisser un curseur, taper un mot) comptent pour une seule étape. */
const MERGE_MS = 800
const STATUS_LABEL: Record<ClipStatus, string> = { new: 'À trier', kept: 'Gardé', done: 'Dans Rendus', trash: 'Corbeille' }

interface Sound {
  ctx: AudioContext
  live: GainNode
  music: GainNode
  player: HTMLAudioElement
}

/** Hauteur disponible d'un élément (suit le redimensionnement de la fenêtre). */
function useHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [height, setHeight] = useState(600)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!el) return
    observer.current = new ResizeObserver(([entry]) => setHeight(Math.round(entry.contentRect.height)))
    observer.current.observe(el)
  }, [])
  return [ref, height]
}

function Timeline(props: { duration: number; start: number; end: number; time: number; onSeek: (t: number) => void; onRange: (s: number, e: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const pct = (t: number): string => `${(t / Math.max(0.1, props.duration)) * 100}%`
  const at = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect()
    return Math.min(props.duration, Math.max(0, ((clientX - r.left) / r.width) * props.duration))
  }
  const drag = (which: 'start' | 'end') => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const move = (ev: PointerEvent): void => {
      const t = Math.round(at(ev.clientX) * 10) / 10
      if (which === 'start') props.onRange(Math.min(t, props.end - 1), props.end)
      else props.onRange(props.start, Math.max(t, props.start + 1))
      props.onSeek(t)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="timeline" ref={ref} onPointerDown={(e) => props.onSeek(at(e.clientX))}>
      <div className="timeline-range" style={{ left: pct(props.start), width: `calc(${pct(props.end)} - ${pct(props.start)})` }} />
      <div className="timeline-handle" style={{ left: pct(props.start) }} onPointerDown={drag('start')} title="Début du clip" />
      <div className="timeline-handle end" style={{ left: pct(props.end) }} onPointerDown={drag('end')} title="Fin du clip" />
      <div className="timeline-head" style={{ left: pct(props.time) }} />
    </div>
  )
}

/** Liste des clips parcourus avec ‹ › : celle de la page Clips d'où l'on vient. */
function useClipNav(id: string, clips: Clip[]): { ids: string[]; label: string } {
  const loaded = clips.length > 0
  return useMemo(() => {
    const saved = getClipNav()
    if (saved && saved.ids.includes(id)) return saved
    const c = clips.find((x) => x.id === id)
    if (!c) return { ids: [id], label: '' }
    // Ouvert autrement (lien, travaux…) : les clips de la même chaîne et du même onglet.
    const ids = clips.filter((x) => x.status === c.status && x.channel === c.channel).sort((a, b) => b.momentAt - a.momentAt).map((x) => x.id)
    const label = STATUS_LABEL[c.status]
    setClipNav(ids, label)
    return { ids, label }
  }, [id, loaded])
}

export function EditorPage({ id, initialTab, state, onClose }: { id: string; initialTab?: string; state: AppState | null; onClose: () => void }) {
  const [clips] = useClips()
  const [templates] = useTemplates()
  const [settings] = useSettings()
  const stored = clips.find((c) => c.id === id) ?? null
  const [clip, setClip] = useState<Clip | null>(null)
  const [tab, setTab] = useState<Tab>(TABS.some(([t]) => t === initialTab) ? (initialTab as Tab) : 'cadrage')
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingPatch = useRef<Partial<Clip>>({})
  const [stageRef, stageHeight] = useHeight()
  const [view, setView] = useState<'edit' | 'render'>('edit')
  const clipRef = useRef<Clip | null>(null)
  clipRef.current = clip
  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])
  const lastChange = useRef(0)
  const [, setHistoryTick] = useState(0)
  const sound = useRef<Sound | null>(null)
  const lastRenderState = useRef<string | null>(null)
  const [overlay, setOverlay] = useState<IntroOverlay | null>(null)
  const overlayMedia = useRef<HTMLVideoElement | HTMLImageElement | null>(null)
  const nav = useClipNav(id, clips)

  // Copie locale du clip (les données du disque ne remplacent la copie que pour les champs gérés ailleurs).
  // Les mots viennent aussi de la transcription, mais une correction pas encore enregistrée reste prioritaire.
  useEffect(() => {
    if (!stored) return
    setClip((prev) =>
      prev && prev.id === stored.id
        ? {
            ...prev,
            words: 'words' in pendingPatch.current ? prev.words : stored.words,
            transcribeError: stored.transcribeError,
            render: stored.render,
            output: stored.output,
            status: stored.status,
            renderSig: stored.renderSig,
            final: stored.final
          }
        : stored
    )
  }, [stored])

  // Une validation vient de se terminer : on montre tout de suite le rendu final.
  useEffect(() => {
    const st = clip?.render.state ?? null
    if (lastRenderState.current === 'running' && st === 'done') setView('render')
    lastRenderState.current = st
  }, [clip?.render.state])

  const flush = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    const patch = pendingPatch.current
    pendingPatch.current = {}
    if (Object.keys(patch).length > 0) void api().updateClip(id, patch)
  }, [id])
  useEffect(() => () => flush(), [flush])

  const change = useCallback(
    (patch: Partial<Clip>, history = true) => {
      const current = clipRef.current
      if (history && current) {
        const now = Date.now()
        if (now - lastChange.current > MERGE_MS) {
          undoStack.current = [...undoStack.current.slice(-199), snapshot(current)]
          redoStack.current = []
          setHistoryTick((x) => x + 1)
        }
        lastChange.current = now
      }
      setClip((c) => (c ? { ...c, ...patch } : c))
      pendingPatch.current = { ...pendingPatch.current, ...patch }
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(flush, 400)
    },
    [flush]
  )
  const undo = useCallback(() => {
    const current = clipRef.current
    const prev = undoStack.current[undoStack.current.length - 1]
    if (!current || !prev) return
    undoStack.current = undoStack.current.slice(0, -1)
    redoStack.current = [...redoStack.current, snapshot(current)]
    lastChange.current = 0
    change(prev, false)
    setHistoryTick((x) => x + 1)
    // Le message parlait de ce qu'on vient d'annuler (« patte appliquée… »).
    setMessage(null)
  }, [change])
  const redo = useCallback(() => {
    const current = clipRef.current
    const next = redoStack.current[redoStack.current.length - 1]
    if (!current || !next) return
    redoStack.current = redoStack.current.slice(0, -1)
    undoStack.current = [...undoStack.current, snapshot(current)]
    lastChange.current = 0
    change(next, false)
    setHistoryTick((x) => x + 1)
    setMessage(null)
  }, [change])
  const setLook = (fn: (l: Look) => Look): void => {
    if (clip) change({ look: fn(clip.look) })
  }

  // ---------- Clips précédent / suivant ----------
  const navIds = nav.ids.filter((x) => x === id || clips.some((c) => c.id === x && c.status !== 'trash'))
  const navIndex = navIds.indexOf(id)
  const prevId = navIndex > 0 ? navIds[navIndex - 1] : null
  const nextId = navIndex >= 0 && navIndex < navIds.length - 1 ? navIds[navIndex + 1] : null
  const goTo = useCallback(
    (target: string | null) => {
      if (!target) return
      flush()
      window.location.hash = `#/clip/${target}/${tab}`
    },
    [flush, tab]
  )

  /** Jeter le clip (corbeille) et passer au suivant. */
  const trash = useCallback(async () => {
    const c = clipRef.current
    if (!c) return
    flush()
    const before = c.status
    const target = nextId ?? prevId
    await api().setClipsStatus([c.id], 'trash')
    toast('Clip mis à la corbeille.', { label: 'Annuler', run: () => void api().setClipsStatus([c.id], before) })
    if (target) goTo(target)
    else onClose()
  }, [flush, nextId, prevId, goTo, onClose])

  /** Applique une patte à ce clip (annulable avec Ctrl+Z). */
  const applyTemplate = (t: Template | null): void => {
    if (!clip) return
    if (!t) return change({ templateId: null })
    change({ look: cloneLook(t.look), templateId: t.id })
    setMessage(`Patte « ${t.name} » appliquée à ce clip (Ctrl+Z pour revenir en arrière).`)
  }

  // Son de l'aperçu : volume du live (jusqu'à 200 %) et musique de fond, comme dans le rendu.
  const ensureSound = (): Sound | null => {
    if (sound.current || !video) return sound.current
    const ctx = new AudioContext()
    const live = ctx.createGain()
    ctx.createMediaElementSource(video).connect(live).connect(ctx.destination)
    const player = new Audio()
    player.crossOrigin = 'anonymous'
    player.loop = true
    const music = ctx.createGain()
    ctx.createMediaElementSource(player).connect(music).connect(ctx.destination)
    sound.current = { ctx, live, music, player }
    applySound()
    return sound.current
  }
  const applySound = (): void => {
    const s = sound.current
    const c = clipRef.current
    if (!s || !c) return
    s.live.gain.value = c.look.sourceVolume
    s.music.gain.value = c.look.music.enabled ? c.look.music.volume : 0
    const src = c.look.music.enabled && c.look.music.file ? mediaUrl(c.look.music.file) : ''
    if (s.player.getAttribute('src') !== src) {
      if (src) {
        s.player.src = src
        s.player.addEventListener('loadedmetadata', syncMusic, { once: true })
      } else s.player.removeAttribute('src')
    }
    if (!src) s.player.pause()
  }
  useEffect(applySound, [clip?.look.sourceVolume, clip?.look.music.enabled, clip?.look.music.volume, clip?.look.music.file])
  useEffect(() => () => void sound.current?.ctx.close(), [])
  const syncMusic = (): void => {
    const s = sound.current
    if (!s || !video || !clip || !s.player.getAttribute('src')) return
    const d = s.player.duration
    s.player.currentTime = Number.isFinite(d) && d > 0 ? Math.max(0, video.currentTime - clip.start) % d : Math.max(0, video.currentTime - clip.start)
    if (!video.paused) void s.player.play().catch(() => {})
  }

  // Lecture limitée au passage du clip.
  useEffect(() => {
    if (!video || !clip) return
    const onTime = (): void => {
      setTime(video.currentTime)
      if (video.currentTime >= clip.end && !video.paused) {
        video.pause()
        video.currentTime = clip.start
      }
    }
    const onPlay = (): void => {
      setPlaying(true)
      syncMusic()
    }
    const onPause = (): void => {
      setPlaying(false)
      sound.current?.player.pause()
    }
    const onSeeked = (): void => syncMusic()
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
    }
  }, [video, clip?.start, clip?.end])

  // ---------- Aperçu de l'intro / outro (sans attendre un rendu) ----------
  const stopPreview = (): void => {
    const m = overlayMedia.current
    if (m instanceof HTMLVideoElement) m.pause()
    overlayMedia.current = null
    setOverlay(null)
  }
  useEffect(() => () => stopPreview(), [])
  const previewIntro = (kind: 'intro' | 'outro'): void => {
    const c = clipRef.current
    const slot = c?.look[kind]
    if (!c || !video || !slot?.enabled || !slot.file) return
    stopPreview()
    setView('edit')
    const begin = (media: HTMLVideoElement | HTMLImageElement, duration: number): void => {
      const D = c.end - c.start
      const len = slot.mode === 'play' ? Math.min(duration, D) : duration
      if (kind === 'intro') {
        video.currentTime = c.start
        if (slot.mode === 'play') {
          void ensureSound()?.ctx.resume()
          void video.play()
        } else video.pause()
      } else if (slot.mode === 'play') {
        video.currentTime = Math.max(c.start, c.end - len)
        void ensureSound()?.ctx.resume()
        void video.play()
      } else {
        video.pause()
        video.currentTime = Math.max(c.start, c.end - 0.05)
      }
      if (media instanceof HTMLVideoElement) {
        media.currentTime = 0
        void media.play().catch(() => {})
      }
      overlayMedia.current = media
      const ov: IntroOverlay = { kind, media, startedAt: performance.now(), duration: len, style: slot }
      setOverlay(ov)
      window.setTimeout(() => {
        if (overlayMedia.current !== media) return
        stopPreview()
        // L'intro finie, le clip démarre ; l'outro finie, tout s'arrête.
        if (kind === 'intro' && slot.mode === 'pause') {
          void ensureSound()?.ctx.resume()
          void video.play()
        }
        if (kind === 'outro') video.pause()
      }, len * 1000 + 50)
    }
    if (STILL.test(slot.file)) {
      const img = new Image()
      img.onload = () => begin(img, 3)
      img.src = mediaUrl(slot.file)
    } else {
      const v = document.createElement('video')
      v.crossOrigin = 'anonymous'
      v.preload = 'auto'
      v.onloadeddata = () => begin(v, Math.min(30, Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 3))
      v.onerror = () => setMessage('Impossible de lire ce fichier d’intro dans l’aperçu (il marchera quand même dans le rendu).')
      v.src = mediaUrl(slot.file)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+Z : annuler, Ctrl+Y ou Ctrl+Maj+Z : rétablir (partout dans l'éditeur).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      // Clip précédent / suivant : Alt+← / Alt+→ (ou Page préc. / Page suiv.).
      if ((e.altKey && e.key === 'ArrowLeft') || e.key === 'PageUp') {
        e.preventDefault()
        goTo(prevId)
        return
      }
      if ((e.altKey && e.key === 'ArrowRight') || e.key === 'PageDown') {
        e.preventDefault()
        goTo(nextId)
        return
      }
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select, .words, [contenteditable="true"]')) return
      if (e.code === 'Space' && video) {
        e.preventDefault()
        if (video.paused) {
          void ensureSound()?.ctx.resume()
          void video.play()
        } else video.pause()
      }
      if (e.key === 'Delete') {
        e.preventDefault()
        void trash()
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [video, onClose, undo, redo, goTo, prevId, nextId, trash])

  if (!clip) return <div className="page">{clips.length > 0 ? 'Clip introuvable.' : 'Chargement…'}</div>

  const look = clip.look
  const job = state?.queue.running?.clipId === clip.id ? state.queue.running : null
  const deps = state?.deps
  const template = templates.find((t) => t.id === clip.templateId) ?? null
  const channelTemplate = settings?.channels.find((c) => c.login === clip.channel)?.templateId ?? settings?.defaultTemplateId ?? null
  const seek = (t: number): void => {
    if (video) video.currentTime = t
  }
  const play = (): void => {
    if (!video) return
    if (video.paused) {
      if (video.currentTime < clip.start || video.currentTime >= clip.end - 0.1) video.currentTime = clip.start
      void ensureSound()?.ctx.resume()
      void video.play()
    } else video.pause()
  }
  /** « Valider » : enregistre et fabrique la vidéo (on la revoit ensuite dans « Rendu final »). */
  const validate = async (): Promise<void> => {
    flush()
    if (clip.status === 'new') await api().setClipsStatus([clip.id], 'kept')
    await api().renderClips([clip.id])
  }
  const finish = async (): Promise<void> => {
    flush()
    await api().finishClips([clip.id])
    setMessage('Clip terminé : il est dans « Rendus » et sa vidéo dans le dossier Clips prêts. Tu peux le programmer dans « Publier ».')
  }
  const keep = (templateId?: string): void => {
    const t = templateId ? templates.find((x) => x.id === templateId) : undefined
    if (t) applyTemplate(t)
    flush()
    void api()
      .setClipsStatus([clip.id], 'kept')
      .then(() => setMessage(t ? `Clip gardé avec la patte « ${t.name} ».` : 'Clip gardé : monte-le puis « Valider » pour voir la vidéo.'))
  }
  const moveElement = (target: MoveTarget, x: number, y: number): void => {
    setLook((l) => (target === 'logo' ? { ...l, logo: { ...l.logo, x, y } } : target === 'title' ? { ...l, title: { ...l.title, x, y } } : { ...l, subtitles: { ...l.subtitles, x, y } }))
  }
  const rendering = clip.render.state === 'running' || clip.render.state === 'queued'
  const upToDate = !!clip.output && clip.renderSig === editSignature(clip)

  const wordsSection = (
    <Section
      title="Texte"
      right={
        clip.words !== null && (
          <button className="btn small ghost" onClick={() => void api().transcribeClip(clip.id)}>
            Refaire la transcription
          </button>
        )
      }
    >
      {clip.words === null ? (
        <div className="stack">
          {clip.transcribeError && <p className="error small">{clip.transcribeError}</p>}
          {!deps?.whisper || !deps?.model ? (
            <p className="muted small">La transcription a besoin de Whisper et de son modèle : installe-les dans Réglages.</p>
          ) : state?.queue.running?.clipId === clip.id && state.queue.running.kind === 'transcribe' ? (
            <p className="muted small">Transcription en cours… {Math.round(state.queue.running.progress * 100)} %</p>
          ) : (
            <button className="btn small primary" onClick={() => void api().transcribeClip(clip.id)}>
              Transcrire ce clip
            </button>
          )}
        </div>
      ) : (
        <WordsEditor words={clip.words} start={clip.start} end={clip.end} time={time} onSeek={seek} onChange={(words) => change({ words })} />
      )}
    </Section>
  )

  return (
    <div className="editor">
      <header className="editor-head">
        <button className="btn ghost" onClick={onClose} title="Retour à la liste (Échap)">
          ← Clips
        </button>
        <div className="clip-nav" title={nav.label ? `Clips « ${nav.label} »` : undefined}>
          <button className="btn ghost icon" onClick={() => goTo(prevId)} disabled={!prevId} title="Clip précédent (Alt+←)">
            ‹
          </button>
          <span>
            {navIndex + 1} / {navIds.length}
          </span>
          <button className="btn ghost icon" onClick={() => goTo(nextId)} disabled={!nextId} title="Clip suivant (Alt+→)">
            ›
          </button>
        </div>
        <input className="title-input" value={clip.title} placeholder="Titre du clip (sert aussi de nom de fichier)" onChange={(e) => change({ title: e.target.value })} />
        <div className="row">
          <button className="btn ghost icon" onClick={undo} disabled={undoStack.current.length === 0} title="Annuler (Ctrl+Z)">
            ↶
          </button>
          <button className="btn ghost icon" onClick={redo} disabled={redoStack.current.length === 0} title="Rétablir (Ctrl+Y)">
            ↷
          </button>
          {/* Ces indications restent dans l'en-tête : un bandeau qui apparaît pendant un
              glisser-déposer décalerait l'aperçu sous la souris. */}
          {clip.status === 'kept' && clip.output && !upToDate && !rendering && (
            <Pill tone="warn" title="Clique sur « Valider » pour refaire la vidéo avec tes changements et la revoir.">
              Modifications non validées
            </Pill>
          )}
          <Pill
            tone={clip.status === 'done' ? 'ok' : clip.status === 'kept' ? 'accent' : 'warn'}
            title={clip.status === 'done' ? 'Ce clip est terminé. Si tu le modifies, il retourne dans « Gardés » jusqu’à ce que tu cliques à nouveau sur Terminé.' : undefined}
          >
            {STATUS_LABEL[clip.status]}
          </Pill>
          {clip.status === 'trash' ? (
            <button className="btn primary" onClick={() => void api().setClipsStatus([clip.id], 'new')}>
              Restaurer
            </button>
          ) : (
            <button className="btn ghost danger icon" onClick={() => void trash()} title="Jeter ce clip (Suppr) et passer au suivant">
              🗑
            </button>
          )}
          {clip.status === 'new' ? (
            <KeepButton ids={[clip.id]} templates={templates} current={clip.templateId ?? channelTemplate} onKeep={keep} />
          ) : rendering ? (
            <button className="btn" onClick={() => void api().cancelClip(clip.id)}>
              Annuler le rendu
            </button>
          ) : clip.status !== 'trash' ? (
            <>
              <button className={`btn ${upToDate ? '' : 'primary'}`} onClick={() => void validate()} disabled={!deps?.ffmpeg} title="Fabriquer la vidéo avec ce montage pour la revoir">
                🎞 Valider
              </button>
              {clip.status !== 'done' && (
                <button className={`btn ${upToDate ? 'primary' : ''}`} onClick={() => void finish()} disabled={!deps?.ffmpeg} title="Prêt à publier : le clip va dans Rendus">
                  ✓ Terminé
                </button>
              )}
              {clip.status === 'done' && clip.final && (
                <button className="btn" onClick={() => void api().showInFolder(clip.final!)}>
                  📂 Voir dans Clips prêts
                </button>
              )}
            </>
          ) : null}
        </div>
      </header>
      {(clip.render.state === 'running' || clip.render.state === 'queued') && (
        <div className="render-status">
          <span>{job ? `${state?.queue.paused ? '⏸ En pause — ' : ''}${job.step} — ${Math.round(job.progress * 100)} %` : 'En attente dans la file…'}</span>
          <Progress value={job?.progress ?? 0} />
        </div>
      )}
      {clip.render.state === 'error' && <div className="banner warn">Le rendu a échoué : {clip.render.error}</div>}
      {message && (
        <div className="banner ok" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}

      <div className="editor-body">
        <div className="editor-stage">
          <div className="tabs view-switch">
            <button className={view === 'edit' ? 'active' : ''} onClick={() => setView('edit')}>
              ✂ Montage
            </button>
            <button className={view === 'render' ? 'active' : ''} onClick={() => setView('render')} disabled={!clip.output} title={clip.output ? 'Revoir la vidéo validée' : 'Clique sur « Valider » pour fabriquer la vidéo'}>
              ▶ Rendu final {clip.output && !upToDate ? '(ancien)' : ''}
            </button>
          </div>
          <video ref={setVideo} src={mediaUrl(clip.source)} crossOrigin="anonymous" className="hidden-video" preload="auto" onLoadedData={(e) => (e.currentTarget.currentTime = clip.start)} />
          {view === 'render' && clip.output ? (
            <div className="stage-preview" ref={stageRef}>
              <video
                key={`${clip.output}-${clip.render.at}`}
                className="render-player"
                src={`${mediaUrl(clip.output)}?v=${clip.render.at ?? 0}`}
                controls
                autoPlay
                style={{ height: Math.max(240, stageHeight - 4) }}
              />
            </div>
          ) : (
            <div className="stage-preview" ref={stageRef}>
              <VerticalPreview
                video={video}
                look={look}
                words={clip.words}
                clipStart={clip.start}
                clipEnd={clip.end}
                title={clip.title}
                guides={!playing && !overlay}
                onMove={moveElement}
                overlay={overlay}
                height={look.framing.layout === 'horizontal' ? Math.min(stageHeight, 420) : Math.max(240, stageHeight - 4)}
              />
            </div>
          )}
          {view === 'render' ? (
            <p className="muted small center">C’est la vidéo finale, avec l’intro et l’outro. Reviens sur « Montage » pour la modifier, puis « Valider » à nouveau.</p>
          ) : (
            <>
              <div className="transport">
                <button className="btn" onClick={play}>
                  {playing ? '⏸' : '▶'}
                </button>
                <span className="time">
                  {formatDuration(Math.max(0, time - clip.start))} / {formatDuration(clip.end - clip.start)}
                </span>
                <button className="btn small" onClick={() => change({ start: Math.min(Math.round(time * 10) / 10, clip.end - 1) })} title="Le clip commence ici">
                  ⇤ Début ici
                </button>
                <button className="btn small" onClick={() => change({ end: Math.max(Math.round(time * 10) / 10, clip.start + 1) })} title="Le clip finit ici">
                  Fin ici ⇥
                </button>
                {(look.intro.enabled && look.intro.file) || (look.outro.enabled && look.outro.file) ? (
                  <button className="btn small" onClick={() => previewIntro(look.intro.enabled && look.intro.file ? 'intro' : 'outro')} disabled={!!overlay} title="Voir l’intro par-dessus le clip, sans attendre le rendu">
                    {overlay ? 'Aperçu…' : look.intro.enabled && look.intro.file ? '▶ Avec l’intro' : '▶ Avec l’outro'}
                  </button>
                ) : null}
              </div>
              <Timeline duration={clip.sourceDuration} start={clip.start} end={clip.end} time={time} onSeek={seek} onRange={(s, e) => change({ start: s, end: e })} />
              <p className="muted small center">Glisse les poignées pour couper · déplace titre, sous-titres et logo à la souris · Espace = lecture · Ctrl+Z = annuler · Alt+← → = clip précédent / suivant · Suppr = jeter</p>
            </>
          )}
        </div>

        <aside className="editor-panel">
          <div className="tabs vertical-tabs">
            {TABS.map(([t, label]) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>
          <div className="panel-scroll">
            {tab === 'patte' ? (
              <TemplateTab
                clip={clip}
                templates={templates}
                template={template}
                channelTemplate={settings?.channels.find((c) => c.login === clip.channel)?.templateId ?? null}
                defaultTemplate={settings?.defaultTemplateId ?? null}
                clips={clips}
                onMessage={setMessage}
                onLinked={(templateId) => change({ templateId })}
                onApply={applyTemplate}
                flush={flush}
              />
            ) : (
              <LookTabContent
                tab={tab}
                look={look}
                setLook={setLook}
                source={video}
                title={clip.title}
                onTitle={(title) => change({ title })}
                wordsSection={wordsSection}
                onPreviewIntro={previewIntro}
                previewing={overlay?.kind ?? null}
              />
            )}
          </div>
          <div className="panel-foot muted small">
            <span>{clip.channel}</span>
            <span>Force {clip.score}</span>
            <label className="foot-template" title="Choisir la patte de ce clip (Ctrl+Z pour revenir en arrière)">
              <span>Patte</span>
              <select value={clip.templateId ?? ''} onChange={(e) => applyTemplate(templates.find((t) => t.id === e.target.value) ?? null)}>
                <option value="">{template ? 'Aucune (garder ce montage)' : 'Aucune'}</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </aside>
      </div>
    </div>
  )
}

function TemplateTab(props: {
  clip: Clip
  templates: Template[]
  template: Template | null
  channelTemplate: string | null
  defaultTemplate: string | null
  clips: Clip[]
  onMessage: (m: string) => void
  onLinked: (templateId: string) => void
  onApply: (t: Template) => void
  flush: () => void
}) {
  const { clip, template } = props
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'channel' | 'all'>('channel')
  const [rerender, setRerender] = useState(true)
  const [withDone, setWithDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      props.flush()
      await fn()
    } catch (e) {
      props.onMessage(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const eligible = (c: Clip): boolean => c.id !== clip.id && c.status !== 'trash' && (withDone || c.status !== 'done')
  const targets = props.clips.filter((c) => eligible(c) && (scope === 'all' || c.channel === clip.channel))

  return (
    <>
      <p className="muted small">
        Une <b>patte</b>, c’est ton montage type : cadrage, style des sous-titres, titre, intro, outro, logo et musique. Choisis-en une pour ce clip, ou monte ce clip comme tu l’aimes et enregistre-le comme patte.
      </p>
      <Section title="Choisir une patte pour ce clip">
        {props.templates.length === 0 ? (
          <p className="muted small">Pas encore de patte : enregistre ce montage juste en dessous, ou crée-en une dans « Pattes ».</p>
        ) : (
          <div className="template-pick">
            {props.templates.map((t) => (
              <div key={t.id} className={`template-pick-row ${t.id === clip.templateId ? 'active' : ''}`}>
                <div className="stack">
                  <b>{t.name}</b>
                  <span className="muted small">
                    {LAYOUTS.find((l) => l.id === t.look.framing.layout)?.label}
                    {t.look.subtitles.enabled ? ' · sous-titres' : ''}
                    {t.look.intro.enabled ? ' · intro' : ''}
                    {t.look.logo.enabled ? ' · logo' : ''}
                  </span>
                </div>
                <button className={`btn small ${t.id === clip.templateId ? '' : 'primary'}`} onClick={() => props.onApply(t)}>
                  {t.id === clip.templateId ? 'Réappliquer' : 'Appliquer'}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Enregistrer ce montage">
        {template && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api().updateTemplate(template.id, { look: clip.look })
                props.onMessage(`Patte « ${template.name} » mise à jour avec ce montage.`)
              })
            }
          >
            Mettre à jour la patte « {template.name} »
          </button>
        )}
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la nouvelle patte" />
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(async () => {
                const t = await api().createTemplate(name, clip.look)
                props.onLinked(t.id)
                setName('')
                props.onMessage(`Patte « ${t.name} » créée.`)
              })
            }
          >
            Créer la patte
          </button>
        </div>
      </Section>
      <Section title="L’utiliser pour les prochains clips">
        {props.templates.length === 0 ? (
          <p className="muted small">Crée d’abord une patte juste au-dessus.</p>
        ) : (
          <div className="stack">
            {(template ? [template] : props.templates.slice(-1)).map((t) => (
              <div key={t.id} className="stack">
                <button
                  className="btn"
                  disabled={busy || props.channelTemplate === t.id}
                  onClick={() =>
                    void run(async () => {
                      await api().setChannelTemplate(clip.channel, t.id)
                      props.onMessage(`Les prochains clips de ${clip.channel} auront la patte « ${t.name} ».`)
                    })
                  }
                >
                  {props.channelTemplate === t.id ? `✓ Patte des clips de ${clip.channel}` : `Pour les prochains clips de ${clip.channel}`}
                </button>
                <button
                  className="btn"
                  disabled={busy || props.defaultTemplate === t.id}
                  onClick={() =>
                    void run(async () => {
                      await api().setDefaultTemplate(t.id)
                      props.onMessage(`« ${t.name} » est maintenant la patte par défaut de toutes les chaînes.`)
                    })
                  }
                >
                  {props.defaultTemplate === t.id ? '✓ Patte par défaut partout' : 'Pour toutes les chaînes (par défaut)'}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="L’appliquer aux clips déjà faits">
        <Select
          value={scope}
          options={[
            { value: 'channel', label: `Clips de ${clip.channel} (${props.clips.filter((c) => eligible(c) && c.channel === clip.channel).length})` },
            { value: 'all', label: `Tous mes clips (${props.clips.filter(eligible).length})` }
          ]}
          onChange={setScope}
        />
        <Toggle label="Inclure les clips terminés" hint="Ils retourneront dans « Gardés » jusqu’à ce que tu les termines à nouveau" checked={withDone} onChange={setWithDone} />
        <Toggle label="Refaire aussi le rendu vidéo" hint="Sinon seuls les clips déjà validés sont refaits" checked={rerender} onChange={setRerender} />
        <button
          className="btn primary"
          disabled={busy || targets.length === 0}
          onClick={() =>
            void run(async () => {
              if (!confirm(`Appliquer ce montage à ${targets.length} clip(s) ? Leur cadrage et leur style seront remplacés.`)) return
              const n = await api().applyLook(
                targets.map((c) => c.id),
                clip.look,
                template?.id ?? null,
                rerender
              )
              props.onMessage(`Montage appliqué à ${n} clip(s).`)
            })
          }
        >
          Appliquer à {targets.length} clip(s)
        </button>
      </Section>
    </>
  )
}
