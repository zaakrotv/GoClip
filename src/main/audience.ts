// Quand la communauté d'une chaîne est en ligne : d'après ses lives passés (rediffusions Twitch).
import type { StreamSpan } from '../shared/publishing'

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const cache = new Map<string, { at: number; streams: PastStream[] }>()

export interface PastStream extends StreamSpan {
  game: string | null
}

/** Les derniers lives d'une chaîne (jusqu'à 50), gardés en mémoire 6 heures. */
export async function pastStreams(login: string): Promise<PastStream[]> {
  const hit = cache.get(login)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.streams
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($login: String!) { user(login: $login) { videos(first: 50, type: ARCHIVE, sort: TIME) { edges { node { createdAt lengthSeconds game { displayName } } } } } }',
      variables: { login }
    }),
    signal: AbortSignal.timeout(15_000)
  })
  const json = (await res.json()) as {
    data?: { user: null | { videos: { edges: { node: { createdAt: string; lengthSeconds: number; game: { displayName: string } | null } }[] } | null } }
  }
  if (!res.ok || !json.data) throw new Error(`Twitch répond ${res.status}`)
  const streams = (json.data.user?.videos?.edges ?? [])
    .map(({ node }) => {
      const start = Date.parse(node.createdAt)
      return { start, end: start + Math.max(0, node.lengthSeconds) * 1000, game: node.game?.displayName ?? null }
    })
    .filter((s) => Number.isFinite(s.start) && s.end > s.start)
  cache.set(login, { at: Date.now(), streams })
  return streams
}

/** Lives passés de plusieurs chaînes (une chaîne qui ne répond pas est ignorée). */
export async function pastStreamsOf(logins: string[]): Promise<PastStream[]> {
  const all = await Promise.all(
    [...new Set(logins)].slice(0, 6).map(async (l) => {
      try {
        return await pastStreams(l)
      } catch (err) {
        console.error('[audience]', l, err)
        return []
      }
    })
  )
  return all.flat()
}

/** Le jeu joué à un moment donné (d'après la rediffusion du live), si Twitch la garde encore. */
export async function gameAt(login: string, at: number): Promise<string | null> {
  try {
    const streams = await pastStreams(login)
    return streams.find((s) => at >= s.start - 60_000 && at <= s.end + 60_000)?.game ?? null
  } catch {
    return null
  }
}

/** Les jeux les plus streamés récemment (pour les hashtags et le conseiller IA). */
export function topGames(streams: PastStream[], n = 3): string[] {
  const count = new Map<string, number>()
  for (const s of streams) if (s.game) count.set(s.game, (count.get(s.game) ?? 0) + (s.end - s.start))
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g)
}
