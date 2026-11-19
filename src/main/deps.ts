// Outils externes : Streamlink (avec ffmpeg), whisper.cpp et ses modèles.
// Tout est téléchargé depuis les sources officielles au premier lancement,
// puis rangé dans le dossier de données de l'application.
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { DepsStatus, WhisperModel } from '../shared/types'
import { encoderArgs } from './encoders'
import { depsDir, modelsDir, streamlinkRoot, whisperRoot } from './paths'
import { run } from './proc'

const UA = { 'User-Agent': 'AutoClip' }

export const MODELS: Record<WhisperModel, { file: string; url: string; label: string; dtw: string }> = {
  base: {
    file: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    label: 'Rapide (≈ 60 Mo)',
    dtw: 'base'
  },
  small: {
    file: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    label: 'Équilibré (≈ 190 Mo)',
    dtw: 'small'
  },
  'large-v3-turbo': {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    label: 'Précis (≈ 570 Mo)',
    dtw: 'large.v3.turbo'
  }
}
const VAD = {
  file: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin'
}

interface Found {
  streamlink: string | null
  ffmpeg: string | null
  whisper: string | null
}

let found: Found = { streamlink: null, ffmpeg: null, whisper: null }
let status: DepsStatus = {
  streamlink: false,
  ffmpeg: false,
  whisper: false,
  model: false,
  vad: false,
  ass: null,
  encoder: null,
  download: null,
  error: null
}
let listener: (s: DepsStatus) => void = () => {}
let busy: Promise<void> | null = null

export function onDepsChange(fn: (s: DepsStatus) => void): void {
  listener = fn
}

export function depsStatus(): DepsStatus {
  return status
}

function emit(patch: Partial<DepsStatus>): void {
  status = { ...status, ...patch }
  listener(status)
}

export const streamlinkExe = (): string | null => found.streamlink
export const ffmpegExe = (): string | null => found.ffmpeg
export const whisperExe = (): string | null => found.whisper
export const modelFile = (m: WhisperModel): string => join(modelsDir(), MODELS[m].file)
export const vadFile = (): string => join(modelsDir(), VAD.file)
export const dtwPreset = (m: WhisperModel): string => MODELS[m].dtw

/** Progression d'un téléchargement fait ailleurs (IA gratuite), affichée dans le même bandeau. */
export function setDownloadProgress(download: DepsStatus['download']): void {
  emit({ download })
}

/** Cherche un fichier dans un dossier (profondeur limitée). */
export function findFile(dir: string, name: string, depth = 4): string | null {
  if (!existsSync(dir) || depth < 0) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.toLowerCase() === name.toLowerCase()) return join(dir, e)
  }
  for (const e of entries) {
    const p = join(dir, e)
    try {
      if (statSync(p).isDirectory()) {
        const r = findFile(p, name, depth - 1)
        if (r) return r
      }
    } catch {
      /* ignoré */
    }
  }
  return null
}

/** Cherche un programme dans le PATH (s'il est déjà installé sur le PC). */
function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    const p = join(dir, exe)
    if (existsSync(p)) return p
  }
  return null
}

export function refreshDeps(model: WhisperModel): DepsStatus {
  found = {
    streamlink: findFile(streamlinkRoot(), 'streamlink.exe') ?? onPath('streamlink.exe'),
    ffmpeg: findFile(join(depsDir(), 'ffmpeg'), 'ffmpeg.exe') ?? findFile(streamlinkRoot(), 'ffmpeg.exe') ?? onPath('ffmpeg.exe'),
    whisper: findFile(whisperRoot(), 'whisper-cli.exe')
  }
  emit({
    streamlink: !!found.streamlink,
    ffmpeg: !!found.ffmpeg,
    whisper: !!found.whisper,
    model: existsSync(modelFile(model)),
    vad: existsSync(vadFile())
  })
  return status
}

/** Vérifie que ffmpeg sait brûler des sous-titres (libass) et choisit l'encodeur vidéo. */
export async function probeFfmpeg(preferred: 'auto' | 'libx264'): Promise<void> {
  const ff = found.ffmpeg
  if (!ff) return
  const filters = await run(ff, ['-hide_banner', '-filters'], { timeoutMs: 20_000 })
  const ass = /\sass\s/.test(filters.stdout)
  let encoder = 'libx264'
  if (preferred === 'auto') {
    // Essai avec les vrais réglages du rendu (taille, qualité) : une carte graphique qui ne les
    // accepte pas n'est pas choisie.
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1080x1920:r=60:d=0.3', ...encoderArgs(enc), '-f', 'null', '-'], { timeoutMs: 20_000 })
      if (r.code === 0) {
        encoder = enc
        break
      }
    }
  }
  emit({ ass, encoder })
}

