// Publication sur les réseaux : types, réseaux pris en charge et calcul des créneaux conseillés.
// Ce module ne dépend ni d'Electron ni du navigateur : il sert au processus principal,
// à l'interface et aux tests.

export type Network = 'tiktok' | 'instagram' | 'youtube'

export interface NetworkInfo {
  id: Network
  label: string
  /** Page d'envoi d'une vidéo sur le site du réseau. */
  upload: string
  color: string
  icon: string
  /** Longueur maximale de la description (caractères). */
  maxCaption: number
}

export const NETWORKS: NetworkInfo[] = [
  { id: 'tiktok', label: 'TikTok', upload: 'https://www.tiktok.com/upload', color: '#25F4EE', icon: '🎵', maxCaption: 4000 },
  { id: 'instagram', label: 'Instagram Reels', upload: 'https://www.instagram.com/', color: '#E1306C', icon: '📸', maxCaption: 2200 },
  { id: 'youtube', label: 'YouTube Shorts', upload: 'https://www.youtube.com/upload', color: '#FF3B30', icon: '▶️', maxCaption: 5000 }
]

export const networkInfo = (id: Network): NetworkInfo => NETWORKS.find((n) => n.id === id) ?? NETWORKS[0]

/**
 * scheduled = programmé ; due = c'est l'heure, à publier ; published = publié (par toi) ;
 * skipped = pas publié sur ce réseau finalement.
 */
export type TargetState = 'scheduled' | 'due' | 'published' | 'skipped'

export interface PostTarget {
  network: Network
  state: TargetState
  /** Lien de la publication (facultatif, collé après la publication). */
  url: string | null
  doneAt: number | null
}

export interface Post {
  id: string
  clipId: string
  /** Date et heure de publication prévues (ms). */
  at: number
  /** Description (le titre du clip au départ). */
  caption: string
  /** Hashtags, séparés par des espaces (« #twitch #gaming »). */
  hashtags: string
  targets: PostTarget[]
  createdAt: number
  updatedAt: number
  /** Dernier rappel envoyé (ms), pour ne pas le répéter. */
  remindedAt: number | null
}

export interface PostInput {
  id?: string
  clipId: string
  at: number
  caption: string
  hashtags: string
  networks: Network[]
}

/** Un créneau type de la semaine : jour (0 = lundi … 6 = dimanche) et heure locale. */
export interface WeeklySlot {
  network: Network
  day: number
  hour: number
  minute: number
  /** 0..1 */
  score: number
  why: string
}

export interface Advice {
  source: 'local' | 'ia'
  createdAt: number
  summary: string
  tips: string[]
  slots: WeeklySlot[]
  /** Sources consultées par l'IA (liens). */
  sources: { title: string; url: string }[]
  /** Modèle utilisé (conseiller IA). */
  model: string | null
}

/** Un créneau précis (date réelle) proposé dans l'agenda. */
export interface SuggestedSlot {
  network: Network
  at: number
  score: number
  why: string
}

/** IA des boutons ✨ : « local » = gratuite, sur le PC ; « claude » = Claude avec une clé API (payant). */
export type AiEngine = 'local' | 'claude'

export interface LocalAiInfo {
  installed: boolean
  installing: boolean
  /** Où elle tourne en ce moment (nom de la carte graphique ou « processeur »), null si arrêtée. */
  device: string | null
  error: string | null
  label: string
  size: string
}

export interface AiStatus {
  engine: AiEngine
  hasKey: boolean
  model: string
  local: LocalAiInfo
}

/** Préférences de publication (gardées avec l'agenda). */
export interface PublishPrefs {
  /** Réseaux cochés par défaut pour une nouvelle publication. */
  networks: Network[]
  /** Publications au plus par jour et par réseau (pour les créneaux conseillés). */
  perDay: number
  /** Hashtags ajoutés à chaque nouvelle publication. */
  hashtags: string
  /** Modèle Claude du conseiller IA (facultatif). */
  aiModel: string
  /** IA des boutons ✨ (gratuite sur le PC par défaut). */
  aiEngine: AiEngine
}

export const AI_MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus fiable)' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (moins cher)' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le moins cher)' }
]

