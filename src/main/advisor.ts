// Conseiller de publication : quand publier, et quoi écrire.
// - Sans IA (toujours dispo) : repères généraux par réseau, ajustés avec les heures de live de la chaîne.
// - IA gratuite (par défaut) : un petit modèle qui tourne sur le PC (llm.ts), sans clé ni internet.
//   Il lit les habitudes de live, les jeux et les créneaux calculés, et écrit des conseils adaptés,
//   ainsi que les descriptions et hashtags des clips.
// - Claude (facultatif, clé API Anthropic de l'utilisateur, payant) : fait en plus des recherches web
//   sur ce que les algorithmes favorisent en ce moment et propose ses propres créneaux.
import Anthropic from '@anthropic-ai/sdk'
import { audienceMap, cleanAiText, DAYS, finishCaption, localWeeklySlots, NETWORKS, normalizeHashtags, toHashtag, type Advice, type Network, type WeeklySlot } from '../shared/publishing'
import type { Clip } from '../shared/types'
import { gameAt, pastStreamsOf, topGames, type PastStream } from './audience'
import { askLocalAi, LOCAL_MODEL } from './llm'
import { getPrefs, getStoredAdvice, setStoredAdvice } from './publish'
import { getSecret } from './secrets'

export interface CaptionInput {
  title: string
  channel: string
  game: string | null
  /** Ce qui est dit dans le clip (transcription), si disponible. */
  transcript: string
  defaultHashtags: string
}

export interface CaptionResult {
  caption: string
  hashtags: string
}

// ---------- Sans IA ----------

/** Résume les horaires de live habituels : « mardi 19h-23h »… */
function liveHabits(streams: PastStream[]): { jour: string; debut: number; fin: number; frequence: number }[] {
  const map = audienceMap(streams)
  const out: { jour: string; debut: number; fin: number; frequence: number }[] = []
  map.forEach((row, day) => {
    let h = 0
    while (h < 24) {
      if (row[h] >= 0.35) {
        const start = h
        let peak = 0
        while (h < 24 && row[h] >= 0.35) peak = Math.max(peak, row[h++])
        out.push({ jour: DAYS[day], debut: start, fin: h, frequence: Math.round(peak * 100) / 100 })
      } else h++
    }
  })
  return out
}

export async function localAdvice(channels: string[]): Promise<Advice> {
  const streams = await pastStreamsOf(channels)
  const audience = streams.length > 0 ? audienceMap(streams) : null
  const habits = liveHabits(streams)
  const summary =
    streams.length > 0
      ? `Créneaux calculés à partir des ${streams.length} derniers lives de ${channels.join(', ')}${habits.length ? ` (surtout ${habits.slice(0, 3).map((x) => `${x.jour} ${x.debut}h-${x.fin}h`).join(', ')})` : ''} et des moments où le public de chaque réseau est le plus actif.`
      : 'Créneaux calculés à partir des moments où le public de chaque réseau est le plus actif (aucun live passé trouvé pour affiner).'
  return {
    source: 'local',
    createdAt: Date.now(),
    summary,
    tips: [
      'Publie régulièrement : un ou deux clips par jour valent mieux que dix d’un coup.',
      'Une publication 1 à 3 h avant ton live ramène du monde sur Twitch : mets ton prochain live dans la description.',
      'Les 3 premières secondes décident de tout : commence le clip au moment le plus fort, avec un titre accrocheur.',
      'Réponds aux commentaires dans la première heure : les algorithmes poussent les vidéos qui font réagir.'
    ],
    slots: localWeeklySlots(audience),
    sources: [],
    model: null
  }
}

/** Description et hashtags simples, à partir du titre, du jeu et de la chaîne. */
export function localCaption(c: CaptionInput): CaptionResult {
  const title = c.title.trim()
  const caption = title ? title : c.game ? `Moment fou sur ${c.game} 😱` : 'Moment fou en live 😱'
  const extra = [toHashtag(c.game), toHashtag(c.channel), '#twitch', '#clip', '#fyp'].filter(Boolean).join(' ')
  return { caption: `${caption}\n\nEn live sur twitch.tv/${c.channel}`, hashtags: normalizeHashtags(`${extra} ${c.defaultHashtags}`) }
}

