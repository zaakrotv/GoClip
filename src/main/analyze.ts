// Analyse d'un enregistrement : repère les moments forts et découpe les clips.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { cloneLook } from '../shared/presets'
import type { Clip } from '../shared/types'
import { detectMoments, parseChatLog, type Candidate, type Mark } from './detect'
import { extractSegment, loudnessPerSecond, probe, thumbnail } from './ffmpeg'
import { readJson, writeJson } from './jsonfile'
import { getSettings, lookFor } from './store'

/** Secondes gardées avant et après chaque clip pour pouvoir l'allonger dans l'éditeur. */
const MARGIN = 10

const stem = (file: string): string => file.replace(/\.[^.\\/]+$/, '')
export const chatFile = (rec: string): string => `${stem(rec)}.chat.jsonl`
export const marksFile = (rec: string): string => `${stem(rec)}.marques.json`
export const analysisFile = (rec: string): string => `${stem(rec)}.analyse.json`
export const channelOf = (rec: string): string => basename(dirname(rec)).toLowerCase()

export function isAnalyzed(rec: string): { clips: number } | null {
  return existsSync(analysisFile(rec)) ? readJson<{ clips: number }>(analysisFile(rec), { clips: 0 }) : null
}

/** Heure de début d'un enregistrement, lue dans son nom (pseudo-AAAA-MM-JJ-HHhMMmSS.ts). */
export function recordingStart(rec: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})h(\d{2})m(\d{2})/.exec(basename(rec))
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  try {
    return statSync(rec).birthtimeMs
  } catch {
    return Date.now()
  }
}

/** Deux passages sont « le même moment » s'ils se recouvrent sur au moins la moitié du plus court. */
export function sameMoment(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start)
  return overlap > 0 && overlap >= 0.5 * Math.min(a.end - a.start, b.end - b.start)
}

/**
 * Découpe un moment de l'enregistrement (même s'il est encore en cours d'écriture)
 * et en fait un clip prêt à trier.
 */
export async function cutClip(rec: string, m: Candidate, opts: { live: boolean; signal?: AbortSignal; duration?: number }): Promise<Clip> {
  const channel = channelOf(rec)
  const { look, templateId } = lookFor(channel)
  const outDir = join(dirname(rec), 'clips')
  mkdirSync(outDir, { recursive: true })
  const srcStart = Math.max(0, m.start - MARGIN)
  const srcEnd = opts.duration ? Math.min(opts.duration, m.end + MARGIN) : m.end + (opts.live ? 3 : MARGIN)
  const id = randomUUID()
  const file = join(outDir, `${basename(stem(rec))}-clip-${id.slice(0, 8)}.mp4`)
  const cut = await extractSegment(rec, srcStart, srcEnd - srcStart, file, opts.signal)
  const shift = (t: number): number => Math.round((t - srcStart + cut.offset) * 100) / 100
  const thumb = file.replace(/\.mp4$/, '.jpg')
  const hasThumb = await thumbnail(file, shift(m.peak), thumb)
  return {
    id,
    channel,
    recording: rec,
    momentAt: recordingStart(rec) + m.peak * 1000,
    source: file,
    sourceDuration: cut.duration,
    start: Math.max(0, shift(m.start)),
    end: Math.min(cut.duration, shift(m.end)),
    peak: shift(m.peak),
    score: m.score,
    level: m.level,
    reasons: m.reasons,
    chatWord: m.chatWord,
    status: 'new',
    createdAt: Date.now(),
    thumbnail: hasThumb ? thumb : null,
    // « clip : headshot » dans le tchat : le clip s'appelle « headshot ».
    title: m.title ?? '',
    words: null,
    transcribeError: null,
    look: cloneLook(look),
    templateId,
    output: null,
    renderSig: null,
    final: null,
    live: opts.live,
    segment: { start: m.start, end: m.end },
    render: { state: 'idle', progress: 0, error: null, at: null }
  }
}

export interface AnalyzeContext {
  signal?: AbortSignal
  step: (label: string, progress: number) => void
  /** Moments déjà découpés pendant le live : on ne les refait pas. */
  skip?: { start: number; end: number }[]
}

export async function analyzeRecording(rec: string, ctx: AnalyzeContext): Promise<Clip[]> {
  const settings = getSettings()
  ctx.step('Lecture de la vidéo', 0.01)
  const info = await probe(rec)
  if (!info.hasVideo) throw new Error('Ce fichier ne contient pas de vidéo lisible.')

  ctx.step('Écoute du son', 0.02)
  const loudness = info.hasAudio ? await loudnessPerSecond(rec, info.duration, (f) => ctx.step('Écoute du son', 0.02 + f * 0.6), ctx.signal) : []
  const duration = Math.max(info.duration, loudness.length)

  ctx.step('Lecture du tchat', 0.63)
  const chat = existsSync(chatFile(rec)) ? parseChatLog(readFileSync(chatFile(rec), 'utf8'), settings.detection.chatWords) : null
  const marks = readJson<{ marks: Mark[] }>(marksFile(rec), { marks: [] }).marks

  const skip = ctx.skip ?? []
  const moments = detectMoments({ duration, loudness, chat: chat?.weights ?? null, requests: chat?.requests ?? [], marks }, settings.detection).filter(
    (m) => !skip.some((s) => sameMoment(s, m))
  )

  const clips: Clip[] = []
  for (const [i, m] of moments.entries()) {
    if (ctx.signal?.aborted) throw new Error('Analyse arrêtée')
    ctx.step(`Découpe du clip ${i + 1} sur ${moments.length}`, 0.65 + (0.34 * i) / Math.max(1, moments.length))
    clips.push(await cutClip(rec, m, { live: false, signal: ctx.signal, duration }))
  }
  writeJson(analysisFile(rec), { analyzedAt: Date.now(), clips: clips.length + skip.length, duration })
  ctx.step('Terminé', 1)
  return clips
}
