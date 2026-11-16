// La commande du tchat qui demande un clip : « clip » tout seul, ou « clip : headshot » pour donner
// aussi le titre du clip (« headshot »). Le mot se choisit dans les réglages (« clip » par défaut,
// plusieurs mots possibles). Ce module ne dépend de rien : il sert au moteur, à l'interface et aux tests.

export const DEFAULT_CHAT_WORD = 'clip'
/** Avec le mot « clip », ses variantes comptent aussi : clips, clippe, clippez, clipper, clippé… */
const CLIP_VARIANTS = 'clip+(?:s|e|es|é|ée|ez|er|ed)?'
const MAX_WORDS = 5
const MAX_TITLE = 80

/** Mots choisis, nettoyés : minuscules, sans espace, 30 caractères et 5 mots au plus ; « clip » si vide. */
export function normalizeChatWords(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === 'string' ? input.split(/[,;\s]+/) : []
  const list = [...new Set(raw.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0 && w.length <= 30 && !/\s/.test(w) && /[\p{L}\p{N}]/u.test(w)))]
  return list.length > 0 ? list.slice(0, MAX_WORDS) : [DEFAULT_CHAT_WORD]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const cache = new Map<string, RegExp>()
function matcher(words: string[]): RegExp {
  const key = words.join('\n')
  let re = cache.get(key)
  if (!re) {
    const alts = words.map((w) => (w === DEFAULT_CHAT_WORD ? CLIP_VARIANTS : escapeRe(w))).join('|')
    // Le mot entier (pas « éclipse »), pas un nom de site (« clips.twitch.tv »), puis « : titre » facultatif.
    re = new RegExp(`(^|[^\\p{L}])(${alts})(?!\\p{L}|\\.\\p{L})(?:\\s*:\\s*(.*))?`, 'iu')
    cache.set(key, re)
  }
  return re
}

/** Titre proposé par le tchat, nettoyé : sans lien ni guillemets autour, 80 caractères au plus. */
export function cleanChatTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  let t = raw
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'«“‘\s]+|["'»”’\s]+$/g, '')
    .trim()
  if (t.length > MAX_TITLE) {
    const cut = t.slice(0, MAX_TITLE)
    const space = cut.lastIndexOf(' ')
    t = (space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trim()
  }
  return /[\p{L}\p{N}]/u.test(t) ? t : null
}

export interface ClipCommand {
  /** Le mot tel qu'il a été écrit (« CLIP », « clippez »…). */
  word: string
  /** Le titre donné après « : », ou null. */
  title: string | null
}

/** Ce message demande-t-il un clip ? (« clip », « clip : headshot »…) */
export function parseClipCommand(text: string, words: string[] = [DEFAULT_CHAT_WORD]): ClipCommand | null {
  const m = matcher(normalizeChatWords(words)).exec(text)
  if (!m) return null
  return { word: m[2], title: m[3] === undefined ? null : cleanChatTitle(m[3]) }
}

/** Le titre retenu pour un groupe de demandes : celui d'une personne de confiance d'abord, sinon le premier donné. */
export function pickChatTitle(requests: { title?: string | null; mod?: boolean }[]): string | null {
  return requests.find((r) => r.mod && r.title)?.title ?? requests.find((r) => r.title)?.title ?? null
}
