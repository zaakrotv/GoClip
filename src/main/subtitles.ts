// Fabrication du fichier de sous-titres .ass brûlé dans la vidéo par ffmpeg (libass).
// Chaque mot prononcé est mis en valeur (couleur + léger zoom) au moment où il est dit.
import { fontById, groupWords, outputSize } from '../shared/presets'
import type { Look, Word } from '../shared/types'

/** Couleur ASS : &HAABBGGRR (AA = transparence). */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '').padStart(6, '0').slice(0, 6).toUpperCase()
  const a = Math.round(Math.min(255, Math.max(0, alpha))).toString(16).padStart(2, '0').toUpperCase()
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`
}

export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, ' ')
}

export interface AssInput {
  look: Look
  words: Word[] | null
  /** Début et fin du clip dans le fichier source (s). */
  clipStart: number
  clipEnd: number
  title: string
  /** Décalage (s) : durée de l'intro, pendant laquelle rien n'est affiché. */
  offset?: number
}

export function buildAss({ look, words, clipStart, clipEnd, title, offset = 0 }: AssInput): string | null {
  const { width: W, height: H } = outputSize(look.framing.layout)
  const sub = look.subtitles
  const duration = clipEnd - clipStart
  const events: string[] = []
  const at = (t: number): string => assTime(t + offset)
  // Positions absentes (montages d'une ancienne version) : centré.
  const pos = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

  if (sub.enabled && words && words.length > 0) {
    const inClip = words
      .filter((w) => w.end > clipStart && w.start < clipEnd)
      .map((w) => ({
        text: sub.uppercase ? w.text.toLocaleUpperCase('fr-FR') : w.text,
        start: Math.max(0, w.start - clipStart),
        end: Math.min(duration, Math.max(w.end, w.start + 0.05) - clipStart)
      }))
    const groups = groupWords(inClip, sub.words)
    const cx = Math.round(pos(sub.x, 0.5) * W)
    const cy = Math.round(pos(sub.y, 0.74) * H)
    const pop = Math.round(sub.pop * 100)
    const active = assColor(sub.color)
    groups.forEach((group, gi) => {
      const nextGroupStart = groups[gi + 1]?.[0].start ?? duration
      group.forEach((word, wi) => {
        const start = word.start
        const end = wi + 1 < group.length ? group[wi + 1].start : Math.min(nextGroupStart, word.end + 0.5)
        if (end - start < 0.02) return
        const text = group
          .map((w, j) => {
            const t = escapeText(w.text)
            if (j === wi) {
              const zoom = pop > 100 ? `\\fscx${pop + 15}\\fscy${pop + 15}\\t(0,120,\\fscx${pop}\\fscy${pop})` : ''
              return `{\\c${active}${zoom}}${t}{\\r}`
            }
            if (sub.karaoke && j < wi) return `{\\c${active}}${t}{\\r}`
            return t
          })
          .join(' ')
        events.push(`Dialogue: 0,${at(start)},${at(end)},Sous,,0,0,0,,{\\an5\\pos(${cx},${cy})}${text}`)
      })
    })
  }

  const t = look.title
  if (t.enabled && title.trim()) {
    const end = t.duration > 0 ? Math.min(duration, t.duration) : duration
    events.push(`Dialogue: 1,${at(0)},${at(end)},Titre,,0,0,0,,{\\an5\\pos(${Math.round(pos(t.x, 0.5) * W)},${Math.round(pos(t.y, 0.18) * H)})}${escapeText(title.trim())}`)
  }

  if (events.length === 0) return null
  const sf = fontById(sub.font)
  const tf = fontById(t.font)
  const titleBorder = t.band ? 3 : 1
  const titleOutline = t.band ? Math.round(t.size * 0.28) : 4
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Taille × rapport de la police : même rendu que l'aperçu (voir FontDef.cell).
    `Style: Sous,${sf.family},${Math.round(sub.size * sf.cell)},${assColor(sub.base)},${assColor(sub.base)},${assColor(sub.outlineColor)},${assColor('#000000', 110)},0,0,0,0,100,100,0,0,1,${sub.outline},${sub.shadow},5,70,70,0,1`,
    `Style: Titre,${tf.family},${Math.round(t.size * tf.cell)},${assColor(t.color)},${assColor(t.color)},${assColor(t.band ? t.background : '#000000')},${assColor(t.background)},0,0,0,0,100,100,0,0,${titleBorder},${titleOutline},0,5,90,90,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n')
}

/** Polices à fournir à libass pour ce look. */
export function fontsUsed(look: Look): string[] {
  return [...new Set([fontById(look.subtitles.font).file, fontById(look.title.font).file])]
}
