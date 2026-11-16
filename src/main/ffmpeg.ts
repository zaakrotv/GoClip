// Fonctions ffmpeg : analyse des fichiers, mesure du son, extraction, vignettes.
import { spawn } from 'node:child_process'
import { ffmpegExe } from './deps'
import { killTree, run, trackChild, type RunResult } from './proc'

export function ff(): string {
  const exe = ffmpegExe()
  if (!exe) throw new Error('FFmpeg est introuvable : installe les outils dans Réglages.')
  return exe
}

export interface MediaInfo {
  duration: number
  start: number
  width: number
  height: number
  fps: number
  hasVideo: boolean
  hasAudio: boolean
  /** Codec vidéo (h264, vp9, prores…). */
  vcodec: string
  /** Vidéo avec transparence (WebM VP9/VP8 avec couche alpha). */
  alpha: boolean
}

/** Lit les informations d'un fichier via « ffmpeg -i » (pas besoin de ffprobe). */
export async function probe(file: string): Promise<MediaInfo> {
  const r = await run(ff(), ['-hide_banner', '-i', file], { timeoutMs: 60_000 })
  return parseProbe(r.stderr)
}

export function parseProbe(s: string): MediaInfo {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s)
  const start = Number(/start: (-?[\d.]+)/.exec(s)?.[1]) || 0
  const video = /Stream #\d+:\d+[^\n]*: Video: [^\n]*/.exec(s)?.[0] ?? ''
  const size = /, (\d{2,5})x(\d{2,5})[\s,[]/.exec(video)
  const fps = Number(/, ([\d.]+) fps/.exec(video)?.[1]) || Number(/, ([\d.]+) tbr/.exec(video)?.[1]) || 30
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    start,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    fps,
    hasVideo: video !== '',
    hasAudio: /Stream #\d+:\d+[^\n]*: Audio:/.test(s),
    vcodec: /Video: ([a-z0-9_]+)/i.exec(video)?.[1]?.toLowerCase() ?? '',
    alpha: /alpha_mode\s*:\s*1/i.test(s)
  }
}

export interface FfmpegOptions {
  cwd?: string
  signal?: AbortSignal
  /** Durée attendue de la sortie, pour calculer la progression. */
  duration?: number
  onProgress?: (fraction: number) => void
}

/** Lance ffmpeg avec suivi de progression. */
export function ffmpeg(args: string[], opts: FfmpegOptions = {}): Promise<RunResult> {
  let buffer = ''
  return run(ff(), ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
    cwd: opts.cwd,
    signal: opts.signal,
    keep: 20_000,
    onStdout: (chunk) => {
      if (!opts.onProgress || !opts.duration) return
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim())
        if (m) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.duration))
      }
    }
  })
}

export function ffmpegError(r: RunResult, what: string): Error {
  if (/No space left on device/i.test(r.stderr)) return new Error('Plus de place sur le disque.')
  const detail = r.stderr.trim().split('\n').slice(-3).join(' · ').slice(-400)
  return new Error(`${what} : ${detail || `ffmpeg s'est arrêté (code ${r.code})`}`)
}

/**
 * Volume (dB) de chaque seconde du son : le son est décodé en mono 8 kHz
 * et on calcule l'énergie moyenne par seconde.
 */
export function loudnessPerSecond(file: string, expected: number, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const rate = 8000
    const child = spawn(ff(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-vn', '-af', `aresample=${rate}:async=1:first_pts=0`, '-ac', '1', '-f', 's16le', '-'], { windowsHide: true })
    // Rattaché au travail en cours : il est suspendu avec lui quand on met la file en pause.
    trackChild(child)
    const abort = (): void => killTree(child.pid)
    signal?.addEventListener('abort', abort, { once: true })
    const out: number[] = []
    let sum = 0
    let count = 0
    let rest: Buffer | null = null
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = rest ? Buffer.concat([rest, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      rest = usable < buf.length ? buf.subarray(usable) : null
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i)
        sum += v * v
        if (++count === rate) {
          out.push(toDb(sum / count))
          sum = 0
          count = 0
          if (onProgress && expected > 0 && out.length % 30 === 0) onProgress(Math.min(1, out.length / expected))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (err = (err + d).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new Error('Analyse arrêtée'))
      if (count > rate / 4) out.push(toDb(sum / count))
      if (out.length === 0 && code !== 0) return reject(new Error(`Lecture du son impossible : ${err.slice(-300)}`))
      resolve(out)
    })
  })
}

function toDb(meanSquare: number): number {
  const rms = Math.sqrt(meanSquare) / 32768
  return rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90
}

/**
 * Copie un passage d'un enregistrement (sans réencoder).
 * Renvoie le décalage réel : la copie commence à l'image clé qui précède `start`,
 * donc le moment demandé se trouve `offset` secondes après le début du fichier.
 */
export async function extractSegment(src: string, start: number, duration: number, out: string, signal?: AbortSignal): Promise<{ offset: number; duration: number }> {
  const r = await ffmpeg(['-ss', start.toFixed(3), '-i', src, '-t', duration.toFixed(3), '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', out], { signal })
  if (r.code !== 0) throw ffmpegError(r, 'Extraction du clip impossible')
  const info = await probe(out)
  const offset = Math.min(4, Math.max(0, info.duration - duration))
  return { offset, duration: info.duration }
}

export async function thumbnail(src: string, at: number, out: string): Promise<boolean> {
  const r = await ffmpeg(['-ss', Math.max(0, at).toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out])
  return r.code === 0
}

export async function extractWav(src: string, out: string, signal?: AbortSignal): Promise<void> {
  const r = await ffmpeg(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { signal })
  if (r.code !== 0) throw ffmpegError(r, 'Extraction du son impossible')
}
