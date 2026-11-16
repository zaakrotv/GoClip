// File d'attente des travaux lourds (analyse, clips du live, transcription, rendu), exécutés un par un.
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { cloneLook, editSignature } from '../shared/presets'
import type { Clip, Job, JobKind, Look, QueueState } from '../shared/types'
import { analyzeRecording, chatFile, cutClip, marksFile, sameMoment } from './analyze'
import { depsStatus, modelFile } from './deps'
import type { Candidate } from './detect'
import { procContext, ProcGroup } from './proc'
import { renderClip } from './render'
import { addClips, clipById, getClips, getSettings, getTemplates, removeClips, updateClip } from './store'
import { transcribeFile } from './transcribe'

type Task =
  | { kind: 'analyze'; file: string }
  | { kind: 'live-clip'; file: string; moment: Candidate }
  | { kind: 'transcribe'; clipId: string }
  | { kind: 'render'; clipId: string; finish: boolean }

interface Item {
  job: Job
  task: Task
  priority: number
}

interface Hooks {
  onQueue: () => void
  onClips: () => void
  notify: (title: string, body: string) => void
}

let hooks: Hooks = { onQueue: () => {}, onClips: () => {}, notify: () => {} }
let pending: Item[] = []
let running: { item: Item; abort: AbortController; group: ProcGroup } | null = null
let lastEmit = 0
let closed = false
/** File en pause (bouton ⏸ de la petite case en bas à gauche). */
let paused = false
/** Découpes des clips du live : rapides, elles passent à côté de la file (même en pause). */
let side: Job[] = []
let sideChain: Promise<void> = Promise.resolve()

export function initJobs(h: Hooks): void {
  hooks = h
}

export function queueState(): QueueState {
  return { running: running ? { ...running.item.job } : null, pending: pending.map((p) => ({ ...p.job })), paused, side: side.map((j) => ({ ...j })) }
}

function emitQueue(force = false): void {
  const now = Date.now()
  if (!force && now - lastEmit < 250) return
  lastEmit = now
  hooks.onQueue()
}

function push(kind: JobKind, task: Task, label: string, priority: number, clipId: string | null, file: string | null): void {
  if (closed) return
  pending.push({ job: { id: randomUUID(), kind, label, progress: 0, step: 'En attente', clipId, file, held: false }, task, priority })
  pending.sort((a, b) => a.priority - b.priority)
  emitQueue(true)
  void pump()
}

const hasTask = (pred: (t: Task) => boolean): boolean => (running !== null && pred(running.item.task)) || pending.some((p) => pred(p.task))

export function enqueueAnalysis(file: string): void {
  if (hasTask((t) => t.kind === 'analyze' && t.file === file)) return
  push('analyze', { kind: 'analyze', file }, `Analyse de ${basename(file)}`, 2, null, file)
}

/**
 * Clip demandé pendant le live (touche Clip, « clip » écrit ou dit) : découpé tout de suite,
 * à côté de la file (une découpe sans réencodage prend quelques secondes), même si un long
 * rendu tourne ou si la file est en pause.
 */
export function enqueueLiveClip(file: string, moment: Candidate): void {
  if (closed) return
  const job: Job = { id: randomUUID(), kind: 'live-clip', label: 'Nouveau clip du live', progress: 0, step: 'Découpe', clipId: null, file, held: false }
  side = [...side, job]
  emitQueue(true)
  sideChain = sideChain.then(async () => {
    try {
      await runLiveClip(file, moment, new AbortController().signal)
    } catch (err) {
      console.error('[clip du live]', err)
      hooks.notify('Clip du live impossible', err instanceof Error ? err.message : String(err))
    } finally {
      side = side.filter((j) => j.id !== job.id)
      emitQueue(true)
    }
  })
}

export function enqueueTranscription(clipId: string, priority = 3): void {
  if (hasTask((t) => t.kind === 'transcribe' && t.clipId === clipId)) return
  push('transcribe', { kind: 'transcribe', clipId }, 'Transcription d’un clip', priority, clipId, null)
}

/** Lance un rendu ; `finish` = mettre le clip dans « Rendus » une fois la vidéo prête. */
export function enqueueRender(clipId: string, priority = 1, finish = false): void {
  const already = pending.find((p) => p.task.kind === 'render' && p.task.clipId === clipId)
  if (already && already.task.kind === 'render') {
    already.task.finish ||= finish
    return
  }
  const clip = clipById(clipId)
  if (!clip) return
  updateClip(clipId, { render: { ...clip.render, state: 'queued', error: null } })
  hooks.onClips()
  push('render', { kind: 'render', clipId, finish }, `Rendu : ${clip.title || 'clip'}`, priority, clipId, null)
}

