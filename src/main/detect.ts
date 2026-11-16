// Détection des moments forts d'un live.
// Signaux utilisés (chacun peut être coupé dans les réglages) :
//  - le tchat qui s'emballe (nombre de messages, mots « hype »)
//  - le son qui monte d'un coup (cri, explosion, rire)
//  - le tchat qui écrit « clip »
//  - la touche Clip pressée pendant le live
import { parseClipCommand, pickChatTitle } from '../shared/chatcommand'
import type { DetectionSettings, Reason } from '../shared/types'

export interface ChatRequest {
  at: number
  user: string
  word: string
  mod: boolean
  /** Titre donné avec « clip : titre ». */
  title?: string | null
}

export interface Mark {
  at: number
  before: number
  /** Moment signalé par le streamer à voix haute (« clip »). */
  voice?: boolean
}

export interface Candidate {
  start: number
  end: number
  peak: number
  score: number
  level: 'sure' | 'review'
  reasons: Reason[]
  chatWord: string | null
  /** Titre du clip donné par le tchat (« clip : headshot »). */
  title?: string | null
}

export interface DetectInput {
  duration: number
  loudness: number[]
  chat: number[] | null
  requests: ChatRequest[]
  marks: Mark[]
}

const HYPE = /\b(l+o+l+|mdr+|ptdr+|xd+|jpp|wtf|omg|omfg|pog\w*|kek\w*|lul\w*|omegalul|icant|monka\w*|incroyable|dingue|oh+|ah+|quoi+|nan+)\b|\?{2,}|!{2,}|😂|🤣|😱|💀|🔥/iu

export function chatWeight(text: string): number {
  let w = 1
  if (HYPE.test(text)) w += 1
  const letters = text.replace(/[^\p{L}]/gu, '')
  if (letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) w += 0.5
  return w
}

/** Le mot qui demande un clip dans ce message (« clip » par défaut, ou les mots choisis), sinon null. */
export function clipWord(text: string, words?: string[]): string | null {
  return parseClipCommand(text, words)?.word ?? null
}

/** Durée gardée après un moment signalé (bornée, valeur par défaut 5 s). */
function afterSeconds(o: Pick<DetectionSettings, 'after'>): number {
  return Math.max(0, Math.min(30, Number.isFinite(o.after) ? o.after : 5))
}

/**
 * Passage gardé autour d'un moment signalé pendant le live (touche Clip, « clip » écrit ou dit) :
 * `before` secondes avant et quelques secondes après, ou la durée fixe choisie dans les réglages.
 */
export function markedWindow(at: number, before: number, o: Pick<DetectionSettings, 'fixedLength' | 'after'>): { start: number; end: number } {
  const after = afterSeconds(o)
  const span = o.fixedLength > 0 ? Math.max(after + 3, o.fixedLength) : Math.max(1, before) + after
  return { start: Math.max(0, Math.round(at + after - span)), end: Math.round(at + after) }
}

/** Le « clip » de cette personne suffit-il à lui seul ? (streamer, modo, VIP ou pseudo de confiance) */
export function isTrusted(user: string, mod: boolean, o: Pick<DetectionSettings, 'trusted'>): boolean {
  const u = user.trim().toLowerCase()
  return mod || (Array.isArray(o.trusted) && o.trusted.some((t) => t.trim().toLowerCase() === u))
}

/** Lit le journal du tchat (.chat.jsonl) et le ramène à la chronologie de la vidéo. `words` : mots qui demandent un clip. */
export function parseChatLog(content: string, words?: string[]): { weights: number[]; requests: ChatRequest[] } | null {
  let videoStart: number | null = null
  const msgs: { at: number; user: string; text: string; mod: boolean }[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as { type: string; at: number; user?: string; text?: string; mod?: boolean }
      if (e.type === 'video' && videoStart === null) videoStart = e.at
      else if (e.type === 'msg') msgs.push({ at: e.at, user: e.user ?? '', text: e.text ?? '', mod: e.mod === true })
    } catch {
      /* ligne abîmée : ignorée */
    }
  }
  if (videoStart === null) return null
  const weights: number[] = []
  const requests: ChatRequest[] = []
  for (const m of msgs) {
    const t = Math.floor((m.at - videoStart) / 1000)
    if (t < 0) continue
    weights[t] = (weights[t] ?? 0) + chatWeight(m.text)
    const cmd = parseClipCommand(m.text, words)
    if (cmd) requests.push({ at: t, user: m.user, word: cmd.word, mod: m.mod, title: cmd.title })
  }
  return { weights: Array.from(weights, (x) => x ?? 0), requests }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Score robuste : (x - médiane) / écart absolu médian. Insensible aux valeurs extrêmes. */
function robustZ(values: number[], minScale: number): number[] {
  const med = median(values)
  const mad = median(values.map((v) => Math.abs(v - med)))
  const scale = Math.max(1.4826 * mad, minScale)
  return values.map((v) => (v - med) / scale)
}

