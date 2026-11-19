// Surveillance d'une chaîne : dès que le live commence, Streamlink l'enregistre
// et le tchat est journalisé à côté. À la fin du live, les fichiers partent à l'analyse.
// Pendant le live, la touche Clip, le tchat qui écrit « clip » et le streamer qui dit « clip »
// (écoute par Whisper, voir voice.ts) font un clip tout de suite.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelState } from '../shared/types'
import { marksFile } from './analyze'
import { TwitchChat } from './chat'
import { streamlinkExe } from './deps'
import { pickChatTitle } from '../shared/chatcommand'
import { isTrusted, markedWindow, type Candidate, type Mark } from './detect'
import { readJson, writeJson } from './jsonfile'
import { killTree } from './proc'
import { getSettings } from './store'
import { streamInfo, streamlinkLive } from './twitch'
import { VoiceListener } from './voice'

const CHECK_EVERY = 60_000
const RECHECK_SOON = 10_000
/** Attente de sécurité pour que la fin du moment soit bien écrite sur le disque. */
const WRITE_DELAY = 6
/** Le tchat écrit « clip » juste APRÈS le moment : on garde ces secondes avant la première demande. */
const CHAT_BEFORE = 35
/** Après un clip demandé par le tchat, les « clip » suivants parlent du même moment. */
const CHAT_COOLDOWN = 45

