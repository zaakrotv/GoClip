// Écoute du live : quand le streamer dit « clip » à voix haute, AutoClip garde le moment,
// exactement comme avec la touche Clip.
// Toutes les 4 secondes, les ~7 dernières secondes du son de l'enregistrement en cours sont
// transcrites par Whisper, sur le PC et sans internet (modèle « base », le plus rapide).
// Les fenêtres se recouvrent : un mot coupé au bord d'une fenêtre est entendu dans la suivante.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import type { VoiceState, WhisperModel } from '../shared/types'
import { modelFile, whisperExe } from './deps'
import { ff } from './ffmpeg'
import { tempDir } from './paths'
import { run } from './proc'
import { getSettings } from './store'

/** Secondes entre deux écoutes. */
const STEP = 4
/** Secondes de son écoutées à chaque fois. */
const WINDOW = 7
/** Deux « clip » plus rapprochés que ça (s) parlent du même moment. */
const SAME_MOMENT = 15
/** Marges (s) au début et à la fin de chaque fenêtre, où un mot peut être coupé en deux. */
const EDGE_START = 0.6
const EDGE_END = 0.35
/** Débit supposé de l'enregistrement tant qu'on ne l'a pas mesuré (octets/s, ≈ 8 Mbit/s). */
const DEFAULT_RATE = 1_000_000
const TS_PACKET = 188

/** « clip », « clippe », « clippez », « clipper »… mais ni « éclipse » ni « clic ». */
const VOICE_CLIP = /(^|[^\p{L}])(clip+(?:s|e|es|é|ée|és|ez|er|ed)?)(?!\p{L})/giu

/**
 * Mots qui, juste avant « clip », montrent qu'on PARLE d'un clip (« le clip de la semaine »,
 * « un clip ») au lieu d'en demander un (« Clip ! », « clippez ça », « on clip »).
 */
const DETERMINERS = new Set(
  'le la les l un une des du de d ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs quel quelle quels quelles au aux the a an this that my your his her our their'.split(' ')
)

/** Le streamer demande-t-il un clip dans cette phrase ? Renvoie le mot entendu. */
export function heardClip(text: string): string | null {
  for (const m of text.matchAll(VOICE_CLIP)) {
    const before = text.slice(0, (m.index ?? 0) + m[1].length)
    const prev = /(\p{L}+)['’]?\s*$/u.exec(before)?.[1]?.toLowerCase()
    if (prev && DETERMINERS.has(prev)) continue
    return m[2]
  }
  return null
}

interface WhisperToken {
  text: string
  offsets?: { from: number; to: number }
}

interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: WhisperToken[]
}

/**
 * Cherche une demande de clip dans la transcription de Whisper, entre `from` et `to` (s) :
 * les mots tout au bord de la fenêtre d'écoute peuvent être coupés (« …clipse » d'« éclipse »)
 * et sont ignorés — la fenêtre d'avant ou d'après, qui les contient en entier, les entend.
 * Renvoie l'instant du mot (s, depuis le début du fichier son) et la phrase entendue.
 */
export function findClipWord(segments: WhisperSegment[], from = 0, to = Infinity): { at: number; text: string; word: string } | null {
  for (const seg of segments) {
    if (!heardClip(seg.text)) continue
    // Mots reconstitués à partir des morceaux de Whisper (« Cl » + « ip ») avec l'instant du premier morceau.
    const words: { text: string; at: number }[] = []
    for (const tok of seg.tokens ?? []) {
      const t = tok.text ?? ''
      if (!t || t.startsWith('[_') || t.startsWith('<|')) continue
      const at = (tok.offsets?.from ?? seg.offsets.from) / 1000
      if (t.startsWith(' ') || words.length === 0) words.push({ text: t.trim(), at })
      else words[words.length - 1].text += t
    }
    if (words.length === 0) {
      // Pas de détail mot par mot : on se contente du début de la phrase.
      const at = seg.offsets.from / 1000
      if (at >= from && at <= to) return { at, text: seg.text.trim(), word: heardClip(seg.text)! }
      continue
    }
    // Chaque mot est jugé avec celui d'avant (« le clip » = on parle d'un clip, pas une demande).
    const prevWord = (i: number): string => (words[i - 1]?.text ?? '').toLowerCase().replace(/[^\p{L}]/gu, '')
    const hit = words.find((w, i) => w.at >= from && w.at <= to && heardClip(w.text) !== null && !DETERMINERS.has(prevWord(i)))
    if (hit) return { at: hit.at, text: seg.text.trim(), word: heardClip(hit.text)! }
  }
  return null
}