function windowSum(values: number[], n: number, before: number, after: number): number[] {
  const prefix = [0]
  for (let i = 0; i < n; i++) prefix.push(prefix[i] + (values[i] ?? 0))
  return Array.from({ length: n }, (_, t) => {
    const a = Math.max(0, t - before)
    const b = Math.min(n, t + after + 1)
    return prefix[b] - prefix[a]
  })
}

function chatSignal(chat: number[], n: number): number[] {
  const summed = windowSum(chat, n, 4, 4)
  return robustZ(summed, 2).map((z) => Math.max(0, z))
}

function volumeSignal(loudness: number[], n: number): number[] {
  const db = Array.from({ length: n }, (_, i) => loudness[i] ?? -90)
  const smooth = db.map((_, i) => {
    const w = db.slice(Math.max(0, i - 1), Math.min(n, i + 2))
    return w.reduce((a, b) => a + b, 0) / w.length
  })
  const globalMed = median(smooth)
  const rise = smooth.map((v, i) => {
    const prev = smooth.slice(Math.max(0, i - 60), i)
    const base = prev.length >= 10 ? median(prev) : globalMed
    // On ne compte que les passages nettement plus forts que d'habitude.
    return v >= globalMed + 6 ? Math.max(0, v - base) : 0
  })
  return robustZ(rise, 3).map((z) => Math.max(0, z))
}

export function detectMoments(input: DetectInput, o: DetectionSettings): Candidate[] {
  const n = Math.max(input.loudness.length, Math.ceil(input.duration))
  if (n < 5) return []
  const sensitivity = Math.min(3, Math.max(0.3, o.sensitivity))
  const T = 4.5 / sensitivity
  const hasChat = o.chat && !!input.chat && input.chat.some((v) => v > 0)
  const chatZ = hasChat ? chatSignal(input.chat!, n) : new Array<number>(n).fill(0)
  const volZ = o.volume ? volumeSignal(input.loudness, n) : new Array<number>(n).fill(0)
  const volWeight = hasChat ? 1.2 : 1.6
  const combined = chatZ.map((c, i) => c + volWeight * volZ[i])

  // Durée fixe choisie dans les réglages : chaque clip dure exactement ce temps.
  const fixed = o.fixedLength > 0 ? Math.max(5, Math.round(o.fixedLength)) : 0
  const minLen = fixed ? Math.max(5, Math.round(fixed * 0.5)) : Math.max(5, o.minLength)
  const maxLen = fixed ? fixed : Math.max(minLen + 5, o.maxLength)
  const fit = (start: number, end: number, peak: number): [number, number] => {
    if (fixed) {
      // Le moment fort aux deux tiers du clip : on voit ce qui l'amène et la réaction.
      const s = Math.max(0, Math.min(n - fixed, peak - fixed * 0.65))
      return [Math.round(s), Math.round(Math.min(n, s + fixed))]
    }
    let s = start
    let e = end
    if (e - s < minLen) s = e - minLen
    if (e - s > maxLen) {
      s = Math.max(s, peak - maxLen * 0.7)
      e = s + maxLen
    }
    s = Math.max(0, s)
    e = Math.min(n, Math.max(e, s + Math.min(minLen, n)))
    return [Math.round(s), Math.round(e)]
  }

  let found: Candidate[] = []
  // Passages déjà pris en compte, sur toute leur étendue (avec une durée fixe, le clip
  // peut être plus court que le moment : un même moment ne doit pas en donner deux).
  const covered: { start: number; end: number }[] = []
  // 1) Pics du tchat et du son.
  const peaks = combined
    .map((score, t) => ({ score, t }))
    .filter((p) => p.score >= T)
    .sort((a, b) => b.score - a.score)
  for (const { score, t } of peaks) {
    if (covered.some((c) => t >= c.start - 5 && t <= c.end + 5)) continue
    let left = t
    let right = t
    while (left > 0 && t - left < 25 && combined[left - 1] >= T * 0.4) left--
    while (right < n - 1 && right - t < 25 && combined[right + 1] >= T * 0.4) right++
    covered.push({ start: left - 10, end: right + 4 })
    const [start, end] = fit(left - 10, right + 4, t)
    const reasons: Reason[] = []
    if (chatZ[t] >= 1.5) reasons.push('chat')
    if (volZ[t] >= 1.5) reasons.push('volume')
    if (reasons.length === 0) reasons.push(chatZ[t] >= volZ[t] ? 'chat' : 'volume')
    found.push({ start, end, peak: t, score, level: score >= T * 1.6 ? 'sure' : 'review', reasons, chatWord: null })
  }

  // 2) Le tchat écrit « clip » (assez de personnes, ou une personne de confiance).
  // Les demandes arrivent juste APRÈS le moment : elles renforcent le passage
  // qu'elles commentent ; s'il n'y en a pas, elles créent le leur. Un moment demandé
  // par le tchat n'est jamais écarté par la limite de clips automatiques.
  const requested: Candidate[] = []
  if (o.clipWord) {
    const reqs = [...input.requests].sort((a, b) => a.at - b.at)
    let group: ChatRequest[] = []
    const flush = (): void => {
      if (group.length === 0) return
      const users = new Set(group.map((r) => r.user.trim().toLowerCase()))
      if (users.size >= Math.max(1, o.chatUsers ?? 2) || group.some((r) => isTrusted(r.user, r.mod, o))) {
        const first = group[0].at
        const zone = markedWindow(first, 35, o)
        // « clip : titre » : le titre d'une personne de confiance d'abord, sinon le premier donné.
        const title = pickChatTitle(group.map((r) => ({ title: r.title, mod: isTrusted(r.user, r.mod, o) })))
        const pool = [...found, ...requested]
        const host = pool.filter((c) => overlapLen(c, zone) > 0).sort((a, b) => overlapLen(b, zone) - overlapLen(a, zone))[0]
        if (host) {
          host.reasons = [...new Set([...host.reasons, 'clip-word' as Reason])]
          host.chatWord ??= group[0].word
          host.title ??= title
          host.score += users.size
          if (found.includes(host)) {
            found = found.filter((c) => c !== host)
            requested.push(host)
          }
        } else {
          const [start, end] = fixed ? [zone.start, Math.min(n, zone.end)] : fit(zone.start, zone.end, first - 5)
          requested.push({ start, end, peak: Math.max(start, first - 5), score: T + users.size, level: 'review', reasons: ['clip-word'], chatWord: group[0].word, title })
        }
      }
      group = []
    }
    for (const r of reqs) {
      if (group.length > 0 && r.at - group[group.length - 1].at > 30) flush()
      group.push(r)
    }
    flush()
  }

  // 3) Touche Clip (ou « clip » dit par le streamer) : toujours gardée, et prioritaire sur le reste.
  const marked: Candidate[] = input.marks
    .filter((m) => (m.voice ? o.voice : o.hotkey) && m.at >= 0 && m.at <= n + 5)
    .map((m) => {
      const w = markedWindow(m.at, m.before, o)
      const start = w.start
      const end = Math.min(n, w.end)
      const local = combined.slice(start, Math.max(start + 1, end))
      const reason: Reason = m.voice ? 'voice' : 'hotkey'
      return { start, end, peak: Math.round(m.at), score: Math.max(T * 2, ...local), level: 'sure' as const, reasons: [reason], chatWord: null }
    })

  // 4) Limite du nombre de clips automatiques (les plus forts d'abord).
  const hours = n / 3600
  const limit = Math.max(3, Math.ceil(hours * o.maxPerHour))
  const auto = resolveOverlaps(found, maxLen, minLen).sort((a, b) => b.score - a.score).slice(0, limit)
  const all = resolveOverlaps([...marked, ...requested, ...auto], maxLen, minLen)
  return all.sort((a, b) => a.start - b.start).map((c) => ({ ...c, score: Math.round(c.score * 10) / 10 }))
}