export const DEFAULT_PREFS: PublishPrefs = {
  networks: ['tiktok', 'instagram', 'youtube'],
  perDay: 2,
  hashtags: '#twitch #gaming #clip',
  aiModel: 'claude-opus-5-5',
  aiEngine: 'local'
}

export function normalizePrefs(input: unknown): PublishPrefs {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<PublishPrefs>
  const networks = Array.isArray(p.networks) ? p.networks.filter((n): n is Network => NETWORKS.some((x) => x.id === n)) : DEFAULT_PREFS.networks
  return {
    networks,
    perDay: typeof p.perDay === 'number' && p.perDay >= 1 ? Math.min(6, Math.round(p.perDay)) : DEFAULT_PREFS.perDay,
    hashtags: typeof p.hashtags === 'string' ? p.hashtags : DEFAULT_PREFS.hashtags,
    aiModel: typeof p.aiModel === 'string' && AI_MODELS.some((m) => m.value === p.aiModel) ? p.aiModel : DEFAULT_PREFS.aiModel,
    aiEngine: p.aiEngine === 'claude' ? 'claude' : 'local'
  }
}

export const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

/** Jour de la semaine façon France : 0 = lundi … 6 = dimanche. */
export const weekday = (d: Date): number => (d.getDay() + 6) % 7

// ---------- Créneaux conseillés sans IA ----------

/**
 * Repères généraux d'activité par heure (0..1), tels qu'on les retrouve dans la plupart des
 * études du secteur : midi et soirée en semaine, fin de matinée et soirée le week-end, très peu
 * la nuit. Ce ne sont que des points de départ : ils sont ensuite ajustés avec les heures où
 * TA communauté est en ligne (tes lives).
 */
const BASE: Record<Network, { week: number[]; weekend: number[] }> = {
  tiktok: {
    //     0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18   19   20   21   22   23
    week: [0.3, 0.15, 0.08, 0.05, 0.05, 0.08, 0.15, 0.3, 0.35, 0.35, 0.4, 0.5, 0.75, 0.7, 0.55, 0.5, 0.55, 0.65, 0.85, 0.95, 1, 0.95, 0.8, 0.55],
    weekend: [0.4, 0.25, 0.12, 0.06, 0.05, 0.06, 0.1, 0.2, 0.35, 0.5, 0.7, 0.8, 0.8, 0.75, 0.65, 0.6, 0.65, 0.75, 0.85, 0.95, 1, 0.95, 0.8, 0.6]
  },
  instagram: {
    week: [0.2, 0.1, 0.05, 0.04, 0.04, 0.06, 0.2, 0.4, 0.5, 0.5, 0.55, 0.75, 0.9, 0.85, 0.6, 0.5, 0.55, 0.7, 0.9, 1, 0.95, 0.8, 0.6, 0.35],
    weekend: [0.25, 0.12, 0.06, 0.04, 0.04, 0.05, 0.1, 0.25, 0.45, 0.7, 0.85, 0.9, 0.85, 0.75, 0.6, 0.55, 0.6, 0.7, 0.85, 0.95, 0.9, 0.75, 0.55, 0.35]
  },
  youtube: {
    week: [0.25, 0.12, 0.06, 0.04, 0.04, 0.05, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.65, 0.7, 0.7, 0.7, 0.8, 0.9, 0.95, 1, 0.95, 0.85, 0.65, 0.45],
    weekend: [0.3, 0.15, 0.07, 0.04, 0.04, 0.05, 0.1, 0.25, 0.45, 0.65, 0.8, 0.85, 0.85, 0.8, 0.75, 0.75, 0.8, 0.9, 0.95, 1, 0.95, 0.8, 0.6, 0.4]
  }
}

/** Créneaux de live passés (ms), pour savoir quand ta communauté est là. */
export interface StreamSpan {
  start: number
  end: number
}

/**
 * Carte d'activité de ta communauté : pour chaque jour (lundi..dimanche) et chaque heure,
 * part des lives passés qui couvraient ce moment (0..1).
 */
export function audienceMap(streams: StreamSpan[]): number[][] {
  const map = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  if (streams.length === 0) return map
  const weeks = new Set<number>()
  for (const s of streams) {
    const end = Math.min(s.end, s.start + 16 * 3600_000)
    for (let t = Math.floor(s.start / 3600_000) * 3600_000; t < end; t += 3600_000) {
      const d = new Date(t)
      map[weekday(d)][d.getHours()] += 1
    }
    weeks.add(Math.floor(s.start / (7 * 86400_000)))
  }
  const n = Math.max(1, weeks.size)
  return map.map((row) => row.map((v) => Math.min(1, v / n)))
}