// ---------- Avec l'IA gratuite (sur le PC) ----------

/**
 * Ce que l'on sait de façon sûre sur ce que les trois réseaux favorisent. L'IA gratuite ne va pas
 * sur internet : elle s'appuie sur ces repères (et sur les données du streamer) plutôt que d'inventer.
 */
const ALGO_FACTS = [
  'Sur les trois réseaux, ce qui compte le plus : le temps de visionnage, les vidéos regardées jusqu’au bout et revues, puis les partages, les enregistrements et les commentaires. Les « j’aime » comptent moins.',
  'Les 1 à 3 premières secondes décident si la personne reste : commencer directement par l’action ou la réaction, avec un texte à l’écran qui donne envie de voir la suite.',
  'Beaucoup regardent sans le son : les sous-titres incrustés gardent les gens plus longtemps.',
  'TikTok sert aussi de moteur de recherche : les mots que les gens tapent (nom du jeu, du personnage, de la situation) doivent être dans la description, à l’écran ou dits dans la vidéo.',
  'YouTube Shorts accepte jusqu’à 3 minutes ; le titre (première ligne) compte, avec le nom du jeu ; une vidéo qui boucle bien est revue.',
  'Instagram Reels accepte jusqu’à 3 minutes ; les partages en message privé aident beaucoup à toucher de nouvelles personnes ; Instagram montre moins les vidéos avec le logo d’un autre réseau et les contenus repostés.',
  'La régularité aide : 1 ou 2 publications par jour, à heures régulières, valent mieux que dix d’un coup.',
  'Quelques hashtags précis (le jeu, le type de moment, la communauté) valent mieux qu’une longue liste de hashtags génériques.',
  'Répondre aux commentaires dans l’heure qui suit la publication relance la vidéo.',
  'Publier 1 à 3 h avant un live ramène du monde sur Twitch ; rappeler l’heure du live et twitch.tv/la-chaîne dans la description.'
]

const COACH_SYSTEM =
  'Tu es un coach qui aide un streamer Twitch francophone à faire grandir sa chaîne grâce à des clips verticaux sur TikTok, Instagram Reels et YouTube Shorts. Tu réponds en français simple, en tutoyant, avec des conseils concrets. Tu t’appuies seulement sur les repères et les données fournis : tu n’inventes ni chiffres, ni statistiques, ni fonctionnalités.'

const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    resume: { type: 'string' },
    conseils: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 6 }
  },
  required: ['resume', 'conseils'],
  additionalProperties: false
}