function overlapLen(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

function combine(a: Candidate, b: Candidate, start: number, end: number): Candidate {
  const best = b.score > a.score ? b : a
  return {
    start,
    end,
    peak: best.peak,
    score: Math.max(a.score, b.score),
    level: a.level === 'sure' || b.level === 'sure' ? 'sure' : 'review',
    reasons: [...new Set([...a.reasons, ...b.reasons])],
    chatWord: a.chatWord ?? b.chatWord,
    title: a.title ?? b.title ?? null
  }
}

/**
 * Règle les chevauchements, dans l'ordre : touche Clip d'abord, puis du plus fort au moins fort.
 * - même moment (recouvrement ≥ 50 % du plus court) : fusion, sans dépasser la durée maximale ;
 * - simple contact : le passage le moins prioritaire est raccourci (ou abandonné s'il devient trop court).
 */
function resolveOverlaps(list: Candidate[], maxLen: number, minLen: number): Candidate[] {
  const rank = (c: Candidate): number => (c.reasons.includes('hotkey') || c.reasons.includes('voice') ? 1e6 : 0) + c.score
  const out: Candidate[] = []
  for (const c of [...list].sort((a, b) => rank(b) - rank(a))) {
    const cur = { ...c }
    let absorbed = false
    for (let i = 0; i < out.length && !absorbed; i++) {
      const o = out[i]
      const ov = overlapLen(o, cur)
      if (ov <= 0) continue
      const sameMoment = ov >= 0.5 * Math.min(o.end - o.start, cur.end - cur.start)
      const union = Math.max(o.end, cur.end) - Math.min(o.start, cur.start)
      if (sameMoment) {
        const grow = union <= Math.max(maxLen, o.end - o.start)
        out[i] = combine(o, cur, grow ? Math.min(o.start, cur.start) : o.start, grow ? Math.max(o.end, cur.end) : o.end)
        absorbed = true
      } else {
        if (cur.start < o.start) cur.end = o.start
        else cur.start = o.end
        if (cur.end - cur.start < minLen) {
          out[i] = combine(o, cur, o.start, o.end)
          absorbed = true
        } else if (cur.peak < cur.start || cur.peak > cur.end) {
          cur.peak = Math.min(cur.end, Math.max(cur.start, cur.peak))
        }
      }
    }
    if (!absorbed) out.push(cur)
  }
  return out
}