/** Note d'un moment pour un réseau : repères généraux + présence de ta communauté. */
export function slotScore(network: Network, day: number, hour: number, audience: number[][] | null): number {
  const base = (day >= 5 ? BASE[network].weekend : BASE[network].week)[hour] ?? 0
  if (!audience || !audience.some((row) => row.some((v) => v > 0))) return base
  // Juste avant un live (1 à 3 h) : la publication ramène du monde sur le live.
  const live = audience[day][hour]
  let before = 0
  for (let k = 1; k <= 3; k++) {
    const h = hour + k
    const dd = h >= 24 ? (day + 1) % 7 : day
    before = Math.max(before, audience[dd][h % 24] * (1 - (k - 1) * 0.2))
  }
  return Math.min(1, 0.65 * base + 0.2 * live + 0.25 * before)
}

function whyLocal(network: Network, day: number, hour: number, audience: number[][] | null): string {
  const parts: string[] = []
  const base = (day >= 5 ? BASE[network].weekend : BASE[network].week)[hour] ?? 0
  if (base >= 0.85) parts.push(hour >= 17 ? 'heure de pointe du soir' : 'pause de midi, beaucoup de monde en ligne')
  else if (base >= 0.65) parts.push('moment où le public est actif')
  if (audience) {
    let soon = false
    for (let k = 1; k <= 3; k++) {
      const h = hour + k
      const dd = h >= 24 ? (day + 1) % 7 : day
      if (audience[dd][h % 24] >= 0.4) soon = true
    }
    if (soon) parts.push('juste avant un de tes lives habituels')
    else if (audience[day][hour] >= 0.4) parts.push('pendant tes heures de live : ta communauté est là')
  }
  return parts.length ? parts.join(', ') : 'créneau correct'
}

/** Les meilleurs créneaux de la semaine (sans IA), par réseau. */
export function localWeeklySlots(audience: number[][] | null, perNetwork = 6): WeeklySlot[] {
  const out: WeeklySlot[] = []
  for (const n of NETWORKS) {
    const all: WeeklySlot[] = []
    for (let day = 0; day < 7; day++) {
      for (let hour = 7; hour < 24; hour++) {
        all.push({ network: n.id, day, hour, minute: 0, score: slotScore(n.id, day, hour, audience), why: '' })
      }
    }
    all.sort((a, b) => b.score - a.score)
    const picked: WeeklySlot[] = []
    for (const s of all) {
      if (picked.length >= perNetwork) break
      // Un seul créneau par jour et par réseau dans le top, pour étaler sur la semaine.
      if (picked.some((p) => p.day === s.day)) continue
      picked.push({ ...s, score: Math.round(s.score * 100) / 100, why: whyLocal(n.id, s.day, s.hour, audience) })
    }
    out.push(...picked)
  }
  return out
}

/**
 * Transforme des créneaux types (jour + heure) en vraies dates à venir, en évitant les
 * moments déjà pris et en respectant un nombre maximum de publications par jour.
 */