/** Position du début des paquets MPEG-TS dans un morceau lu au milieu du fichier. */
export function tsSync(buf: Uint8Array): number {
  for (let i = 0; i < TS_PACKET && i + TS_PACKET * 2 < buf.length; i++) {
    if (buf[i] === 0x47 && buf[i + TS_PACKET] === 0x47 && buf[i + TS_PACKET * 2] === 0x47) return i
  }
  return -1
}

type ReadAt = (buf: Buffer, length: number, position: number) => number

/**
 * Twitch envoie aujourd'hui ses lives en MP4 fragmenté (Streamlink l'écrit tel quel, même dans un
 * « .ts ») : un en-tête (ftyp + moov) puis une suite de fragments (moof + mdat) d'environ 2 s.
 * Ce lecteur parcourt les boîtes au fur et à mesure que le fichier grossit (sans tout relire),
 * pour pouvoir recoller l'en-tête et les derniers fragments en un petit MP4 lisible.
 */
export class Mp4Walker {
  private next = 0
  private ftyp: number | null = null
  /** En-tête en vigueur (il peut changer en cours de live, par exemple après une coupure). */
  init: { start: number; end: number } | null = null
  /** Débuts des derniers fragments (moof). */
  moofs: number[] = []
  /** Fin de la dernière boîte entièrement écrite. */
  complete = 0

  constructor(readonly file: string) {}

  walk(read: ReadAt, size: number): void {
    const head = Buffer.alloc(16)
    while (this.next + 8 <= size) {
      const got = read(head, Math.min(16, size - this.next), this.next)
      if (got < 8) break
      let len = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (len === 1 && got >= 16) len = Number(head.readBigUInt64BE(8))
      // Taille 0 (« jusqu'à la fin ») ou boîte pas encore entièrement écrite : on attend la suite.
      if (len === 0 || this.next + len > size) break
      if (len < 8 || !/^[a-z0-9 ]{4}$/i.test(type)) throw new Error('Enregistrement MP4 illisible pour l’écoute.')
      if (type === 'ftyp') this.ftyp = this.next
      else if (type === 'moov') this.init = { start: this.ftyp ?? this.next, end: this.next + len }
      else if (type === 'moof') {
        this.moofs.push(this.next)
        if (this.moofs.length > 400) this.moofs.splice(0, this.moofs.length - 400)
      }
      this.next += len
      this.complete = this.next
    }
  }

  /** Début du fragment à partir duquel lire pour avoir au moins `bytes` octets de fin de fichier. */
  tailStart(bytes: number): number | null {
    const init = this.init
    if (!init) return null
    const usable = this.moofs.filter((m) => m >= init.end && m < this.complete)
    if (usable.length === 0) return null
    const limit = this.complete - bytes
    let pick = usable[0]
    for (const m of usable) if (m <= limit) pick = m
    return pick
  }
}

/** Modèle utilisé pour écouter : « base » (rapide) s'il est là, sinon celui de la transcription. */
export function listeningModel(preferred: WhisperModel): string | null {
  for (const m of ['base', preferred] as WhisperModel[]) {
    const f = modelFile(m)
    if (existsSync(f)) return f
  }
  return null
}

/** Une seule écoute à la fois, toutes chaînes confondues : Whisper est gourmand en processeur. */
let turn: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = turn.then(fn, fn)
  turn = next.catch(() => undefined)
  return next
}

export interface VoiceSource {
  /** Fichier en cours d'enregistrement et position actuelle dans la vidéo (s), ou null si rien ne s'enregistre. */
  current(): { file: string; time: number } | null
}

export interface VoiceHooks {
  /** « clip » entendu : position du mot dans la vidéo (s) et phrase entendue. */
  onHeard: (at: number, text: string) => void
  onState: (state: VoiceState | null) => void
}

