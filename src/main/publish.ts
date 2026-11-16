// Agenda de publication : publications programmées, rappel à l'heure dite, préférences.
// Les réseaux (TikTok, Instagram, YouTube) n'acceptent les envois automatiques que des
// applications qu'ils ont auditées : à l'heure prévue, AutoClip prévient et prépare tout
// (vidéo à glisser, description copiée, page d'envoi ouverte), tu n'as plus qu'à valider.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_PREFS, normalizePrefs, NETWORKS, type Advice, type Network, type Post, type PostInput, type PostTarget, type PublishPrefs, type TargetState } from '../shared/publishing'
import { readJson, writeJson } from './jsonfile'
import { dataDir } from './paths'

interface Data {
  posts: Post[]
  prefs: PublishPrefs
  /** Dernier conseil de l'IA (gardé une semaine). */
  advice: Advice | null
}

export interface PublishHooks {
  onChange: () => void
  /** C'est l'heure de publier. `late` : l'heure est passée depuis un moment (appli fermée…). */
  remind: (post: Post, networks: Network[], late: boolean) => void
}

const file = (): string => join(dataDir(), 'publications.json')
let data: Data = { posts: [], prefs: { ...DEFAULT_PREFS }, advice: null }
let hooks: PublishHooks = { onChange: () => {}, remind: () => {} }
let timer: NodeJS.Timeout | null = null

const isNetwork = (n: unknown): n is Network => NETWORKS.some((x) => x.id === n)

function normalizePost(p: Partial<Post>): Post | null {
  if (!p || typeof p.id !== 'string' || typeof p.clipId !== 'string' || typeof p.at !== 'number') return null
  const targets: PostTarget[] = (Array.isArray(p.targets) ? p.targets : [])
    .filter((t) => t && isNetwork(t.network))
    .map((t) => ({ network: t.network, state: (['scheduled', 'due', 'published', 'skipped'] as const).includes(t.state) ? t.state : 'scheduled', url: t.url ?? null, doneAt: t.doneAt ?? null }))
  return {
    id: p.id,
    clipId: p.clipId,
    at: p.at,
    caption: typeof p.caption === 'string' ? p.caption : '',
    hashtags: typeof p.hashtags === 'string' ? p.hashtags : '',
    targets,
    createdAt: p.createdAt ?? Date.now(),
    updatedAt: p.updatedAt ?? Date.now(),
    remindedAt: p.remindedAt ?? null
  }
}

export function loadPublishing(): void {
  const raw = readJson<Partial<Data>>(file(), {})
  data = {
    posts: (Array.isArray(raw.posts) ? raw.posts : []).map(normalizePost).filter((p): p is Post => p !== null),
    prefs: normalizePrefs(raw.prefs),
    advice: raw.advice && Array.isArray(raw.advice.slots) ? raw.advice : null
  }
}

function save(): void {
  writeJson(file(), data)
}

function changed(): void {
  save()
  hooks.onChange()
}

/** Vérifie toutes les 20 s s'il est l'heure de publier quelque chose. */
export function startScheduler(h: PublishHooks): void {
  hooks = h
  if (timer) clearInterval(timer)
  timer = setInterval(() => tick(), 20_000)
  setTimeout(() => tick(), 4000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function tick(now = Date.now()): void {
  let any = false
  for (const p of data.posts) {
    if (p.at > now) continue
    const due = p.targets.filter((t) => t.state === 'scheduled')
    if (due.length === 0) continue
    for (const t of due) t.state = 'due'
    p.remindedAt = now
    any = true
    hooks.remind(p, due.map((t) => t.network), now - p.at > 15 * 60_000)
  }
  if (any) changed()
}

export const getPosts = (): Post[] => data.posts
export const getPrefs = (): PublishPrefs => data.prefs
export const getStoredAdvice = (): Advice | null => data.advice

export function setPrefs(patch: Partial<PublishPrefs>): PublishPrefs {
  data.prefs = normalizePrefs({ ...data.prefs, ...patch })
  changed()
  return data.prefs
}

export function setStoredAdvice(advice: Advice | null): void {
  data.advice = advice
  save()
}

/** Crée ou modifie une publication. Les réseaux déjà publiés gardent leur état. */
export function savePost(input: PostInput): Post {
  const now = Date.now()
  const existing = input.id ? data.posts.find((p) => p.id === input.id) : undefined
  const networks = [...new Set(input.networks.filter(isNetwork))]
  if (networks.length === 0) throw new Error('Choisis au moins un réseau.')
  const future = input.at > now
  const targets: PostTarget[] = networks.map((network) => {
    const old = existing?.targets.find((t) => t.network === network)
    if (!old) return { network, state: 'scheduled', url: null, doneAt: null }
    // Reprogrammée plus tard : ce qui n'était pas encore publié redevient « programmé ».
    if (future && (old.state === 'due' || old.state === 'skipped')) return { ...old, state: 'scheduled' }
    return old
  })
  const post: Post = {
    id: existing?.id ?? randomUUID(),
    clipId: input.clipId,
    at: Math.round(input.at),
    caption: input.caption,
    hashtags: input.hashtags,
    targets,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    remindedAt: existing && existing.at === Math.round(input.at) ? existing.remindedAt : null
  }
  data.posts = existing ? data.posts.map((p) => (p.id === post.id ? post : p)) : [...data.posts, post]
  changed()
  return post
}

export function deletePost(id: string): void {
  data.posts = data.posts.filter((p) => p.id !== id)
  changed()
}

/** « C'est publié » (avec le lien, facultatif), « pas sur ce réseau », ou retour à « à publier ». */
export function setTarget(id: string, network: Network, state: TargetState, url: string | null = null): Post | null {
  const post = data.posts.find((p) => p.id === id)
  if (!post) return null
  post.targets = post.targets.map((t) =>
    t.network === network ? { ...t, state, url: state === 'published' ? (url?.trim() || t.url) : t.url, doneAt: state === 'published' || state === 'skipped' ? Date.now() : null } : t
  )
  post.updatedAt = Date.now()
  changed()
  return post
}

/** Les clips supprimés pour de bon n'ont plus de publication prévue (celles déjà faites restent). */
export function forgetClips(ids: string[]): void {
  const before = data.posts.length
  data.posts = data.posts.filter((p) => !ids.includes(p.clipId) || p.targets.some((t) => t.state === 'published'))
  if (data.posts.length !== before) changed()
}
