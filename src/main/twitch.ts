// Accès à Twitch : statut des lives, recherche et profils (API publique GQL du site twitch.tv).
import type { ChannelSuggestion } from '../shared/types'
import { streamlinkExe } from './deps'
import { run } from './proc'

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

/** Accepte « pseudo », « twitch.tv/pseudo » ou un lien complet. */
export function parseChannel(input: string): string | null {
  const s = input.trim()
  const m = /(?:twitch\.tv\/)?@?([a-zA-Z0-9_]{3,25})\/?(?:[?#].*)?$/.exec(s.replace(/^https?:\/\/(www\.|m\.)?/, ''))
  if (!m) return null
  const login = m[1].toLowerCase()
  if (['videos', 'directory', 'settings', 'p', 'search'].includes(login)) return null
  return login
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000)
  })
  const json = (await res.json()) as { data?: T; errors?: unknown }
  if (!res.ok || !json.data) throw new Error(`Twitch répond ${res.status}`)
  return json.data
}

export interface StreamInfo {
  exists: boolean
  live: boolean
  id: string | null
  startedAt: number | null
  title: string | null
  game: string | null
  viewers: number | null
}

export async function streamInfo(login: string): Promise<StreamInfo> {
  const data = await gql<{
    user: null | {
      broadcastSettings: { title: string | null; game: { displayName: string } | null } | null
      stream: null | { id: string; createdAt: string; viewersCount: number }
    }
  }>('query($login: String!) { user(login: $login) { broadcastSettings { title game { displayName } } stream { id createdAt viewersCount } } }', { login })
  const u = data.user
  if (!u) return { exists: false, live: false, id: null, startedAt: null, title: null, game: null, viewers: null }
  return {
    exists: true,
    live: !!u.stream,
    id: u.stream?.id ?? null,
    startedAt: u.stream ? Date.parse(u.stream.createdAt) : null,
    title: u.broadcastSettings?.title ?? null,
    game: u.broadcastSettings?.game?.displayName ?? null,
    viewers: u.stream?.viewersCount ?? null
  }
}

/** Plan B si l'API ne répond pas : demande à Streamlink si un flux est disponible. */
export async function streamlinkLive(login: string): Promise<boolean | null> {
  const exe = streamlinkExe()
  if (!exe) return null
  const r = await run(exe, ['--no-config', '--json', `https://www.twitch.tv/${login}`], { timeoutMs: 60_000 })
  try {
    const json = JSON.parse(r.stdout) as { streams?: unknown; error?: string }
    if (json.streams) return true
    if (String(json.error ?? '').startsWith('No playable streams')) return false
  } catch {
    /* réponse illisible */
  }
  return null
}

/** Chaînes dont le pseudo ressemble à ce qui est tapé, avec leur statut live. */
export async function searchChannels(query: string): Promise<ChannelSuggestion[]> {
  const q = query.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '')
  if (q.length < 2) return []
  const data = await gql<{
    searchUsers: {
      edges: {
        node: { login: string; displayName: string; profileImageURL: string | null; stream: { viewersCount: number } | null; followers: { totalCount: number } | null }
      }[]
    } | null
  }>('query($q: String!) { searchUsers(userQuery: $q, first: 8) { edges { node { login displayName profileImageURL(width: 50) stream { viewersCount } followers { totalCount } } } } }', { q })
  return (data.searchUsers?.edges ?? []).map(({ node }) => ({
    login: node.login,
    displayName: node.displayName,
    avatar: node.profileImageURL,
    live: !!node.stream,
    viewers: node.stream?.viewersCount ?? null,
    followers: node.followers?.totalCount ?? null
  }))
}

export interface Profile {
  login: string
  displayName: string
  avatar: string | null
}

export async function profile(login: string): Promise<Profile | null> {
  const data = await gql<{ user: null | { login: string; displayName: string; profileImageURL: string | null } }>(
    'query($login: String!) { user(login: $login) { login displayName profileImageURL(width: 70) } }',
    { login }
  )
  if (!data.user) return null
  let avatar: string | null = null
  if (data.user.profileImageURL) {
    try {
      const img = await fetch(data.user.profileImageURL, { signal: AbortSignal.timeout(15_000) })
      const type = img.headers.get('content-type') ?? 'image/png'
      avatar = `data:${type};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`
    } catch {
      avatar = null
    }
  }
  return { login: data.user.login, displayName: data.user.displayName, avatar }
}
