// Transcription mot par mot avec whisper.cpp (tourne en local, sans internet).
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import type { WhisperModel, Word } from '../shared/types'
import { dtwPreset, modelFile, vadFile, whisperExe } from './deps'
import { extractWav } from './ffmpeg'
import { tempDir } from './paths'
import { run } from './proc'

interface WhisperToken {
  text: string
  offsets?: { from: number; to: number }
  t_dtw?: number
}

interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: WhisperToken[]
}

export interface TranscribeOptions {
  language: string
  model: WhisperModel
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export async function transcribeFile(source: string, id: string, opts: TranscribeOptions): Promise<Word[]> {
  const exe = whisperExe()
  if (!exe) throw new Error('Whisper n’est pas installé : installe-le dans Réglages.')
  const model = modelFile(opts.model)
  if (!existsSync(model)) throw new Error('Le modèle de transcription n’est pas téléchargé : va dans Réglages.')
  const work = join(tempDir(), `voix-${id}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  try {
    const wav = join(work, 'son.wav')
    await extractWav(source, wav, opts.signal)
    const args = [
      '-m', model,
      '-f', wav,
      '-l', opts.language || 'fr',
      '-t', String(Math.max(2, availableParallelism() - 2)),
      '-ojf',
      '-of', join(work, 'texte'),
      '-np',
      '-pp',
      '-sns',
      // L'« attention flash » (activée par défaut) empêche de calculer l'instant de chaque mot.
      '-nfa',
      '-dtw', dtwPreset(opts.model)
    ]
    const onStderr = (chunk: string): void => {
      const m = /progress\s*=\s*(\d+)%/.exec(chunk)
      if (m) opts.onProgress?.(Number(m[1]) / 100)
    }
    let r = await run(exe, args, { signal: opts.signal, onStderr, timeoutMs: 30 * 60_000 })
    // Problème avec la carte graphique : nouvel essai sur le processeur.
    if (r.code !== 0 && !r.aborted) r = await run(exe, [...args, '-ng'], { signal: opts.signal, onStderr, timeoutMs: 30 * 60_000 })
    if (r.aborted) throw new Error('Transcription arrêtée')
    if (r.code !== 0 || !existsSync(join(work, 'texte.json'))) {
      console.error('[whisper]', r.stderr.slice(-2000))
      throw new Error('Whisper n’a pas pu transcrire ce clip.')
    }
    const json = JSON.parse(readFileSync(join(work, 'texte.json'), 'utf8')) as { transcription?: WhisperSegment[] }
    const segments = (json.transcription ?? []).filter((s) => !HALLUCINATION.test(s.text))
    // Les zones de vraie parole servent à recaler les mots mal placés et à écarter le texte inventé.
    const speech = await speechZones(exe, wav, opts.signal)
    return wordsFromSegments(segments, speech)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export interface Zone {
  start: number
  end: number
}

/** Phrases que Whisper invente souvent sur du silence ou de la musique. */
const HALLUCINATION = /amara\.org|sous-titr(?:age|es)\s+(?:st'?\s*501|réalisés?|par la communauté)|^\s*\(?(?:musique|applaudissements|rires)\)?\s*$/i

/**
 * Zones de parole repérées par le détecteur de voix de whisper.cpp (s'il est présent).
 * Renvoie null en cas de doute : dans ce cas on ne filtre rien.
 */
async function speechZones(cli: string, wav: string, signal?: AbortSignal): Promise<Zone[] | null> {
  const tool = join(dirname(cli), 'whisper-vad-speech-segments.exe')
  if (!existsSync(tool) || !existsSync(vadFile())) return null
  const r = await run(tool, ['-vm', vadFile(), '-f', wav, '-np'], { signal, timeoutMs: 5 * 60_000 })
  if (r.code !== 0) return null
  const zones = [...`${r.stdout}\n${r.stderr}`.matchAll(/start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/g)].map((m) => ({ start: Number(m[1]) / 100, end: Number(m[2]) / 100 }))
  return zones.length > 0 ? zones : null
}

/**
 * Recale les mots placés hors des zones de parole (défaut connu du calcul mot par mot
 * après un long silence) : ils sont répartis juste avant le mot suivant de la phrase.
 * Renvoie null si aucun mot de la phrase n'est dans une zone de parole (texte inventé).
 */
export function snapToSpeech(words: { text: string; start: number }[], zones: Zone[]): { text: string; start: number }[] | null {
  const zoneOf = (t: number): Zone | undefined => zones.find((z) => t >= z.start - 0.3 && t <= z.end + 0.3)
  if (!words.some((w) => zoneOf(w.start))) return null
  const out = words.map((w) => ({ ...w }))
  let i = out.length - 1
  while (i >= 0) {
    if (zoneOf(out[i].start)) {
      i--
      continue
    }
    let j = i
    while (j > 0 && !zoneOf(out[j - 1].start)) j--
    const count = i - j + 1
    const next = out[i + 1]
    if (next) {
      const zone = zoneOf(next.start)!
      const from = Math.max(zone.start, next.start - 0.3 * count)
      const step = Math.max(0.05, (next.start - from) / count)
      for (let k = j; k <= i; k++) out[k].start = next.start - step * (i - k + 1)
    } else {
      const prev = out[j - 1]
      for (let k = j; k <= i; k++) out[k].start = prev.start + 0.25 * (k - j + 1)
    }
    i = j - 1
  }
  return out
}

/** Reconstitue les mots (avec leur instant) à partir des morceaux de mots de whisper. */
export function wordsFromSegments(segments: WhisperSegment[], zones: Zone[] | null = null): Word[] {
  const out: Word[] = []
  for (const seg of segments) {
    const segStart = seg.offsets.from / 1000
    const segEnd = seg.offsets.to / 1000
    let words: { text: string; start: number }[] = []
    for (const tok of seg.tokens ?? []) {
      const text = tok.text ?? ''
      if (text.startsWith('[_') || text.startsWith('<|') || text === '') continue
      const t = typeof tok.t_dtw === 'number' && tok.t_dtw >= 0 ? tok.t_dtw / 100 : (tok.offsets?.from ?? seg.offsets.from) / 1000
      if (text.startsWith(' ') || words.length === 0) words.push({ text: text.trim(), start: Math.max(segStart, t) })
      else words[words.length - 1].text += text
    }
    // Les accents peuvent être coupés entre deux morceaux : on reprend le texte complet du segment.
    const fromText = seg.text.trim().split(/\s+/).filter(Boolean)
    if (fromText.length === words.length) words.forEach((w, i) => (w.text = fromText[i]))
    if (zones && words.length > 0) {
      const snapped = snapToSpeech(words, zones)
      if (!snapped) continue
      words = snapped
    }
    // Mots qui démarrent au même instant : on les étale un peu.
    for (let i = 1; i < words.length; i++) if (words[i].start <= words[i - 1].start) words[i].start = words[i - 1].start + 0.08
    words.forEach((w, i) => {
      const next = i + 1 < words.length ? words[i + 1].start : segEnd
      const end = Math.max(w.start + 0.1, Math.min(next, w.start + 1.2))
      if (/[\p{L}\p{N}]/u.test(w.text)) out.push({ text: w.text, start: round(w.start), end: round(end) })
      else if (out.length > 0) out[out.length - 1].text += w.text
    })
  }
  return out
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