export interface WatcherHooks {
  onChange: () => void
  onSessionEnd: (files: string[]) => void
  keepAwake: (on: boolean) => void
  /** Un moment à découper tout de suite, pendant le live. */
  onLiveMoment: (file: string, moment: Candidate) => void
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}`
}

export class ChannelWatcher {
  state: ChannelState
  private timer: NodeJS.Timeout | null = null
  private proc: ChildProcess | null = null
  private chat: TwitchChat | null = null
  private voice: VoiceListener | null = null
  private sessionFiles: string[] = []
  private liveId: string | null = null
  private skippedLiveId: string | null = null
  private videoStartedAt: number | null = null
  private disposed = false
  /** Demandes « clip » récentes du tchat (secondes depuis le début de la vidéo). */
  private requests: { t: number; user: string; mod: boolean; word: string; title: string | null }[] = []
  private lastChatClip = -Infinity
  /** Dernier clip demandé par le tchat, tant qu'il n'est pas encore découpé (un titre peut encore arriver). */
  private pendingChatMoment: Candidate | null = null

  constructor(
    readonly login: string,
    paused: boolean,
    private readonly hooks: WatcherHooks
  ) {
    this.state = { login, status: paused ? 'paused' : 'checking', message: null, recordingSince: null, file: null, chat: null, marks: 0, liveClips: 0, nextCheckAt: null, lastRequest: null, voice: null }
    if (!paused) this.schedule(500)
  }

  /** Position actuelle dans la vidéo en cours d'enregistrement (s). */
  private videoTime(): number | null {
    return this.videoStartedAt === null ? null : (Date.now() - this.videoStartedAt) / 1000
  }

  /** Programme la découpe d'un moment dès que sa fin est enregistrée. */
  private cutWhenReady(moment: Candidate): void {
    const file = this.state.file
    const now = this.videoTime()
    if (!file || now === null) return
    const wait = Math.max(0, moment.end + 3 - now) + WRITE_DELAY
    setTimeout(() => {
      if (this.pendingChatMoment === moment) this.pendingChatMoment = null
      this.hooks.onLiveMoment(file, moment)
    }, wait * 1000)
    this.update({ liveClips: this.state.liveClips + 1 })
  }

  /**
   * Le tchat écrit « clip » : assez de personnes en 30 s (réglage, 2 par défaut), ou une seule
   * personne de confiance (le streamer, un modo, un VIP, un pseudo de la liste) = un clip.
   * « clip : headshot » donne aussi son titre au clip (celui d'une personne de confiance d'abord).
   * La carte de la chaîne affiche ce qui a été décidé (clip lancé, en attente d'autres personnes…).
   */
  private onChatRequest(word: string, user: string, mod: boolean, title: string | null): void {
    const t = this.videoTime()
    const s = getSettings().detection
    if (t === null || !s.clipWord) return
    const trusted = isTrusted(user, mod, s)
    this.requests = [...this.requests.filter((r) => t - r.t <= 30), { t, user: user.trim().toLowerCase(), mod: trusted, word, title }]
    const users = new Set(this.requests.map((r) => r.user))
    const needed = Math.max(1, Math.round(s.chatUsers ?? 2))
    const info = { user, at: Date.now(), word, title, count: users.size, needed }
    // Juste après un clip demandé par le tchat, les « clip » parlent encore du même moment ;
    // un titre qui arrive à ce moment-là va au clip en préparation s'il n'en a pas encore.
    if (t - this.lastChatClip <= CHAT_COOLDOWN) {
      const pending = this.pendingChatMoment
      if (title && pending && !pending.title) pending.title = title
      this.update({ lastRequest: { ...info, outcome: 'already' } })
      return
    }
    if (users.size < needed && !this.requests.some((r) => r.mod)) {
      this.update({ lastRequest: { ...info, outcome: 'waiting' } })
      return
    }
    this.lastChatClip = t
    const first = this.requests[0]
    const w = markedWindow(first.t, CHAT_BEFORE, s)
    const moment: Candidate = {
      ...w,
      peak: Math.max(w.start, Math.round(first.t - 5)),
      score: 6 + users.size,
      level: 'review',
      reasons: ['clip-word'],
      chatWord: first.word,
      title: pickChatTitle(this.requests)
    }
    this.pendingChatMoment = moment
    this.cutWhenReady(moment)
    this.requests = []
    this.update({ lastRequest: { ...info, title: moment.title ?? null, outcome: 'clip' } })
  }

  private update(patch: Partial<ChannelState>): void {
    this.state = { ...this.state, ...patch }
    this.hooks.onChange()
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.disposed) return
    this.timer = setTimeout(() => void this.check(), ms)
    this.state.nextCheckAt = Date.now() + ms
  }

  setPaused(paused: boolean): void {
    if (paused) {
      if (this.timer) clearTimeout(this.timer)
      this.stopProcess()
      this.endSession()
      this.update({ status: 'paused', message: null, nextCheckAt: null })
    } else {
      this.update({ status: 'checking', message: null })
      this.schedule(100)
    }
  }

  /** Arrête l'enregistrement du live en cours (sans surveiller autre chose). */
  stopRecording(): void {
    if (!this.proc && this.sessionFiles.length === 0) return
    this.skippedLiveId = this.liveId
    this.stopProcess()
    this.endSession()
    this.update({ status: 'live', message: 'Enregistrement arrêté pour ce live.' })
    this.schedule(CHECK_EVERY)
  }

  /** Relance l'enregistrement d'un live qu'on avait arrêté. */
  resumeRecording(): void {
    this.skippedLiveId = null
    this.schedule(100)
  }

  /** Touche Clip : retient le moment présent et le découpe dès qu'il est enregistré. */
  mark(before: number): boolean {
    const at = this.videoTime()
    if (!this.proc || !this.state.file || at === null) return false
    this.saveMark(at, before, false)
    this.update({ marks: this.state.marks + 1 })
    const s = getSettings().detection
    if (s.hotkey) this.cutWhenReady({ ...markedWindow(at, before, s), peak: Math.round(at), score: 10, level: 'sure', reasons: ['hotkey'], chatWord: null })
    return true
  }

  /** Le streamer a dit « clip » : même chose que la touche Clip, au moment où le mot a été dit. */
  private onVoice(at: number): void {
    const s = getSettings()
    if (!s.detection.voice || !this.proc || !this.state.file) return
    this.saveMark(at, s.hotkey.before, true)
    this.update({ marks: this.state.marks + 1 })
    this.cutWhenReady({ ...markedWindow(at, s.hotkey.before, s.detection), peak: Math.round(at), score: 10, level: 'sure', reasons: ['voice'], chatWord: null })
  }

  /** Le moment est noté à côté de l'enregistrement : l'analyse de fin de live le retrouve (sans doublon). */
  private saveMark(at: number, before: number, voice: boolean): void {
    if (!this.state.file) return
    const file = marksFile(this.state.file)
    const data = readJson<{ marks: Mark[] }>(file, { marks: [] })
    data.marks.push({ at: Math.round(at * 10) / 10, before, ...(voice ? { voice: true } : {}) })
    writeJson(file, data)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.stopProcess()
    this.endSession()
  }

  /** Lu à chaque fois (l'état peut changer pendant une attente réseau). */
  private stopped(): boolean {
    return this.disposed || this.state.status === 'paused'
  }

  private async check(): Promise<void> {
    if (this.stopped()) return
    if (!this.proc && this.state.status !== 'reconnecting') this.update({ status: 'checking' })
    let live: boolean | null = null
    let id: string | null = null
    try {
      const info = await streamInfo(this.login)
      if (!info.exists) {
        this.update({ status: 'error', message: 'Cette chaîne Twitch n’existe pas.' })
        this.schedule(CHECK_EVERY * 10)
        return
      }
      live = info.live
      id = info.id
    } catch (err) {
      console.error('[twitch]', this.login, err)
      live = await streamlinkLive(this.login)
      id = live ? `inconnu-${new Date().toDateString()}` : null
    }
    if (this.stopped()) return
    if (live === null) {
      this.update({ status: this.proc ? 'recording' : 'error', message: 'Twitch ne répond pas, nouvel essai dans une minute.' })
      this.schedule(CHECK_EVERY)
      return
    }
    if (live) {
      if (this.proc) {
        this.schedule(CHECK_EVERY)
        return
      }
      if (id !== null && id === this.skippedLiveId) {
        this.update({ status: 'live', message: 'Enregistrement arrêté pour ce live.' })
        this.schedule(CHECK_EVERY)
        return
      }
      if (this.liveId !== null && id !== this.liveId) this.endSession()
      this.liveId = id
      this.startRecording()
      this.schedule(CHECK_EVERY)
      return
    }
    // Hors ligne.
    this.skippedLiveId = null
    if (!this.proc) {
      this.endSession()
      this.update({ status: 'offline', message: null })
    }
    this.schedule(CHECK_EVERY)
  }

  private startRecording(): void {
    const exe = streamlinkExe()
    if (!exe) {
      this.update({ status: 'error', message: 'Streamlink n’est pas installé : va dans Réglages > Outils.' })
      return
    }
    const settings = getSettings()
    const dir = join(settings.recordingsDir, this.login)
    let file: string
    try {
      mkdirSync(dir, { recursive: true })
      let t = Date.now()
      while (existsSync(join(dir, `${this.login}-${stamp(t)}.ts`))) t += 1000
      file = join(dir, `${this.login}-${stamp(t)}.ts`)
    } catch {
      this.update({ status: 'error', message: 'Le dossier des enregistrements est inaccessible : choisis-en un autre dans Réglages.' })
      return
    }
    // Toujours la meilleure qualité proposée par la chaîne : le clip vertical agrandit l'image, une
    // qualité plus basse le rendrait flou.
    const proc = spawn(exe, ['--no-config', '--loglevel', 'info', '--force', '--output', file, `https://www.twitch.tv/${this.login}`, 'best'], { windowsHide: true })
    this.proc = proc
    this.sessionFiles.push(file)
    this.videoStartedAt = null
    if (this.state.recordingSince === null) this.hooks.keepAwake(true)
    proc.stdout?.on('data', (d) => console.log(`[streamlink ${this.login}]`, String(d).trim()))
    proc.stderr?.on('data', (d) => console.error(`[streamlink ${this.login}]`, String(d).trim()))
    proc.on('error', (err) => console.error('[streamlink]', err))
    proc.on('close', () => {
      if (this.proc !== proc) return
      this.proc = null
      this.dropIfEmpty(file)
      if (this.disposed || this.state.status === 'paused') return
      // Le flux s'est coupé : on vérifie vite si le live continue.
      this.update({ status: 'reconnecting', message: null, file: null })
      this.schedule(RECHECK_SOON)
    })

    this.chat ??= new TwitchChat(
      this.login,
      (chat) => this.update({ chat }),
      (word, user, mod, title) => this.onChatRequest(word, user, mod, title)
    )
    // L'écoute du mot « clip » suit l'enregistrement (elle ne fait rien si elle est coupée dans les réglages).
    this.voice ??= new VoiceListener(
      this.login,
      {
        current: () => {
          const time = this.videoTime()
          return this.proc && this.state.file && time !== null ? { file: this.state.file, time } : null
        }
      },
      { onHeard: (at) => this.onVoice(at), onState: (voice) => this.update({ voice }) }
    )
    this.chat.writeTo(file.replace(/\.ts$/, '.chat.jsonl'))
    const poll = setInterval(() => {
      if (this.proc !== proc) return clearInterval(poll)
      try {
        if (statSync(file).size > 0) {
          clearInterval(poll)
          this.videoStartedAt = Date.now()
          this.chat?.markVideoStart()
          this.update({ message: null })
        }
      } catch {
        /* pas encore créé */
      }
    }, 200)
    // Streamlink saute les pubs Twitch : rien n'est écrit tant qu'une pub de début de live passe.
    this.update({ status: 'recording', message: 'Démarrage du flux… (Twitch passe parfois une pub avant le live)', file, recordingSince: this.state.recordingSince ?? Date.now() })
  }

  private stopProcess(): void {
    const p = this.proc
    this.proc = null
    if (p) killTree(p.pid)
  }

  /** Supprime un enregistrement vide ou presque (coupure immédiate). */
  private dropIfEmpty(file: string): void {
    try {
      if (file && existsSync(file) && statSync(file).size < 1024 * 1024) {
        rmSync(file, { force: true })
        rmSync(file.replace(/\.ts$/, '.chat.jsonl'), { force: true })
        rmSync(marksFile(file), { force: true })
        this.sessionFiles = this.sessionFiles.filter((f) => f !== file)
      }
    } catch {
      /* fichier encore ouvert : il sera ignoré à l'analyse */
    }
  }

  private endSession(): void {
    const chat = this.chat
    this.chat = null
    chat?.stop()
    const voice = this.voice
    this.voice = null
    voice?.stop()
    const usable = (f: string): boolean => {
      try {
        return statSync(f).size >= 1024 * 1024
      } catch {
        return false
      }
    }
    const files = this.sessionFiles.filter(usable)
    // Parties sans vidéo (live coupé pendant la pub du début…) : on enlève leur tchat orphelin.
    for (const f of this.sessionFiles.filter((x) => !usable(x))) {
      for (const extra of [f, f.replace(/\.ts$/, '.chat.jsonl'), marksFile(f)]) {
        try {
          rmSync(extra, { force: true })
        } catch {
          /* encore ouvert : sans conséquence */
        }
      }
    }
    this.sessionFiles = []
    this.liveId = null
    if (this.state.recordingSince !== null) this.hooks.keepAwake(false)
    this.state = { ...this.state, recordingSince: null, file: null, chat: null, marks: 0, liveClips: 0, lastRequest: null, voice: null }
    this.requests = []
    this.lastChatClip = -Infinity
    this.hooks.onChange()
    if (files.length > 0) this.hooks.onSessionEnd(files)
  }

  isRecording(): boolean {
    return this.proc !== null
  }
}