/**
 * Télécharge un fichier (dans `dest.part`, renommé à la fin). Un téléchargement coupé reprend
 * où il s'était arrêté au lancement suivant.
 */
export async function download(url: string, dest: string, name: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(join(dest, '..'), { recursive: true })
  const part = `${dest}.part`
  const have = existsSync(part) ? statSync(part).size : 0
  const res = await fetch(url, { headers: have > 0 ? { ...UA, Range: `bytes=${have}-` } : UA, redirect: 'follow', signal })
  // Morceau déjà complet ou fichier changé entre-temps : on repart de zéro.
  if (res.status === 416 && have > 0) {
    rmSync(part, { force: true })
    return download(url, dest, name, signal)
  }
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${name} : HTTP ${res.status})`)
  const resumed = have > 0 && res.status === 206
  const total = (Number(res.headers.get('content-length')) || 0) + (resumed ? have : 0)
  let done = resumed ? have : 0
  let last = 0
  emit({ download: { name, done, total } })
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length
      const now = Date.now()
      if (now - last > 250) {
        last = now
        emit({ download: { name, done, total } })
      }
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), counter, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal })
  if (total && done < total) throw new Error(`Téléchargement incomplet (${name})`)
  renameSync(part, dest)
}

export async function extractZip(zip: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const r = await run(tar, ['-xf', zip, '-C', dir], { timeoutMs: 10 * 60_000 })
  if (r.code !== 0) throw new Error(`Décompression impossible : ${r.stderr.slice(-300)}`)
}

interface GhAsset {
  name: string
  browser_download_url: string
}

export async function githubAsset(repo: string, match: (name: string) => boolean): Promise<GhAsset> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: { ...UA, Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub ne répond pas (${res.status})`)
  const releases = (await res.json()) as { draft: boolean; prerelease: boolean; assets: GhAsset[] }[]
  for (const r of releases) {
    if (r.draft) continue
    const a = r.assets.find((x) => match(x.name))
    if (a) return a
  }
  throw new Error(`Aucun fichier compatible trouvé sur github.com/${repo}`)
}

async function installStreamlink(): Promise<void> {
  const asset = await githubAsset('streamlink/windows-builds', (n) => /x86_64\.zip$/.test(n))
  const zip = join(depsDir(), asset.name)
  await download(asset.browser_download_url, zip, 'Streamlink + FFmpeg')
  rmSync(streamlinkRoot(), { recursive: true, force: true })
  emit({ download: { name: 'Décompression de Streamlink', done: 0, total: 0 } })
  await extractZip(zip, streamlinkRoot())
  rmSync(zip, { force: true })
}

async function installWhisper(gpu: boolean): Promise<void> {
  const cpu = (n: string): boolean => n === 'whisper-bin-x64.zip'
  const cuda = (n: string): boolean => /(win-cuda-12[\d.]*-x64|cublas-12[\d.]*-bin-x64)\.zip$/.test(n)
  const asset = await githubAsset('ggml-org/whisper.cpp', gpu ? cuda : cpu)
  const zip = join(depsDir(), asset.name)
  await download(asset.browser_download_url, zip, gpu ? 'Whisper (NVIDIA)' : 'Whisper')
  rmSync(whisperRoot(), { recursive: true, force: true })
  emit({ download: { name: 'Décompression de Whisper', done: 0, total: 0 } })
  await extractZip(zip, whisperRoot())
  rmSync(zip, { force: true })
}

/** Installe ce qui manque. `what` limite l'installation à certains outils. */
export function installDeps(opts: { model: WhisperModel; gpu: boolean; what: ('streamlink' | 'whisper' | 'model')[]; force?: boolean }): Promise<void> {
  if (busy) return busy
  busy = (async () => {
    emit({ error: null })
    try {
      mkdirSync(depsDir(), { recursive: true })
      refreshDeps(opts.model)
      if (opts.what.includes('streamlink') && (opts.force || !status.streamlink || !status.ffmpeg)) await installStreamlink()
      if (opts.what.includes('whisper') && (opts.force || !status.whisper)) await installWhisper(opts.gpu)
      if (opts.what.includes('model')) {
        if (!existsSync(vadFile())) await download(VAD.url, vadFile(), 'Détection de voix')
        if (!existsSync(modelFile(opts.model))) await download(MODELS[opts.model].url, modelFile(opts.model), `Modèle ${MODELS[opts.model].label}`)
      }
    } catch (err) {
      console.error('[outils]', err)
      emit({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      emit({ download: null })
      refreshDeps(opts.model)
      busy = null
    }
  })()
  return busy
}