/** Arrête le travail en cours (même s'il est en pause). */
function abortRunning(): void {
  if (!running) return
  running.abort.abort()
  running.group.release()
}

/** Annule les travaux en attente ou en cours d'un clip. */
export function cancelClipJobs(clipId: string): void {
  pending = pending.filter((p) => p.job.clipId !== clipId)
  if (running?.item.job.clipId === clipId) abortRunning()
  const clip = clipById(clipId)
  if (clip && (clip.render.state === 'queued' || clip.render.state === 'running')) {
    updateClip(clipId, { render: { ...clip.render, state: clip.output ? 'done' : 'idle', progress: 0 } })
    hooks.onClips()
  }
  emitQueue(true)
}

export function cancelJob(jobId: string): void {
  const p = pending.find((x) => x.job.id === jobId) ?? (running?.item.job.id === jobId ? running.item : undefined)
  if (p?.job.clipId) return cancelClipJobs(p.job.clipId)
  pending = pending.filter((x) => x.job.id !== jobId)
  if (running?.item.job.id === jobId) abortRunning()
  emitQueue(true)
}

/** Annule tout ce qui est en attente et le travail en cours. */
export function cancelAllJobs(): void {
  const ids = [...new Set([...pending.map((p) => p.job.clipId), running?.item.job.clipId ?? null].filter((x): x is string => !!x))]
  pending = []
  abortRunning()
  for (const id of ids) cancelClipJobs(id)
  emitQueue(true)
}

/**
 * Pause : le travail en cours est suspendu (il reprend là où il en était) et rien d'autre
 * ne démarre. Les clips du live continuent d'être découpés.
 */
export async function pauseQueue(on: boolean): Promise<void> {
  paused = on
  emitQueue(true)
  if (running) {
    if (on) await running.group.suspend()
    else await running.group.resume()
  }
  emitQueue(true)
  if (!on) void pump()
}

/** Met de côté un travail en attente (ou le relance). */
export function holdJob(jobId: string, held: boolean): void {
  const p = pending.find((x) => x.job.id === jobId)
  if (!p) return
  p.job.held = held
  p.job.step = held ? 'Mis de côté' : 'En attente'
  emitQueue(true)
  if (!held) void pump()
}

/** Fait passer un travail en attente avant tous les autres. */
export function prioritizeJob(jobId: string): void {
  const p = pending.find((x) => x.job.id === jobId)
  if (!p) return
  p.priority = Math.min(...pending.map((x) => x.priority)) - 1
  p.job.held = false
  pending = [p, ...pending.filter((x) => x !== p)]
  emitQueue(true)
  void pump()
}

/** Fermeture de l'application : plus aucun travail ne démarre. */
export function stopAll(): void {
  closed = true
  pending = []
  abortRunning()
}

function canTranscribe(): boolean {
  const s = getSettings()
  const d = depsStatus()
  return s.transcription.enabled && d.whisper && existsSync(modelFile(s.transcription.model))
}

async function pump(): Promise<void> {
  if (running || paused || closed) return
  const index = pending.findIndex((p) => !p.job.held)
  if (index < 0) return
  const item = pending.splice(index, 1)[0]
  const abort = new AbortController()
  const group = new ProcGroup()
  running = { item, abort, group }
  emitQueue(true)
  const step = (label: string, progress: number): void => {
    item.job.step = label
    item.job.progress = Math.max(0, Math.min(1, progress))
    emitQueue()
  }
  try {
    const t = item.task
    // Tout ce que lance ce travail (ffmpeg, whisper) est rattaché à son groupe : la pause le suspend.
    await procContext.run(group, async () => {
      if (t.kind === 'analyze') await runAnalyze(t.file, abort.signal, step)
      else if (t.kind === 'live-clip') await runLiveClip(t.file, t.moment, abort.signal)
      else if (t.kind === 'transcribe') await runTranscribe(t.clipId, abort.signal, step)
      else await runRender(t.clipId, t.finish, abort.signal, step)
    })
  } catch (err) {
    console.error('[travaux]', item.job.label, err)
    const msg = err instanceof Error ? err.message : String(err)
    if ((item.task.kind === 'analyze' || item.task.kind === 'live-clip') && !abort.signal.aborted) hooks.notify(item.task.kind === 'analyze' ? 'Analyse impossible' : 'Clip du live impossible', msg)
  } finally {
    running = null
    emitQueue(true)
    void pump()
  }
}

