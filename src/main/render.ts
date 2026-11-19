// Rendu final d'un clip avec ffmpeg :
//   [intro]  le clip (figé ou qui joue déjà) flouté ou non, l'intro (transparente ou non) par-dessus,
//            avec un fondu vers le clip si on l'a choisi
//   [clip]   recadré + sous-titres + titre + logo + musique
//   [outro]  pareil sur la fin du clip
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { computeRegions, extraTimeline, introBlurRadius, type Rect } from '../shared/presets'
import type { Clip } from '../shared/types'
import { encoderArgs } from './encoders'
import { ffmpeg, ffmpegError, probe } from './ffmpeg'
import { fontsDir, tempDir } from './paths'
import type { RunResult } from './proc'
import { buildAss, fontsUsed } from './subtitles'

/** Images fixes : affichées 3 secondes. Les GIF animés sont traités comme des vidéos. */
const STILL_IMAGE = /\.(png|jpe?g|webp|bmp)$/i
const IMAGE_SECONDS = 3
/** Une intro ou une outro ne dépasse jamais cette durée. */
const MAX_EXTRA_SECONDS = 30

export interface RenderOptions {
  fps: number
  encoder: string
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/**
 * Recadrage d'une zone puis mise à l'échelle, le plus net possible : le clip vertical agrandit la
 * zone (×1,1 pour le jeu, jusqu'à ×3 pour une petite caméra). Lanczos pour agrandir ; quand la zone
 * est très agrandie, les blocs de compression du live sont d'abord adoucis (sinon ils deviennent de
 * gros pavés), sur la grille 8x8 de la source ; enfin une netteté adaptative dosée selon l'agrandissement.
 */
export function scaleChain(r: { src: Rect; dst: Rect }, sharpen = true): string {
  const { x, y, w, h } = r.src
  const zoom = r.dst.w / w
  let chain = `crop=${w}:${h}:${x}:${y}`
  if (sharpen && zoom >= 2) {
    const dx = x % 8
    const dy = y % 8
    chain = `crop=${w + dx}:${h + dy}:${x - dx}:${y - dy},deblock=filter=weak:block=8,crop=${w}:${h}:${dx}:${dy}`
  }
  chain += `,scale=${r.dst.w}:${r.dst.h}:flags=lanczos+accurate_rnd+full_chroma_int`
  if (sharpen && zoom > 1.05) chain += `,cas=strength=${Math.min(0.6, 0.3 + 0.12 * (zoom - 1)).toFixed(2)}`
  return chain
}

const AUDIO_FMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'

interface Extra {
  index: number
  duration: number
  hasAudio: boolean
}

/** Construit la commande ffmpeg (entrées + graphe de filtres) pour un clip. */
export async function buildRender(clip: Clip, fps: number, work: string, sharpen = true): Promise<{ inputs: string[]; graph: string; duration: number }> {
  const src = await probe(clip.source)
  if (!src.hasVideo || !src.width) throw new Error('La vidéo source du clip est illisible.')
  const look = clip.look
  const { width: W, height: H, regions } = computeRegions(look.framing, src.width, src.height)
  const F = fps
  const D = Math.max(0.5, clip.end - clip.start)
  const inputs: string[][] = [['-ss', clip.start.toFixed(3), '-t', D.toFixed(3), '-i', clip.source]]
  const graph: string[] = []

  const addExtra = async (slot: { enabled: boolean; file: string | null }): Promise<Extra | null> => {
    if (!slot.enabled || !slot.file || !existsSync(slot.file)) return null
    const index = inputs.length
    if (STILL_IMAGE.test(slot.file)) {
      inputs.push(['-loop', '1', '-framerate', String(F), '-t', String(IMAGE_SECONDS), '-i', slot.file])
      return { index, duration: IMAGE_SECONDS, hasAudio: false }
    }
    const info = await probe(slot.file)
    if (!info.hasVideo) return null
    // Le décodeur interne de ffmpeg ignore la transparence des WebM : libvpx la garde.
    const decoder = info.vcodec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : info.vcodec === 'vp8' ? ['-c:v', 'libvpx'] : []
    inputs.push([...decoder, '-i', slot.file])
    const duration = info.duration > 0 ? Math.min(info.duration, MAX_EXTRA_SECONDS) : IMAGE_SECONDS
    return { index, duration, hasAudio: info.hasAudio }
  }
  const intro = await addExtra(look.intro)
  const outro = await addExtra(look.outro)
  const tl = extraTimeline(look, D, intro?.duration ?? 0, outro?.duration ?? 0)
  const T = tl.total
  const s = (n: number): string => n.toFixed(3)

  let logoIndex = -1
  if (look.logo.enabled && look.logo.file && existsSync(look.logo.file)) {
    logoIndex = inputs.length
    inputs.push(['-loop', '1', '-t', (T + 1).toFixed(3), '-i', look.logo.file])
  }
  let musicIndex = -1
  if (look.music.enabled && look.music.file && existsSync(look.music.file)) {
    musicIndex = inputs.length
    inputs.push(['-stream_loop', '-1', '-i', look.music.file])
  }

  // --- Image principale : chaque zone de la source est recadrée puis posée sur un fond noir.
  const labels = regions.map((_, i) => `[m${i}]`).join('')
  graph.push(`[0:v]fps=${F},setpts=PTS-STARTPTS,split=${regions.length}${labels}`)
  graph.push(`color=c=black:s=${W}x${H}:r=${F}:d=${D.toFixed(3)}[c0]`)
  regions.forEach((r, i) => {
    const chain = r.blur
      ? `crop=${r.src.w}:${r.src.h}:${r.src.x}:${r.src.y},scale=${Math.round(r.dst.w / 4)}:${Math.round(r.dst.h / 4)},boxblur=10:2,scale=${r.dst.w}:${r.dst.h},eq=brightness=-0.07`
      : scaleChain(r, sharpen)
    graph.push(`[m${i}]${chain},setsar=1[r${i}]`)
    graph.push(`[c${i}][r${i}]overlay=${r.dst.x}:${r.dst.y}:shortest=1[c${i + 1}]`)
  })
  let current = `c${regions.length}`

  // --- Intro / outro en mode « pause » : la première (dernière) image reste figée pendant leur durée.
  if (tl.padStart > 0 || tl.padEnd > 0) {
    graph.push(`[${current}]tpad=start_duration=${s(tl.padStart)}:start_mode=clone:stop_duration=${s(tl.padEnd)}:stop_mode=clone[fige]`)
    current = 'fige'
  }

  // --- Flou derrière l'intro / l'outro (intensité réglable, 0 = net), qui s'efface (ou apparaît)
  // en fondu si on l'a demandé. Le flou est calculé sur une image réduite au quart : rapide.
  const blurIn = intro && look.intro.blur > 0 ? introBlurRadius(look.intro.blur) : 0
  const blurOut = outro && look.outro.blur > 0 ? introBlurRadius(look.outro.blur) : 0
  if (blurIn || blurOut) {
    graph.push(`[${current}]split=${1 + (blurIn ? 1 : 0) + (blurOut ? 1 : 0)}[net]${blurIn ? '[fi]' : ''}${blurOut ? '[fo]' : ''}`)
    current = 'net'
    const blur = (r: number): string => `scale=${Math.round(W / 4)}:${Math.round(H / 4)},boxblur=${r}:2,scale=${W}:${H},eq=brightness=-0.08`
    if (blurIn) {
      const fade = tl.fadeIn > 0 ? `,format=yuva420p,fade=t=out:st=${s(tl.introEnd - tl.fadeIn)}:d=${s(tl.fadeIn)}:alpha=1` : ''
      graph.push(`[fi]${blur(blurIn)}${fade}[fiflou]`)
      graph.push(`[${current}][fiflou]overlay=0:0:enable='lt(t,${s(tl.introEnd)})'[avecfi]`)
      current = 'avecfi'
    }
    if (blurOut) {
      const fade = tl.fadeOut > 0 ? `,format=yuva420p,fade=t=in:st=${s(tl.outroStart)}:d=${s(tl.fadeOut)}:alpha=1` : ''
      graph.push(`[fo]${blur(blurOut)}${fade}[foflou]`)
      graph.push(`[${current}][foflou]overlay=0:0:enable='gte(t,${s(tl.outroStart)})'[avecfo]`)
      current = 'avecfo'
    }
  }

  // --- Sous-titres et titre (décalés quand le clip attend la fin de l'intro). Ils passent
  // sous l'intro et l'outro.
  const ass = buildAss({ look, words: clip.words, clipStart: clip.start, clipEnd: clip.end, title: clip.title, offset: tl.padStart })
  if (ass) {
    writeFileSync(join(work, 'sous-titres.ass'), ass, 'utf8')
    mkdirSync(join(work, 'polices'), { recursive: true })
    for (const f of fontsUsed(look)) {
      const p = join(fontsDir(), f)
      if (existsSync(p)) copyFileSync(p, join(work, 'polices', f))
    }
    graph.push(`[${current}]ass=sous-titres.ass:fontsdir=polices[st]`)
    current = 'st'
  }

  // --- La vidéo de l'intro (et de l'outro) par-dessus, transparence comprise, avec fondu.
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease`
  const center = 'x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2'
  if (intro) {
    const fade = tl.fadeIn > 0 ? `,fade=t=out:st=${s(tl.introEnd - tl.fadeIn)}:d=${s(tl.fadeIn)}:alpha=1` : ''
    graph.push(`[${intro.index}:v]fps=${F},setpts=PTS-STARTPTS,format=rgba,${fit},trim=0:${s(tl.introEnd)}${fade}[introv]`)
    graph.push(`[${current}][introv]overlay=${center}:eof_action=pass:format=auto[avecintro]`)
    current = 'avecintro'
  }
  if (outro) {
    const len = T - tl.outroStart
    const fade = tl.fadeOut > 0 ? `,fade=t=in:st=0:d=${s(tl.fadeOut)}:alpha=1` : ''
    graph.push(`[${outro.index}:v]fps=${F},setpts=PTS-STARTPTS,format=rgba,${fit},trim=0:${s(len)}${fade},setpts=PTS+${s(tl.outroStart)}/TB[outrov]`)
    graph.push(`[${current}][outrov]overlay=${center}:eof_action=pass:format=auto:enable='gte(t,${s(tl.outroStart)})'[avecoutro]`)
    current = 'avecoutro'
  }

  // --- Logo / filigrane (toujours entièrement dans l'image).
  if (logoIndex >= 0) {
    const lw = Math.max(2, Math.round((look.logo.width * W) / 2) * 2)
    const opacity = Math.min(1, Math.max(0, look.logo.opacity)).toFixed(2)
    graph.push(`[${logoIndex}:v]scale=${lw}:-2,format=rgba,colorchannelmixer=aa=${opacity}[logo]`)
    const lx = `max(0,min(main_w-overlay_w,${Math.round(look.logo.x * W)}-overlay_w/2))`
    const ly = `max(0,min(main_h-overlay_h,${Math.round(look.logo.y * H)}-overlay_h/2))`
    graph.push(`[${current}][logo]overlay=x='${lx}':y='${ly}':shortest=1[lg]`)
    current = 'lg'
  }
  graph.push(`[${current}]setsar=1,format=yuv420p[v]`)

  // --- Son : intro, puis le clip (avec la musique de fond), puis l'outro.
  const vol = Math.max(0, look.sourceVolume).toFixed(2)
  if (src.hasAudio) graph.push(`[0:a]${AUDIO_FMT},asetpts=PTS-STARTPTS,volume=${vol},apad,atrim=0:${D.toFixed(3)}[ma0]`)
  else graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)}[ma0]`)
  if (musicIndex >= 0) {
    const mv = Math.max(0, look.music.volume).toFixed(2)
    const fade = Math.max(0, D - 1.5).toFixed(3)
    graph.push(`[${musicIndex}:a]${AUDIO_FMT},volume=${mv},atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=${fade}:d=1.5[mus]`)
    graph.push(`[ma0][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[ma]`)
  } else {
    graph.push(`[ma0]anull[ma]`)
  }
  /** Son d'une intro / outro coupé à la bonne longueur (silence si elle n'a pas de son). */
  const extraAudio = (e: Extra, label: string, length: number, fade: string): void => {
    if (e.hasAudio) graph.push(`[${e.index}:a]${AUDIO_FMT},asetpts=PTS-STARTPTS,apad,atrim=0:${s(length)}${fade}[${label}]`)
    else graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${s(length)}[${label}]`)
  }
  const introFade = (len: number): string => (tl.fadeIn > 0 ? `,afade=t=out:st=${s(Math.max(0, len - tl.fadeIn))}:d=${s(tl.fadeIn)}` : '')
  const outroFade = tl.fadeOut > 0 ? `,afade=t=in:st=0:d=${s(tl.fadeOut)}` : ''
  const introPlays = !!intro && tl.padStart === 0
  const outroPlays = !!outro && tl.padEnd === 0
  // Mode « play » : le son de l'intro (de l'outro) se mélange à celui du clip.
  let content = 'ma'
  const mixes: string[] = []
  if (intro && introPlays) {
    extraAudio(intro, 'introa', tl.introEnd, introFade(tl.introEnd))
    mixes.push('[introa]')
  }
  if (outro && outroPlays) {
    extraAudio(outro, 'outroa0', T - tl.outroStart, outroFade)
    graph.push(`[outroa0]adelay=delays=${Math.round((tl.outroStart - tl.padStart) * 1000)}:all=1[outroa]`)
    mixes.push('[outroa]')
  }
  if (mixes.length > 0) {
    graph.push(`[ma]${mixes.join('')}amix=inputs=${1 + mixes.length}:duration=first:dropout_transition=0:normalize=0[mac]`)
    content = 'mac'
  }
  // Mode « pause » : intro, puis le clip, puis l'outro.
  const parts: string[] = []
  if (intro && !introPlays) {
    extraAudio(intro, 'introp', tl.padStart, introFade(tl.padStart))
    parts.push('[introp]')
  }
  parts.push(`[${content}]`)
  if (outro && !outroPlays) {
    extraAudio(outro, 'outrop', tl.padEnd, outroFade)
    parts.push('[outrop]')
  }
  graph.push(parts.length > 1 ? `${parts.join('')}concat=n=${parts.length}:v=0:a=1[a]` : `[${content}]anull[a]`)

  return { inputs: inputs.flat(), graph: graph.join(';\n'), duration: T }
}

export async function renderClip(clip: Clip, out: string, opts: RenderOptions): Promise<void> {
  const work = join(tempDir(), `rendu-${clip.id}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  mkdirSync(dirname(out), { recursive: true })
  const partial = `${out}.rendu.mp4`
  try {
    let { inputs, graph, duration } = await buildRender(clip, opts.fps, work)
    writeFileSync(join(work, 'filtres.txt'), graph, 'utf8')
    const attempt = (encoder: string, graphArg: string[]): Promise<RunResult> =>
      ffmpeg([...inputs, ...graphArg, '-map', '[v]', '-map', '[a]', ...encoderArgs(encoder), '-r', String(opts.fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', duration.toFixed(3), partial], {
        cwd: work,
        signal: opts.signal,
        duration,
        onProgress: opts.onProgress
      })
    let graphArg = ['-/filter_complex', 'filtres.txt']
    let r = await attempt(opts.encoder, graphArg)
    if (r.code !== 0 && !r.aborted && /Unrecognized option '\/filter_complex'/.test(r.stderr)) {
      graphArg = ['-filter_complex_script', 'filtres.txt']
      r = await attempt(opts.encoder, graphArg)
    }
    // ffmpeg trop ancien pour les filtres de netteté : rendu sans eux plutôt qu'aucun rendu.
    if (r.code !== 0 && !r.aborted && /No such filter: '(cas|deblock)'/.test(r.stderr)) {
      ;({ inputs, graph, duration } = await buildRender(clip, opts.fps, work, false))
      writeFileSync(join(work, 'filtres.txt'), graph, 'utf8')
      r = await attempt(opts.encoder, graphArg)
    }
    // L'encodeur de la carte graphique a échoué : on retente avec l'encodeur logiciel.
    if (r.code !== 0 && !r.aborted && opts.encoder !== 'libx264' && !/No space left/i.test(r.stderr)) {
      console.error('[rendu] encodeur', opts.encoder, 'en échec, nouvel essai avec libx264')
      r = await attempt('libx264', graphArg)
    }
    if (r.aborted) throw new Error('Rendu arrêté')
    if (r.code !== 0) {
      console.error('[rendu]', r.stderr.slice(-3000))
      throw ffmpegError(r, 'Le rendu a échoué')
    }
    rmSync(out, { force: true })
    renameSync(partial, out)
  } finally {
    rmSync(partial, { force: true })
    rmSync(work, { recursive: true, force: true })
  }
}
