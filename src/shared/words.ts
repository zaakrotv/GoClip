// Modification de la transcription mot par mot : chaque mot garde son instant quand on le
// corrige, on en supprime ou on en ajoute (les nouveaux mots prennent la place laissée libre).
import type { Word } from './types'

const round = (n: number): number => Math.round(n * 100) / 100
const norm = (s: string): string => s.toLocaleLowerCase('fr-FR').replace(/[^\p{L}\p{N}]/gu, '')

/** Répartit des mots sur un intervalle, proportionnellement à leur longueur. */
function spread(texts: string[], from: number, to: number): Word[] {
  if (texts.length === 0) return []
  const span = Math.max(0.08 * texts.length, to - from)
  const weights = texts.map((t) => Math.max(1, t.length))
  const total = weights.reduce((a, b) => a + b, 0)
  let t = from
  return texts.map((text, i) => {
    const d = (span * weights[i]) / total
    const w = { text, start: round(t), end: round(t + d) }
    t += d
    return w
  })
}

/** Remplace le texte d'un mot ; plusieurs mots tapés se partagent son temps. */
export function replaceWord(words: Word[], index: number, text: string): Word[] {
  const w = words[index]
  if (!w) return words
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return words.filter((_, i) => i !== index)
  const next = parts.length === 1 ? [{ ...w, text: parts[0] }] : spread(parts, w.start, w.end)
  return [...words.slice(0, index), ...next, ...words.slice(index + 1)]
}

export function removeWords(words: Word[], indexes: number[]): Word[] {
  const set = new Set(indexes)
  return words.filter((_, i) => !set.has(i))
}

/** Ajoute un mot juste après `index` (dans le silence qui suit, ou en partageant le mot). */
export function insertWordAfter(words: Word[], index: number, text: string): { words: Word[]; index: number } {
  const w = words[index]
  if (!w) return { words, index }
  const next = words[index + 1]
  const gapEnd = next ? next.start : w.end + 0.6
  let added: Word
  const out = [...words]
  if (gapEnd - w.end >= 0.15) {
    added = { text, start: round(w.end), end: round(Math.min(gapEnd, w.end + 0.5)) }
  } else {
    const mid = round((w.start + w.end) / 2)
    out[index] = { ...w, end: mid }
    added = { text, start: mid, end: w.end }
  }
  out.splice(index + 1, 0, added)
  return { words: out, index: index + 1 }
}

/**
 * Le texte du passage a été retapé : on retrouve les mots qui n'ont pas changé (plus longue
 * sous-suite commune) pour garder leur instant, et on place les nouveaux mots entre eux.
 * `from` / `to` : bornes du passage, utilisées s'il n'y a aucun repère autour.
 */
export function retimeWords(old: Word[], text: string, from: number, to: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  if (old.length === 0) return spread(tokens, from, to)
  const a = old.map((w) => norm(w.text))
  const b = tokens.map(norm)
  const n = a.length
  const m = b.length
  // Table de la plus longue sous-suite commune.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  const out: Word[] = []
  let prevOld = -1
  let prevNew = -1
  const fill = (oldTo: number, newTo: number): void => {
    // Mots nouveaux entre deux repères : ils prennent le temps des anciens mots remplacés,
    // sinon le silence entre les deux repères.
    const texts = tokens.slice(prevNew + 1, newTo)
    if (texts.length === 0) return
    const replaced = old.slice(prevOld + 1, oldTo)
    const left = prevOld >= 0 ? old[prevOld].end : from
    const right = oldTo < n ? old[oldTo].start : to
    const start = replaced.length > 0 ? replaced[0].start : left
    const end = replaced.length > 0 ? replaced[replaced.length - 1].end : Math.max(left, right)
    out.push(...spread(texts, start, end))
  }
  for (const [i, j] of pairs) {
    fill(i, j)
    out.push({ ...old[i], text: tokens[j] })
    prevOld = i
    prevNew = j
  }
  fill(n, m)
  // Les instants restent croissants.
  for (let k = 1; k < out.length; k++) {
    if (out[k].start < out[k - 1].start) out[k] = { ...out[k], start: out[k - 1].start }
    if (out[k].end < out[k].start) out[k] = { ...out[k], end: round(out[k].start + 0.05) }
  }
  return out
}

/** Remplace les mots du passage [start, end[ par une nouvelle liste (le reste ne bouge pas). */
export function replaceRange(words: Word[], start: number, end: number, replacement: Word[]): Word[] {
  const before = words.filter((w) => w.end <= start)
  const after = words.filter((w) => w.start >= end)
  return [...before, ...replacement, ...after]
}