/** Après la création d'un clip : transcription et/ou rendu automatiques selon les réglages. */
function followUp(clips: Clip[]): void {
  const s = getSettings()
  for (const c of clips) {
    if (s.render.auto) enqueueRender(c.id, 4)
    else if (canTranscribe() && c.look.subtitles.enabled) enqueueTranscription(c.id, 3)
  }
}

async function runAnalyze(file: string, signal: AbortSignal, step: (l: string, p: number) => void): Promise<void> {
  if (!existsSync(file)) return
  // Nouvelle analyse du même live : les anciens clips pas encore triés sont remplacés,
  // sauf ceux créés pendant le live ; les clips gardés ne sont pas refaits en double.
  const old = getClips().filter((c) => c.recording === file && c.status === 'new' && !c.live)
  const kept = getClips().filter((c) => c.recording === file && !old.includes(c) && c.segment)
  const clips = await analyzeRecording(file, { signal, step, skip: kept.map((c) => c.segment!) })
  deleteClipFiles(removeClips(old.map((c) => c.id)), false)
  addClips(clips)
  hooks.onClips()
  if (clips.length > 0) hooks.notify('Nouveaux clips', `${clips.length} clip${clips.length > 1 ? 's' : ''} trouvé${clips.length > 1 ? 's' : ''} dans le live de ${clips[0].channel}.`)
  followUp(clips)
  if (getSettings().deleteRecordingAfterAnalysis) {
    for (const f of [file, chatFile(file), marksFile(file)]) rmSync(f, { force: true })
  }
}

async function runLiveClip(file: string, moment: Candidate, signal: AbortSignal): Promise<void> {
  if (!existsSync(file)) return
  // Déjà découpé (tchat « clip » juste avant, analyse de fin de live…) : on ne refait pas le clip,
  // mais il garde la trace de la nouvelle raison (par exemple la touche Clip).
  const existing = getClips().find((c) => c.recording === file && c.segment && sameMoment(c.segment, moment))
  if (existing) {
    const reasons = [...new Set([...existing.reasons, ...moment.reasons])]
    if (reasons.length !== existing.reasons.length) {
      updateClip(existing.id, { reasons })
      hooks.onClips()
    }
    return
  }
  const clip = await cutClip(file, moment, { live: true, signal })
  addClips([clip])
  hooks.onClips()
  hooks.notify('Clip ajouté', `Un nouveau clip de ${clip.channel} est dans « À trier ».`)
  followUp([clip])
}