export function upcomingSlots(opts: {
  weekly: WeeklySlot[]
  from: number
  days: number
  posts: { at: number; networks: Network[] }[]
  perDay: number
  network?: Network
}): SuggestedSlot[] {
  const out: SuggestedSlot[] = []
  const start = new Date(opts.from)
  start.setHours(0, 0, 0, 0)
  for (let i = 0; i < opts.days; i++) {
    const day = new Date(start.getTime())
    day.setDate(start.getDate() + i)
    const wd = weekday(day)
    for (const w of opts.weekly) {
      if (w.day !== wd || (opts.network && w.network !== opts.network)) continue
      const at = new Date(day.getTime())
      at.setHours(w.hour, w.minute, 0, 0)
      const t = at.getTime()
      if (t < opts.from + 15 * 60_000) continue
      const sameDay = opts.posts.filter((p) => p.networks.includes(w.network) && sameLocalDay(p.at, t))
      if (sameDay.length >= opts.perDay) continue
      // Au moins 3 heures entre deux publications sur le même réseau.
      if (sameDay.some((p) => Math.abs(p.at - t) < 3 * 3600_000)) continue
      out.push({ network: w.network, at: t, score: w.score, why: w.why })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** Meilleur créneau libre à venir pour un ensemble de réseaux (le plus tôt parmi les très bons). */
export function bestSlot(opts: { weekly: WeeklySlot[]; from: number; posts: { at: number; networks: Network[] }[]; perDay: number; networks: Network[] }): SuggestedSlot | null {
  const nets = opts.networks.length > 0 ? opts.networks : NETWORKS.map((n) => n.id)
  const candidates = upcomingSlots({ weekly: opts.weekly, from: opts.from, days: 14, posts: opts.posts, perDay: opts.perDay }).filter((s) => nets.includes(s.network))
  if (candidates.length === 0) return null
  const top = Math.max(...candidates.map((c) => c.score))
  // Le premier créneau à au moins 85 % du meilleur : on ne repousse pas une publication d'une semaine pour 2 points.
  return candidates.find((c) => c.score >= top * 0.85) ?? candidates[0]
}

// ---------- Textes ----------

/** Nettoie une liste de hashtags : « twitch, #Gaming  fr » → « #twitch #Gaming #fr ». */
export function normalizeHashtags(input: string): string {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of input.split(/[\s,;]+/)) {
    const t = raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    tags.push(`#${t}`)
  }
  return tags.join(' ')
}

/** Transforme un nom (jeu, chaîne) en hashtag. */
export function toHashtag(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
  return t.length >= 2 ? `#${t}` : null
}

/** Texte écrit par une IA, nettoyé : espaces, lignes vides en trop, longueur (coupée en fin de phrase). */
export function cleanAiText(input: unknown, max: number): string {
  const t = String(input ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'))
  return (end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)}…`).trim()
}

/**
 * Description et hashtags écrits par une IA, mis en forme : les hashtags laissés à la fin de la
 * description passent dans la case des hashtags, ceux du streamer sont ajoutés, et la ligne
 * « En live sur twitch.tv/… » est ajoutée si elle manque.
 */
export function finishCaption(opts: { description: unknown; hashtags: unknown; channel: string; defaults: string }): { caption: string; hashtags: string } {
  const lines = cleanAiText(opts.description, 1500).split('\n')
  const moved: string[] = []
  while (lines.length > 1 && /^\s*(#[\p{L}\p{N}_]+[\s,]*)+$/u.test(lines[lines.length - 1])) moved.unshift(lines.pop() as string)
  // Hashtags collés à la fin de la dernière phrase : « … TOP 1 ! #fortnite #twitch ».
  const tail = /(\s+#[\p{L}\p{N}_]+)+\s*$/u.exec(lines[lines.length - 1] ?? '')
  if (tail && tail.index > 0) {
    moved.unshift(tail[0].trim())
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, tail.index).trimEnd()
  }
  let caption = lines.join('\n').trim()
  const live = opts.channel && opts.channel !== 'imports' ? `En live sur twitch.tv/${opts.channel}` : ''
  if (live && !/twitch\.tv\//i.test(caption)) caption = `${caption}\n\n${live}`.trim()
  const tags = (Array.isArray(opts.hashtags) ? opts.hashtags.map(String) : [String(opts.hashtags ?? '')]).join(' ')
  return { caption, hashtags: normalizeHashtags(`${tags} ${moved.join(' ')} ${opts.defaults}`) }
}

/** Texte prêt à coller sur un réseau. Pour YouTube, la première ligne sert de titre (100 caractères max). */
export function formatCaption(network: Network, caption: string, hashtags: string): { title: string | null; text: string } {
  const tags = normalizeHashtags(hashtags)
  const body = caption.trim()
  if (network === 'youtube') {
    const first = (body.split('\n')[0] || 'Clip').trim()
    const withShorts = /#shorts/i.test(first) ? first : `${first} #Shorts`
    const title = withShorts.length > 100 ? `${first.slice(0, 100 - 9).trim()}… #Shorts` : withShorts
    return { title, text: [body, tags].filter(Boolean).join('\n\n') }
  }
  const text = [body, tags].filter(Boolean).join('\n\n')
  const max = networkInfo(network).maxCaption
  return { title: null, text: text.length > max ? text.slice(0, max) : text }
}