export class VoiceListener {
  private timer: NodeJS.Timeout | null = null
  private abort: AbortController | null = null
  private stopped = false
  private lastHeard = -Infinity
  private failures = 0
  private samples: { file: string; size: number; at: number }[] = []
  private mp4: Mp4Walker | null = null
  private readonly work: string
  state: VoiceState | null = null

  constructor(
    name: string,
    private readonly source: VoiceSource,
    private readonly hooks: VoiceHooks
  ) {
    this.work = join(tempDir(), `ecoute-${name}`)
    this.schedule(STEP * 1000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abort?.abort()
    this.setState(null)
    try {
      rmSync(this.work, { recursive: true, force: true })
    } catch {
      /* encore utilisé : nettoyé au prochain démarrage */
    }
  }

  private setState(next: VoiceState | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.hooks.onState(next)
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    const began = Date.now()
    let wait = STEP * 1000
    try {
      await oneAtATime(() => (this.stopped ? Promise.resolve() : this.listen()))
      this.failures = 0
    } catch (err) {
      if (this.stopped) return
      this.failures++
      console.error('[écoute]', err)
      this.setState({ active: false, heardAt: this.state?.heardAt ?? null, heard: this.state?.heard ?? null, error: err instanceof Error ? err.message : String(err) })
      // Plusieurs échecs de suite : on réessaie moins souvent.
      if (this.failures >= 3) wait = 30_000
    } finally {
      this.schedule(Math.max(500, wait - (Date.now() - began)))
    }
  }

  /** Débit d'écriture de l'enregistrement (octets/s), mesuré sur les 30 dernières secondes. */
  private rate(file: string, size: number): number {
    const now = Date.now()
    this.samples = [...this.samples.filter((s) => s.file === file && now - s.at <= 30_000), { file, size, at: now }]
    const first = this.samples[0]
    const dt = (now - first.at) / 1000
    if (dt < 3 || size <= first.size) return DEFAULT_RATE
    return (size - first.size) / dt
  }

  /**
   * Copie les dernières secondes de l'enregistrement dans un petit fichier lisible par ffmpeg.
   * `lag` = secondes déjà écrites mais pas encore lisibles (fragment MP4 en cours d'écriture).
   */
  private readTail(fd: number, file: string): { file: string; lag: number } | null {
    const size = fstatSync(fd).size
    const rate = this.rate(file, size)
    const want = Math.min(size, Math.round(rate * (WINDOW + 2)), 40_000_000)
    const read: ReadAt = (buf, length, position) => readSync(fd, buf, 0, length, position)
    const head = Buffer.alloc(8)
    if (size < 8 || read(head, 8, 0) < 8) return null

    if (head.toString('latin1', 4, 8) === 'ftyp') {
      // MP4 fragmenté (cas actuel de Twitch) : en-tête + derniers fragments complets.
      if (this.mp4?.file !== file) this.mp4 = new Mp4Walker(file)
      const mp4 = this.mp4
      mp4.walk(read, size)
      const init = mp4.init
      const from = mp4.tailStart(want)
      if (!init || from === null) return null
      const initLen = init.end - init.start
      const bodyLen = mp4.complete - from
      if (bodyLen < 1000) return null
      const buf = Buffer.alloc(initLen + bodyLen)
      read(buf, initLen, init.start)
      read(buf.subarray(initLen), bodyLen, from)
      const out = join(this.work, 'fin.mp4')
      writeFileSync(out, buf)
      return { file: out, lag: rate > 0 ? Math.max(0, (size - mp4.complete) / rate) : 0 }
    }

    // MPEG-TS : on se recale sur le début d'un paquet.
    if (want < TS_PACKET * 4) return null
    const buf = Buffer.alloc(want)
    const got = read(buf, want, size - want)
    const start = tsSync(buf.subarray(0, got))
    if (start < 0) throw new Error('Format d’enregistrement inconnu : l’écoute ne sait pas le lire.')
    const usable = got - ((got - start) % TS_PACKET)
    const out = join(this.work, 'fin.ts')
    writeFileSync(out, buf.subarray(start, usable))
    return { file: out, lag: 0 }
  }

  private async listen(): Promise<void> {
    const s = getSettings()
    if (!s.detection.voice) {
      this.setState(null)
      return
    }
    const exe = whisperExe()
    const model = listeningModel(s.transcription.model)
    if (!exe || !model) {
      this.setState({ active: false, heardAt: null, heard: null, error: 'Whisper ou son modèle manque : installe-les dans Réglages > Outils.' })
      return
    }
    const cur = this.source.current()
    if (!cur || cur.time < 2) {
      this.setState({ active: false, heardAt: this.state?.heardAt ?? null, heard: this.state?.heard ?? null, error: null })
      return
    }

    // 1) Les dernières secondes de l'enregistrement (le fichier grossit pendant qu'on le lit).
    mkdirSync(this.work, { recursive: true })
    const wav = join(this.work, 'fin.wav')
    const time = cur.time
    const fd = openSync(cur.file, 'r')
    let tail: { file: string; lag: number } | null
    try {
      tail = this.readTail(fd, cur.file)
    } finally {
      closeSync(fd)
    }
    if (!tail) return

    // 2) Le son, au format de Whisper.
    this.abort = new AbortController()
    const signal = this.abort.signal
    const dec = await run(ff(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', tail.file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal, timeoutMs: 60_000 })
    if (this.stopped) return
    if (dec.code !== 0 || !existsSync(wav)) throw new Error(`Lecture du son impossible : ${dec.stderr.trim().split('\n').pop() ?? ''}`)
    const duration = Math.max(0, (statSync(wav).size - 44) / 32_000)
    if (duration < 1) return

    // 3) Whisper écoute les WINDOW dernières secondes.
    const from = Math.max(0, duration - WINDOW)
    const args = [
      '-m', model,
      '-f', wav,
      '-l', s.transcription.language === 'auto' ? 'auto' : s.transcription.language || 'fr',
      '-t', String(Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4)))),
      '-ot', String(Math.round(from * 1000)),
      '-ojf',
      '-of', join(this.work, 'texte'),
      '-np',
      '-sns',
      // Aide Whisper à bien écrire le mot attendu (sans en inventer sur du silence : vérifié).
      '--prompt', 'Clip !'
    ]
    let r = await run(exe, args, { signal, timeoutMs: 60_000 })
    if (r.code !== 0 && !r.aborted && !this.stopped) r = await run(exe, [...args, '-ng'], { signal, timeoutMs: 60_000 })
    if (this.stopped || r.aborted) return
    const out = join(this.work, 'texte.json')
    if (r.code !== 0 || !existsSync(out)) throw new Error('Whisper n’a pas pu écouter le live.')
    const json = JSON.parse(readFileSync(out, 'utf8')) as { transcription?: WhisperSegment[] }
    rmSync(out, { force: true })
    // Pour vérifier ce que l'écoute entend : variable d'environnement AUTOCLIP_DEBUG=voix.
    if (process.env.AUTOCLIP_DEBUG?.includes('voix')) console.log(`[écoute ${time.toFixed(0)} s, ${duration.toFixed(1)} s de son]`, (json.transcription ?? []).map((x) => x.text.trim()).join(' | '))
    // Mots tout au bord de la fenêtre ignorés (peut-être coupés) : ils sont entendus en entier
    // par la fenêtre d'avant (qui recouvre celle-ci de 3 s) ou par la suivante.
    const hit = findClipWord(json.transcription ?? [], from > 0 ? from + EDGE_START : 0, duration - EDGE_END)
    const heardAt = this.state?.heardAt ?? null
    const heard = this.state?.heard ?? null
    if (!hit) {
      this.setState({ active: true, heardAt, heard, error: null })
      return
    }

    // 4) Position du mot dans la vidéo : la fin du son lu correspond à « maintenant »
    //    (moins ce qui était déjà écrit mais pas encore lisible : le fragment en cours).
    const at = Math.max(0, time - tail.lag - (duration - hit.at))
    if (at - this.lastHeard < SAME_MOMENT) {
      this.setState({ active: true, heardAt, heard, error: null })
      return
    }
    this.lastHeard = at
    console.log(`[écoute] « ${hit.word} » entendu à ${at.toFixed(1)} s : ${hit.text}`)
    this.setState({ active: true, heardAt: Date.now(), heard: hit.text, error: null })
    this.hooks.onHeard(at, hit.text)
  }
}