async function runTranscribe(clipId: string, signal: AbortSignal, step: (l: string, p: number) => void): Promise<void> {
  const clip = clipById(clipId)
  if (!clip) return
  const s = getSettings()
  step('Transcription', 0)
  try {
    const words = await transcribeFile(clip.source, clip.id, { language: s.transcription.language, model: s.transcription.model, signal, onProgress: (f) => step('Transcription', f) })
    updateClip(clipId, { words, transcribeError: null })
  } catch (err) {
    if (!signal.aborted) updateClip(clipId, { transcribeError: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    hooks.onClips()
  }
}

function safeName(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
}

/** Rendu de travail : refait à chaque validation, rangé avec les enregistrements. */
function workingPath(clip: Clip): string {
  return join(getSettings().recordingsDir, clip.channel, 'montages', `${clip.id}.mp4`)
}

/** Vidéo terminée, dans « Clips prêts / <chaîne> », nommée d'après son titre. */
function finalPath(clip: Clip): string {
  const d = new Date(clip.momentAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  const fallback = `${clip.channel} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`
  const base = safeName(clip.title) || fallback
  const dir = join(getSettings().readyDir, clip.channel)
  const taken = new Set(getClips().filter((c) => c.id !== clip.id && c.final).map((c) => c.final!.toLowerCase()))
  for (let i = 1; ; i++) {
    const f = join(dir, i === 1 ? `${base}.mp4` : `${base} (${i}).mp4`)
    const mine = f.toLowerCase() === clip.final?.toLowerCase() || f.toLowerCase() === clip.output?.toLowerCase()
    if (!taken.has(f.toLowerCase()) && (!existsSync(f) || mine)) return f
  }
}

/** Le rendu correspond-il encore au montage actuel ? */
export function renderUpToDate(clip: Clip): boolean {
  return !!clip.output && existsSync(clip.output) && clip.renderSig === editSignature(clip)
}

/** Met un clip dans « Rendus » : sa vidéo finale est déplacée dans « Clips prêts ». */
function finalize(clipId: string): void {
  const clip = clipById(clipId)
  if (!clip?.output || !existsSync(clip.output)) return
  const target = finalPath(clip)
  if (clip.output.toLowerCase() !== target.toLowerCase()) {
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { force: true })
    try {
      renameSync(clip.output, target)
    } catch {
      copyFileSync(clip.output, target) // autre disque : copie puis suppression
      rmSync(clip.output, { force: true })
    }
  }
  if (clip.final && clip.final.toLowerCase() !== target.toLowerCase()) rmSync(clip.final, { force: true })
  updateClip(clipId, { status: 'done', final: target, output: target })
}

/** « Terminé » : le clip va dans Rendus (avec un rendu à jour, refait si besoin). */
export function finishClips(ids: string[]): void {
  for (const id of ids) {
    const clip = clipById(id)
    if (!clip || clip.status === 'trash') continue
    if (renderUpToDate(clip)) finalize(id)
    else enqueueRender(id, 1, true)
  }
  hooks.onClips()
}

async function runRender(clipId: string, finish: boolean, signal: AbortSignal, step: (l: string, p: number) => void): Promise<void> {
  let clip = clipById(clipId)
  if (!clip) return
  updateClip(clipId, { render: { state: 'running', progress: 0, error: null, at: clip.render.at } })
  hooks.onClips()
  try {
    const s = getSettings()
    const needWords = clip.look.subtitles.enabled && clip.words === null && canTranscribe()
    if (needWords) {
      step('Transcription', 0)
      const words = await transcribeFile(clip.source, clip.id, { language: s.transcription.language, model: s.transcription.model, signal, onProgress: (f) => step('Transcription', f * 0.4) })
      clip = updateClip(clipId, { words, transcribeError: null }) ?? clip
    }
    const base = needWords ? 0.4 : 0
    step('Rendu de la vidéo', base)
    const sig = editSignature(clip)
    const out = workingPath(clip)
    await renderClip(clip, out, { fps: s.render.fps, encoder: s.render.encoder === 'libx264' ? 'libx264' : depsStatus().encoder ?? 'libx264', signal, onProgress: (f) => step('Rendu de la vidéo', base + f * (1 - base)) })
    // L'ancien rendu de travail est remplacé (jamais la vidéo terminée de « Clips prêts »).
    const current = clipById(clipId)
    if (current?.output && current.output.toLowerCase() !== out.toLowerCase() && current.output !== current.final) rmSync(current.output, { force: true })
    updateClip(clipId, { output: out, renderSig: sig, render: { state: 'done', progress: 1, error: null, at: Date.now() } })
    if (finish) finalize(clipId)
  } catch (err) {
    const current = clipById(clipId)
    if (current) {
      updateClip(clipId, {
        render: signal.aborted
          ? { ...current.render, state: current.output ? 'done' : 'idle', progress: 0 }
          : { state: 'error', progress: 0, error: err instanceof Error ? err.message : String(err), at: current.render.at }
      })
    }
    throw err
  } finally {
    hooks.onClips()
  }
}

/** « Garder » (depuis À trier ou la corbeille), en appliquant au passage la patte choisie. */
export function keepClips(ids: string[], templateId?: string | null): void {
  const t = templateId ? getTemplates().find((x) => x.id === templateId) : undefined
  if (t) applyLookToClips(ids, t.look, t.id, false)
  for (const id of ids) {
    const clip = clipById(id)
    if (clip && (clip.status === 'new' || clip.status === 'trash')) updateClip(id, { status: 'kept' })
  }
  hooks.onClips()
}

/** Applique un look (une patte) à plusieurs clips ; refait le rendu de ceux déjà rendus. */
export function applyLookToClips(ids: string[], look: Look, templateId: string | null, render: boolean): number {
  let n = 0
  for (const id of ids) {
    const clip = clipById(id)
    if (!clip) continue
    // Un clip terminé qui change de montage retourne dans « Gardés » jusqu'à ce qu'on le termine à nouveau.
    updateClip(id, { look: cloneLook(look), templateId, ...(clip.status === 'done' ? { status: 'kept' as const } : {}) })
    n++
    if (render || clip.output) enqueueRender(id, 3)
  }
  hooks.onClips()
  return n
}

/** Supprime les fichiers de travail d'un clip (la vidéo terminée de « Clips prêts » est gardée). */
export function deleteClipFiles(clips: Clip[], withOutput: boolean): void {
  for (const c of clips) {
    cancelClipJobs(c.id)
    const files = [c.source, c.thumbnail, withOutput && c.output !== c.final ? c.output : null]
    for (const f of files) {
      if (f) {
        try {
          rmSync(f, { force: true })
        } catch (err) {
          console.error('[suppression]', f, err)
        }
      }
    }
  }
}