const listFr = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`)

/**
 * Conseils de l'IA gratuite. Les créneaux restent ceux du calcul (tirés des vrais horaires de live) :
 * l'IA les explique et donne des conseils adaptés aux jeux et au rythme du streamer.
 */
export async function localAiAdvice(opts: { channels: string[]; networks: Network[]; perDay: number }): Promise<Advice> {
  const streams = await pastStreamsOf(opts.channels)
  const audience = streams.length > 0 ? audienceMap(streams) : null
  const habits = liveHabits(streams)
  const games = topGames(streams)
  const slots = localWeeklySlots(audience)
  const nets = NETWORKS.filter((n) => opts.networks.includes(n.id))
  const slotLines = nets.map((n) => {
    const list = slots
      .filter((s) => s.network === n.id)
      .sort((a, b) => a.day - b.day || a.hour - b.hour)
      .map((s) => `${DAYS[s.day]} ${s.hour}h`)
    return `- ${n.label} : ${list.join(', ')}`
  })
  const prompt = [
    'Repères sur les algorithmes :',
    ...ALGO_FACTS.map((f) => `- ${f}`),
    '',
    'Le streamer :',
    `- Chaîne(s) Twitch : ${opts.channels.join(', ') || 'inconnue'}`,
    `- Jeux les plus joués récemment : ${games.length ? listFr(games) : 'inconnus'}`,
    `- Lives analysés : ${streams.length}${habits.length ? ` ; il est souvent en live : ${habits.slice(0, 6).map((h) => `${h.jour} de ${h.debut}h à ${h.fin}h`).join(', ')}` : ''}`,
    `- Réseaux : ${listFr(nets.map((n) => n.label))} ; au plus ${opts.perDay} publication(s) par jour et par réseau`,
    '- Meilleurs créneaux calculés pour lui (heure locale) :',
    ...slotLines,
    '',
    'Écris en JSON :',
    '- "resume" : 2 ou 3 phrases qui expliquent quand publier cette semaine et pourquoi, en citant ses jours et heures de live s’ils sont connus.',
    `- "conseils" : 4 à 6 conseils concrets et différents les uns des autres (une ou deux phrases chacun), adaptés ${games.length ? `à ${listFr(games)} et ` : ''}à son rythme. Pas de généralités vagues.`
  ].join('\n')
  const out = (await askLocalAi({ system: COACH_SYSTEM, prompt, schema: ADVICE_SCHEMA, maxTokens: 1000, temperature: 0.4 })) as { resume?: unknown; conseils?: unknown }
  const tips = (Array.isArray(out.conseils) ? out.conseils : []).map((t) => cleanAiText(t, 400)).filter((t) => t.length > 0).slice(0, 6)
  const summary = cleanAiText(out.resume, 900)
  if (!summary && tips.length === 0) throw new Error('L’IA n’a rien répondu d’utile : réessaie.')
  return { source: 'ia', createdAt: Date.now(), summary, tips, slots, sources: [], model: `IA gratuite · ${LOCAL_MODEL.label}` }
}

const CAPTION_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 8 }
  },
  required: ['description', 'hashtags'],
  additionalProperties: false
}

/** Description et hashtags écrits par l'IA gratuite. */
export async function localAiCaption(c: CaptionInput): Promise<CaptionResult> {
  const out = (await askLocalAi({
    system:
      'Tu écris la description d’un clip vidéo court (TikTok, Instagram Reels, YouTube Shorts) pour un streamer Twitch francophone. Style : court, punchy, naturel, qui donne envie de regarder jusqu’au bout, comme le streamer l’écrirait lui-même. Tu n’inventes rien qui ne soit pas dans le clip.',
    prompt: [
      `Chaîne Twitch : ${c.channel}`,
      `Jeu : ${c.game ?? 'inconnu'}`,
      `Titre du clip : ${c.title || '(aucun)'}`,
      `Ce qui est dit dans le clip : ${c.transcript ? `« ${c.transcript.slice(0, 1200)} »` : '(pas de transcription)'}`,
      '',
      'Écris en JSON :',
      // Essayé sur de vrais clips : pas d'exemple (le modèle le recopie) ni de consigne « pas de… » (il la recopie aussi).
      '- "description" : une phrase courte et accrocheuse (moins de 80 caractères) qui dit ce qui se passe dans le clip, avec le nom du jeu s’il est connu, et 1 à 3 émojis à la fin. Comme un titre de vidéo qui donne envie de cliquer, fidèle à ce qui est dit.',
      '- "hashtags" : 3 à 8 mots-clés courts, sans espace : le jeu, ce qui se passe vraiment dans le clip, gaming, twitch.'
    ].join('\n'),
    schema: CAPTION_SCHEMA,
    maxTokens: 400,
    temperature: 0.7
  })) as { description?: unknown; hashtags?: unknown }
  const r = finishCaption({ description: out.description, hashtags: out.hashtags, channel: c.channel, defaults: c.defaultHashtags })
  if (!r.caption) throw new Error('L’IA n’a rien écrit : réessaie.')
  return r
}

// ---------- Avec Claude (clé API) ----------

/** La recherche web « filtrée » existe sur Opus / Sonnet ; Haiku utilise la version de base. */
function webSearchTool(model: string): Anthropic.Beta.BetaToolUnion {
  return model.startsWith('claude-haiku')
    ? { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
    : { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
}

/** Repli automatique sur un autre modèle si celui-ci refuse (pas proposé pour Haiku). */
function fallbackParams(model: string): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: Anthropic.Beta.BetaFallbacksParam } {
  return model.startsWith('claude-haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
}

function explainError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new Error('Clé API refusée : vérifie-la (Publier > Conseiller IA).')
  if (err instanceof Anthropic.RateLimitError) return new Error('Trop de demandes envoyées à l’IA : réessaie dans une minute.')
  if (err instanceof Anthropic.APIConnectionError) return new Error('Impossible de joindre l’IA : vérifie ta connexion internet.')
  if (err instanceof Anthropic.APIError) return new Error(`L’IA a répondu par une erreur (${err.status ?? '?'}) : ${err.message}`)
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Envoie la demande et attend que Claude appelle l'outil `toolName` (avec recherche web au besoin).
 * Renvoie les arguments de l'outil et les sources web consultées.
 */
async function askForTool(opts: {
  apiKey: string
  model: string
  system: string
  prompt: string
  tool: Anthropic.Beta.BetaTool
  web: boolean
  signal?: AbortSignal
}): Promise<{ input: Record<string, unknown>; sources: { title: string; url: string }[]; model: string }> {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 5 * 60_000 })
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: opts.prompt }]
  const sources = new Map<string, string>()
  const tools: Anthropic.Beta.BetaToolUnion[] = opts.web ? [webSearchTool(opts.model), opts.tool] : [opts.tool]
  for (let round = 0; round < 6; round++) {
    let res: Anthropic.Beta.BetaMessage
    try {
      res = await client.beta.messages.create(
        {
          model: opts.model,
          max_tokens: 16000,
          system: opts.system,
          output_config: { effort: 'medium' },
          tools,
          messages,
          ...fallbackParams(opts.model)
        },
        { signal: opts.signal }
      )
    } catch (err) {
      throw explainError(err)
    }
    for (const block of res.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === 'web_search_result' && !sources.has(r.url)) sources.set(r.url, r.title)
      }
    }
    if (res.stop_reason === 'refusal') throw new Error('L’IA a refusé de répondre à cette demande.')
    const call = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === opts.tool.name)
    if (call && res.stop_reason !== 'max_tokens') return { input: call.input as Record<string, unknown>, sources: [...sources].slice(0, 8).map(([url, title]) => ({ url, title })), model: res.model }
    messages.push({ role: 'assistant', content: res.content })
    // pause_turn : la recherche web n'était pas finie, on relance telle quelle.
    if (res.stop_reason === 'pause_turn') continue
    // Un appel d'outil resté sans réponse (coupé par la longueur) rendrait la relance invalide : on y répond.
    const unanswered = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    messages.push({
      role: 'user',
      content: [
        ...unanswered.map((b): Anthropic.Beta.BetaToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: b.id,
          is_error: true,
          content: 'Réponse coupée avant la fin : rappelle l’outil avec une réponse complète, plus courte si besoin.'
        })),
        { type: 'text', text: `Appelle maintenant l’outil ${opts.tool.name} avec ta réponse complète.` }
      ]
    })
  }
  throw new Error('L’IA n’a pas donné de réponse exploitable : réessaie.')
}

const SLOT_TOOL: Anthropic.Beta.BetaTool = {
  name: 'donner_conseils',
  description: 'Donne les créneaux de publication conseillés pour chaque réseau, un résumé et des conseils pratiques.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      resume: { type: 'string', description: 'Résumé en 2 ou 3 phrases, en français, de ce que tu conseilles et pourquoi.' },
      conseils: { type: 'array', items: { type: 'string' }, description: '3 à 6 conseils pratiques et concrets, en français.' },
      creneaux: {
        type: 'array',
        description: '4 à 7 créneaux par réseau, à l’heure locale du streamer.',
        items: {
          type: 'object',
          properties: {
            reseau: { type: 'string', enum: ['tiktok', 'instagram', 'youtube'] },
            jour: { type: 'integer', description: '0 = lundi, 1 = mardi … 6 = dimanche' },
            heure: { type: 'integer', description: '0 à 23' },
            minute: { type: 'integer', description: '0 à 59' },
            note: { type: 'number', description: 'Qualité du créneau, de 0 à 1' },
            pourquoi: { type: 'string', description: 'Raison courte en français' }
          },
          required: ['reseau', 'jour', 'heure', 'minute', 'note', 'pourquoi'],
          additionalProperties: false
        }
      }
    },
    required: ['resume', 'conseils', 'creneaux'],
    additionalProperties: false
  }
}

const clampInt = (v: unknown, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(Number(v) || 0)))

/** Conseils de l'IA (avec recherche web), à partir des lives passés des chaînes. */
export async function aiAdvice(opts: { apiKey: string; model: string; channels: string[]; networks: Network[]; perDay: number; signal?: AbortSignal }): Promise<Advice> {
  const streams = await pastStreamsOf(opts.channels)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const context = {
    aujourdhui: new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    fuseau_horaire: tz,
    langue_du_public: 'français',
    chaines_twitch: opts.channels,
    jeux_recents: topGames(streams),
    lives_habituels: liveHabits(streams),
    nombre_de_lives_analyses: streams.length,
    reseaux: opts.networks,
    publications_max_par_jour_et_par_reseau: opts.perDay
  }
  const { input, sources, model } = await askForTool({
    apiKey: opts.apiKey,
    model: opts.model,
    web: true,
    signal: opts.signal,
    system:
      'Tu es un expert de la croissance des créateurs gaming sur TikTok, Instagram Reels et YouTube Shorts. Tu aides un streamer Twitch francophone à choisir quand publier ses clips verticaux. Tu t’appuies sur des sources récentes et tu restes prudent : pas de chiffres inventés.',
    prompt: [
      'Voici le contexte du streamer (JSON) :',
      JSON.stringify(context, null, 2),
      '',
      '1. Fais quelques recherches web pour savoir ce qui est recommandé cette année : meilleurs jours et heures pour publier du contenu gaming court sur chacun de ces réseaux, pour un public francophone, et ce que leurs algorithmes favorisent en ce moment.',
      '2. Croise avec ses horaires de live : une publication 1 à 3 h avant un live peut y ramener du monde ; garde au moins 3 h entre deux publications sur le même réseau.',
      '3. Appelle l’outil donner_conseils : 4 à 7 créneaux par réseau demandé (heure locale), un résumé et 3 à 6 conseils concrets. Tout en français.'
    ].join('\n'),
    tool: SLOT_TOOL
  })
  const slots: WeeklySlot[] = (Array.isArray(input.creneaux) ? input.creneaux : [])
    .map((c: Record<string, unknown>) => ({
      network: c.reseau as Network,
      day: clampInt(c.jour, 0, 6),
      hour: clampInt(c.heure, 0, 23),
      minute: clampInt(c.minute, 0, 59),
      score: Math.min(1, Math.max(0, Number(c.note) || 0.5)),
      why: String(c.pourquoi ?? '').slice(0, 200)
    }))
    .filter((s) => NETWORKS.some((n) => n.id === s.network))
  if (slots.length === 0) throw new Error('L’IA n’a proposé aucun créneau : réessaie.')
  return {
    source: 'ia',
    createdAt: Date.now(),
    summary: String(input.resume ?? '').slice(0, 1200),
    tips: (Array.isArray(input.conseils) ? input.conseils : []).map((t) => String(t).slice(0, 400)).slice(0, 8),
    slots,
    sources,
    model
  }
}

const CAPTION_TOOL: Anthropic.Beta.BetaTool = {
  name: 'ecrire_publication',
  description: 'Écrit la description et les hashtags de la publication du clip.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Description accrocheuse en français (1 à 3 lignes, emojis bienvenus), la première ligne sert de titre YouTube (moins de 90 caractères).' },
      hashtags: { type: 'array', items: { type: 'string' }, description: '5 à 10 hashtags pertinents (jeu, gaming, twitch, tendances), sans espace.' }
    },
    required: ['description', 'hashtags'],
    additionalProperties: false
  }
}

/** Description et hashtags écrits par l'IA, à partir du titre et de ce qui est dit dans le clip. */
export async function aiCaption(opts: { apiKey: string; model: string; clip: CaptionInput; signal?: AbortSignal }): Promise<CaptionResult> {
  const c = opts.clip
  const { input } = await askForTool({
    apiKey: opts.apiKey,
    model: opts.model,
    web: false,
    signal: opts.signal,
    system: 'Tu écris des descriptions de clips gaming pour TikTok, Instagram Reels et YouTube Shorts, en français, dans le ton d’un streamer Twitch : court, punchy, qui donne envie de regarder jusqu’au bout. Pas de promesses mensongères.',
    prompt: [
      `Chaîne Twitch : ${c.channel}`,
      `Jeu : ${c.game ?? 'inconnu'}`,
      `Titre du clip : ${c.title || '(aucun)'}`,
      `Ce qui est dit dans le clip : ${c.transcript ? `« ${c.transcript.slice(0, 1500)} »` : '(pas de transcription)'}`,
      `Hashtags que le streamer met toujours : ${c.defaultHashtags || '(aucun)'}`,
      '',
      'Appelle l’outil ecrire_publication avec la description et les hashtags.'
    ].join('\n'),
    tool: CAPTION_TOOL
  })
  const tags = (Array.isArray(input.hashtags) ? input.hashtags : []).map(String).join(' ')
  return { caption: String(input.description ?? '').trim().slice(0, 2000), hashtags: normalizeHashtags(`${tags} ${c.defaultHashtags}`) }
}

// ---------- Pour l'interface ----------

let localCache: { key: string; at: number; advice: Advice } | null = null

function apiKey(): string {
  const key = getSecret('anthropic')
  if (!key) throw new Error('Ajoute d’abord ta clé API Anthropic (Publier > Conseils > Option payante : Claude), ou choisis l’IA gratuite.')
  return key
}

/**
 * Conseil de publication.
 * auto  : le dernier conseil de l'IA s'il a moins d'une semaine, sinon le calcul sans IA ;
 * local : calcul sans IA (et on oublie le conseil de l'IA) ;
 * ai    : nouveau conseil de l'IA choisie (gratuite sur le PC, ou Claude avec recherches web).
 */
export async function adviceFor(channels: string[], mode: 'auto' | 'local' | 'ai'): Promise<Advice> {
  const prefs = getPrefs()
  if (mode === 'ai') {
    const networks = prefs.networks.length ? prefs.networks : NETWORKS.map((n) => n.id)
    const advice =
      prefs.aiEngine === 'claude'
        ? await aiAdvice({ apiKey: apiKey(), model: prefs.aiModel, channels, networks, perDay: prefs.perDay })
        : await localAiAdvice({ channels, networks, perDay: prefs.perDay })
    setStoredAdvice(advice)
    return advice
  }
  if (mode === 'local') setStoredAdvice(null)
  const stored = getStoredAdvice()
  if (mode === 'auto' && stored && Date.now() - stored.createdAt < 7 * 86400_000) return stored
  const key = [...channels].sort().join(',')
  if (mode === 'auto' && localCache && localCache.key === key && Date.now() - localCache.at < 3600_000) return localCache.advice
  const advice = await localAdvice(channels)
  localCache = { key, at: Date.now(), advice }
  return advice
}

/** Description et hashtags pour la publication d'un clip (avec ou sans IA). */
export async function captionFor(clip: Clip, ai: boolean): Promise<CaptionResult> {
  const input: CaptionInput = {
    title: clip.title,
    channel: clip.channel,
    game: await gameAt(clip.channel, clip.momentAt),
    transcript: (clip.words ?? [])
      .filter((w) => w.end > clip.start && w.start < clip.end)
      .map((w) => w.text)
      .join(' '),
    defaultHashtags: getPrefs().hashtags
  }
  if (!ai) return localCaption(input)
  return getPrefs().aiEngine === 'claude' ? aiCaption({ apiKey: apiKey(), model: getPrefs().aiModel, clip: input }) : localAiCaption(input)
}
