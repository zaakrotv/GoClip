// Enregistrement du tchat Twitch pendant le live (connexion anonyme en lecture seule).
// Chaque message est écrit dans un fichier .chat.jsonl à côté de la vidéo.
import { createWriteStream, type WriteStream } from 'node:fs'
import { parseClipCommand } from '../shared/chatcommand'
import { getSettings } from './store'

export interface ChatStatus {
  connected: boolean
  messages: number
  /** Messages qui demandent un clip (« clip », « clippez »…). */
  requests: number
}

export class TwitchChat {
  private socket: WebSocket | null = null
  private out: WriteStream | null = null
  private retry: NodeJS.Timeout | null = null
  private stopped = false
  status: ChatStatus = { connected: false, messages: 0, requests: 0 }

  constructor(
    private readonly channel: string,
    private readonly onStatus: (s: ChatStatus | null) => void,
    /** Un message demande un clip ; `title` : le titre donné avec « clip : titre ». */
    private readonly onRequest: (word: string, user: string, mod: boolean, title: string | null) => void = () => {}
  ) {
    this.connect()
  }

  /** Change le fichier de destination (nouvelle partie de l'enregistrement). */
  writeTo(file: string): void {
    this.out?.end()
    this.out = createWriteStream(file, { flags: 'a' })
    this.out.on('error', (err) => console.error('[tchat]', err))
  }

  /** Repère l'instant où la vidéo commence vraiment (sert à aligner tchat et vidéo). */
  markVideoStart(): void {
    this.write({ type: 'video', at: Date.now() })
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const s = this.socket
    this.socket = null
    try {
      s?.close()
    } catch {
      /* déjà fermé */
    }
    this.out?.end()
    this.out = null
    this.onStatus(null)
  }

  private write(obj: Record<string, unknown>): void {
    this.out?.write(`${JSON.stringify(obj)}\n`)
  }

  private connect(): void {
    if (this.stopped) return
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    this.socket = ws
    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      ws.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 89_999)}`)
      ws.send(`JOIN #${this.channel}`)
    })
    ws.addEventListener('message', (ev) => {
      for (const line of String(ev.data).split('\r\n')) if (line) this.handle(ws, line)
    })
    ws.addEventListener('error', () => {
      /* la fermeture qui suit relance la connexion */
    })
    ws.addEventListener('close', () => {
      if (this.socket !== ws) return
      this.socket = null
      this.status = { ...this.status, connected: false }
      this.onStatus({ ...this.status })
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 5000)
    })
  }

  private handle(ws: WebSocket, line: string): void {
    if (line.startsWith('PING')) {
      ws.send(line.replace('PING', 'PONG'))
      return
    }
    if (/ JOIN #/.test(line) && !this.status.connected) {
      this.status = { ...this.status, connected: true }
      this.onStatus({ ...this.status })
      return
    }
    const m = /^@(\S+) :([^!\s]+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(line)
    if (!m) return
    const tags = new Map(m[1].split(';').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
    const badges = tags.get('badges') ?? ''
    // Le streamer, les modos et les VIP : leur « clip » suffit à lui seul.
    const mod = tags.get('mod') === '1' || tags.get('vip') === '1' || /(^|,)(broadcaster|moderator|vip)\//.test(badges)
    this.write({ type: 'msg', at: Date.now(), user: m[2], text: m[3], mod })
    // « clip » (ou le mot choisi dans les réglages), avec un titre facultatif : « clip : headshot ».
    const cmd = parseClipCommand(m[3], getSettings().detection.chatWords)
    this.status = { ...this.status, messages: this.status.messages + 1, requests: this.status.requests + (cmd ? 1 : 0) }
    if (cmd) {
      this.onRequest(cmd.word, m[2], mod, cmd.title)
      this.onStatus({ ...this.status })
    } else if (this.status.messages % 10 === 1) this.onStatus({ ...this.status })
  }
}
