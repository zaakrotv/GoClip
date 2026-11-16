// Agenda de publication : on glisse un clip terminé sur un jour et une heure, on choisit les
// réseaux, la description et les hashtags. À l'heure prévue, AutoClip prévient et prépare tout
// (vidéo à glisser dans la page d'envoi, texte copié). Les étoiles montrent les créneaux conseillés.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  AI_MODELS,
  bestSlot,
  DAYS,
  formatCaption,
  networkInfo,
  NETWORKS,
  normalizeHashtags,
  sameLocalDay,
  upcomingSlots,
  weekday,
  type Advice,
  type AiStatus,
  type Network,
  type Post,
  type PublishPrefs,
  type SuggestedSlot
} from '../../../shared/publishing'
import type { Clip } from '../../../shared/types'
import { api, errorText, mediaUrl } from '../api'
import { Empty, Pill, Section, Select, Slider } from '../components/ui'
import { useAppState, useClips } from '../hooks'

const ENGINES: { value: 'local' | 'claude'; label: string }[] = [
  { value: 'local', label: 'IA gratuite, sur ce PC' },
  { value: 'claude', label: 'Claude (clé API, payant)' }
]

/** Ce que fait l'IA pendant qu'on l'attend (avec la progression du téléchargement la première fois). */
function AiWorking({ ai, what }: { ai: AiStatus | null; what: 'write' | 'advice' }) {
  const state = useAppState()
  const dl = state?.deps.download
  if (dl && dl.name.startsWith('IA gratuite')) return <>{`Téléchargement de l’IA${dl.total > 0 ? ` : ${Math.round((dl.done / dl.total) * 100)} %` : '…'}`}</>
  if (ai?.engine === 'claude') return <>{what === 'write' ? 'L’IA écrit…' : 'L’IA cherche… (1 à 2 min)'}</>
  return <>{what === 'write' ? 'L’IA écrit…' : 'L’IA réfléchit…'}</>
}

function aiHint(ai: AiStatus | null, what: 'write' | 'advice'): string {
  if (ai?.engine === 'claude')
    return what === 'write' ? 'Claude écrit la description et les hashtags (ta clé API)' : 'Claude cherche sur le web ce que les algorithmes favorisent en ce moment et croise avec tes horaires de live'
  const first = ai && !ai.local.installed ? ` La première fois, elle se télécharge toute seule (${ai.local.size}, une seule fois).` : ''
  return `${what === 'write' ? 'L’IA gratuite écrit la description et les hashtags à partir de ce qui est dit dans le clip.' : 'L’IA gratuite lit tes horaires de live, tes jeux et les meilleurs créneaux, et te donne des conseils adaptés.'} Elle tourne sur ton PC, sans clé.${first}`
}

const FIRST_HOUR = 6
const HOURS = Array.from({ length: 24 - FIRST_HOUR }, (_, i) => FIRST_HOUR + i)
const DRAG_TYPE = 'application/x-autoclip'

type DragData = { kind: 'clip'; id: string } | { kind: 'post'; id: string }

export function usePosts(): Post[] {
  const [posts, setPosts] = useState<Post[]>([])
  useEffect(() => {
    const load = (): void => void api().listPosts().then(setPosts)
    load()
    return api().onPosts(load)
  }, [])
  return posts
}

const pad = (n: number): string => String(n).padStart(2, '0')
const toInput = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromInput = (s: string): number | null => {
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}
const fmtTime = (t: number): string => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const fmtDate = (t: number): string => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })

function startOfWeek(t: number): Date {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - weekday(d))
  return d
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() + n)
  return x
}

function at(day: Date, hour: number, minute: number): number {
  const d = new Date(day.getTime())
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

const clipFile = (c: Clip | undefined): string | null => (c ? (c.final ?? c.output) : null)
const clipName = (c: Clip | undefined): string => (c ? c.title || (c.chatWord ? 'Le tchat voulait ce clip' : 'Moment fort du live') : 'Clip supprimé')

function readDrag(e: DragEvent): DragData | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    return raw ? (JSON.parse(raw) as DragData) : null
  } catch {
    return null
  }
}

function setDrag(e: DragEvent, data: DragData): void {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(data))
  e.dataTransfer.effectAllowed = 'move'
}

function postState(p: Post): 'published' | 'due' | 'scheduled' {
  const active = p.targets.filter((t) => t.state !== 'skipped')
  if (active.length > 0 && active.every((t) => t.state === 'published')) return 'published'
  if (active.some((t) => t.state === 'due')) return 'due'
  return 'scheduled'
}

function PostChip(props: { post: Post; clip: Clip | undefined; onOpen: () => void; compact?: boolean }) {
  const { post, clip } = props
  return (
    <div
      className={`post-chip ${postState(post)}`}
      draggable
      onDragStart={(e) => setDrag(e, { kind: 'post', id: post.id })}
      onClick={(e) => {
        e.stopPropagation()
        props.onOpen()
      }}
      title={`${fmtTime(post.at)} · ${clipName(clip)}`}
    >
      {!props.compact && clip?.thumbnail && <img src={mediaUrl(clip.thumbnail)} alt="" />}
      <span className="post-chip-text">
        <b>{fmtTime(post.at)}</b> <span className="post-chip-name">{clipName(clip)}</span>
      </span>
      <span className="post-chip-nets">
        {post.targets.map((t) => (
          <i key={t.network} className={`net-dot ${t.state}`} style={{ background: networkInfo(t.network).color }} title={`${networkInfo(t.network).label} : ${t.state === 'published' ? 'publié' : t.state === 'due' ? 'à publier' : t.state === 'skipped' ? 'pas publié' : 'programmé'}`} />
        ))}
      </span>
    </div>
  )
}

function SlotStar({ slots }: { slots: SuggestedSlot[] }) {
  if (slots.length === 0) return null
  const tip = slots.map((s) => `⭐ ${networkInfo(s.network).label} : ${s.why}`).join('\n')
  return (
    <span className="slot-star" title={`Bon créneau\n${tip}`}>
      ⭐
      {slots.map((s) => (
        <i key={s.network} style={{ background: networkInfo(s.network).color }} />
      ))}
    </span>
  )
}

/** Panneau d'une publication : quand, où, quel texte, et l'aide pour publier. */
function PostPanel(props: { post: Post; clip: Clip | undefined; prefs: PublishPrefs; advice: Advice | null; posts: Post[]; ai: AiStatus | null; onAiUsed: () => void; onClose: () => void }) {
  const { post, clip, prefs } = props
  const [draft, setDraft] = useState({ at: post.at, caption: post.caption, hashtags: post.hashtags, networks: post.targets.map((t) => t.network) })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [links, setLinks] = useState<Partial<Record<Network, string>>>({})
  const [copied, setCopied] = useState<Network | null>(null)
  const timer = useRef<number | null>(null)
  const latest = useRef(draft)
  latest.current = draft

  // Une autre publication ouverte : on repart de ses valeurs.
  useEffect(() => {
    setDraft({ at: post.at, caption: post.caption, hashtags: post.hashtags, networks: post.targets.map((t) => t.network) })
    setError(null)
  }, [post.id])

  const save = (): void => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    const d = latest.current
    if (d.networks.length === 0) return setError('Choisis au moins un réseau.')
    setError(null)
    void api()
      .savePost({ id: post.id, clipId: post.clipId, at: d.at, caption: d.caption, hashtags: d.hashtags, networks: d.networks })
      .catch((e) => setError(errorText(e)))
  }
  const change = (patch: Partial<typeof draft>, now = false): void => {
    setDraft((d) => ({ ...d, ...patch }))
    latest.current = { ...latest.current, ...patch }
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(save, now ? 0 : 600)
  }
  useEffect(() => () => {
    if (timer.current) save()
  }, [])

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const others = props.posts.filter((p) => p.id !== post.id).map((p) => ({ at: p.at, networks: p.targets.map((t) => t.network) }))
  const best = props.advice ? bestSlot({ weekly: props.advice.slots, from: Date.now(), posts: others, perDay: prefs.perDay, networks: draft.networks }) : null
  const file = clipFile(clip)
  const target = (n: Network) => post.targets.find((t) => t.network === n)

  return (
    <aside className="post-panel">
      <header>
        <b>Publication</b>
        <button className="btn ghost icon" onClick={props.onClose} title="Fermer">
          ✕
        </button>
      </header>
      <div className="post-panel-scroll">
        <div className="post-clip">
          {file ? <video src={mediaUrl(file)} controls preload="metadata" /> : <div className="thumb-empty">🎬</div>}
          <div className="stack">
            <b>{clipName(clip)}</b>
            <span className="muted small">{clip ? `${clip.channel} · ${new Date(clip.momentAt).toLocaleDateString('fr-FR')}` : 'Ce clip n’existe plus.'}</span>
            {clip && (
              <button className="btn small" onClick={() => (window.location.hash = `#/clip/${clip.id}`)}>
                ✂ Ouvrir le montage
              </button>
            )}
          </div>
        </div>

        <Section title="Quand">
          <input type="datetime-local" value={toInput(draft.at)} onChange={(e) => {
            const t = fromInput(e.target.value)
            if (t) change({ at: t })
          }} />
          {best && (
            <button className="btn small best-slot" onClick={() => change({ at: best.at }, true)} title={best.why}>
              ⭐ Meilleur créneau : {fmtDate(best.at)} à {fmtTime(best.at)} ({networkInfo(best.network).label})
            </button>
          )}
          {draft.at < Date.now() && postState(post) !== 'published' && <p className="muted small">L’heure est passée : publie-le dès que tu peux (aide juste en dessous).</p>}
        </Section>

        <Section title="Sur quels réseaux">
          <div className="net-toggles">
            {NETWORKS.map((n) => {
              const on = draft.networks.includes(n.id)
              return (
                <button
                  key={n.id}
                  className={`net-toggle ${on ? 'on' : ''}`}
                  style={on ? { borderColor: n.color } : undefined}
                  onClick={() => change({ networks: on ? draft.networks.filter((x) => x !== n.id) : [...draft.networks, n.id] }, true)}
                >
                  {n.icon} {n.label}
                </button>
              )
            })}
          </div>
        </Section>

        <Section
          title="Texte"
          right={
            <div className="row">
              <button className="btn small ghost" disabled={!!busy || !clip} onClick={() => void run('auto', async () => {
                const s = await api().suggestCaption(post.clipId, false)
                change({ caption: s.caption, hashtags: s.hashtags }, true)
              })}>
                Remplir tout seul
              </button>
              <button className="btn small" disabled={!!busy || !clip} title={aiHint(props.ai, 'write')} onClick={() => void run('ia', async () => {
                try {
                  const s = await api().suggestCaption(post.clipId, true)
                  change({ caption: s.caption, hashtags: s.hashtags }, true)
                } finally {
                  props.onAiUsed()
                }
              })}>
                {busy === 'ia' ? <AiWorking ai={props.ai} what="write" /> : '✨ Écrire avec l’IA'}
              </button>
            </div>
          }
        >
          <textarea rows={4} value={draft.caption} onChange={(e) => change({ caption: e.target.value })} placeholder="Description (la première ligne sert de titre sur YouTube)" />
          <input value={draft.hashtags} onChange={(e) => change({ hashtags: e.target.value })} onBlur={() => change({ hashtags: normalizeHashtags(latest.current.hashtags) }, true)} placeholder="#twitch #gaming" />
          <span className="muted small">{draft.caption.length + draft.hashtags.length} caractères (Instagram : 2 200 au plus)</span>
        </Section>

        <Section title="Publier">
          <p className="muted small">
            TikTok, Instagram et YouTube réservent la publication automatique aux applications qu’ils ont auditées. À l’heure prévue, GoClip te prévient : glisse la vidéo dans la page qui s’ouvre, colle le texte (Ctrl+V) et publie.
          </p>
          {draft.networks.map((n) => {
            const info = networkInfo(n)
            const t = target(n)
            const text = formatCaption(n, draft.caption, draft.hashtags)
            return (
              <div key={n} className={`publish-row ${t?.state ?? 'scheduled'}`}>
                <div className="publish-row-head">
                  <b>
                    {info.icon} {info.label}
                  </b>
                  {t?.state === 'published' ? <Pill tone="ok">✓ Publié</Pill> : t?.state === 'due' ? <Pill tone="warn">À publier</Pill> : t?.state === 'skipped' ? <Pill>Pas publié</Pill> : <Pill>Programmé</Pill>}
                </div>
                <div className="row wrap">
                  {file && (
                    <span
                      className="btn small drag-video"
                      draggable
                      onDragStart={(e) => {
                        e.preventDefault()
                        api().startDrag(file)
                      }}
                      title="Glisse ce bouton dans la page d’envoi du réseau (ou dans un dossier)"
                    >
                      🎬 Glisser la vidéo
                    </span>
                  )}
                  <button className="btn small" onClick={() => void run('copie', async () => {
                    await api().copyText(text.title ? `${text.title}\n\n${text.text}` : text.text)
                    setCopied(n)
                    window.setTimeout(() => setCopied(null), 2500)
                  })}>
                    {copied === n ? '✓ Copié' : '📋 Copier le texte'}
                  </button>
                  <button className="btn small" onClick={() => void api().openUrl(info.upload)}>
                    🌐 Ouvrir {info.label}
                  </button>
                  {file && (
                    <button className="btn small ghost" onClick={() => void api().showInFolder(file)} title="Montrer la vidéo dans son dossier">
                      📂
                    </button>
                  )}
                </div>
                {text.title && <span className="muted small">Titre YouTube : {text.title}</span>}
                {t && t.state !== 'published' ? (
                  <div className="row">
                    <input value={links[n] ?? ''} onChange={(e) => setLinks({ ...links, [n]: e.target.value })} placeholder="Lien de la publication (facultatif)" />
                    <button className="btn small primary" onClick={() => void run('fait', () => api().setPostTarget(post.id, n, 'published', links[n] ?? null))}>
                      ✓ C’est publié
                    </button>
                  </div>
                ) : t?.state === 'published' ? (
                  <div className="row">
                    {t.url ? (
                      <a href={t.url} target="_blank" rel="noreferrer">
                        Voir la publication
                      </a>
                    ) : (
                      <span className="muted small">Publié {t.doneAt ? `le ${new Date(t.doneAt).toLocaleDateString('fr-FR')}` : ''}</span>
                    )}
                    <button className="btn small ghost" onClick={() => void run('annule', () => api().setPostTarget(post.id, n, 'due', null))}>
                      Annuler
                    </button>
                  </div>
                ) : (
                  <span className="muted small">Enregistrement…</span>
                )}
              </div>
            )
          })}
        </Section>
        {error && <p className="error">{error}</p>}
        <button
          className="btn ghost danger"
          onClick={() => {
            if (confirm('Retirer cette publication de l’agenda ? (Le clip n’est pas supprimé.)')) void api().deletePost(post.id).then(props.onClose)
          }}
        >
          🗑 Retirer de l’agenda
        </button>
      </div>
    </aside>
  )
}

/** Conseils : créneaux de la semaine, astuces, réglages et conseiller IA. */
function AdvicePanel(props: { advice: Advice | null; loading: string | null; prefs: PublishPrefs; ai: AiStatus | null; onRefresh: (mode: 'local' | 'ai') => void; onPrefs: (p: Partial<PublishPrefs>) => void; onAi: (s: AiStatus) => void; onClose: () => void; error: string | null }) {
  const { advice, prefs } = props
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [localBusy, setLocalBusy] = useState<'prepare' | 'remove' | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const localAction = (what: 'prepare' | 'remove'): void => {
    setLocalBusy(what)
    setLocalError(null)
    void (what === 'prepare' ? api().prepareLocalAi() : api().removeLocalAi())
      .then(props.onAi)
      .catch((e) => {
        setLocalError(errorText(e))
        void api().aiStatus().then(props.onAi)
      })
      .finally(() => setLocalBusy(null))
  }
  const byNetwork = (n: Network) => (advice?.slots ?? []).filter((s) => s.network === n).sort((a, b) => a.day - b.day || a.hour - b.hour)
  return (
    <aside className="post-panel advice-panel">
      <header>
        <b>Conseils de publication</b>
        <button className="btn ghost icon" onClick={props.onClose} title="Fermer">
          ✕
        </button>
      </header>
      <div className="post-panel-scroll">
        {advice ? (
          <>
            <div className="row wrap">
              {advice.source === 'ia' ? (
                <Pill tone="accent">{advice.model?.startsWith('IA gratuite') ? `✨ ${advice.model}` : `✨ Conseiller IA${advice.model ? ` (${advice.model})` : ''}`}</Pill>
              ) : (
                <Pill>Calcul sans IA</Pill>
              )}
              <span className="muted small">Mis à jour le {new Date(advice.createdAt).toLocaleDateString('fr-FR')}</span>
            </div>
            <p>{advice.summary}</p>
            {advice.tips.length > 0 && (
              <ul className="tips">
                {advice.tips.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
            {NETWORKS.filter((n) => byNetwork(n.id).length > 0).map((n) => (
              <Section key={n.id} title={`${n.icon} ${n.label}`}>
                <div className="slot-list">
                  {byNetwork(n.id).map((s, i) => (
                    <div key={i} className="slot-item" title={s.why}>
                      <b>
                        {DAYS[s.day]} {s.hour}h{s.minute ? pad(s.minute) : ''}
                      </b>
                      <span className="muted small">{s.why}</span>
                    </div>
                  ))}
                </div>
              </Section>
            ))}
            {advice.sources.length > 0 && (
              <Section title="Sources consultées par l’IA">
                {advice.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="small">
                    {s.title || s.url}
                  </a>
                ))}
              </Section>
            )}
          </>
        ) : (
          <p className="muted">{props.loading ? 'Calcul des créneaux…' : 'Pas encore de conseil.'}</p>
        )}
        {props.error && <p className="error">{props.error}</p>}
        <div className="row wrap">
          <button className="btn small" disabled={!!props.loading} onClick={() => props.onRefresh('local')}>
            {props.loading === 'local' ? 'Calcul…' : '↻ Recalculer sans IA'}
          </button>
          <button
            className="btn small primary"
            disabled={!!props.loading || (props.ai?.engine === 'claude' && !props.ai.hasKey)}
            onClick={() => props.onRefresh('ai')}
            title={props.ai?.engine === 'claude' && !props.ai.hasKey ? 'Ajoute d’abord ta clé API (Option payante, plus bas), ou choisis l’IA gratuite' : aiHint(props.ai, 'advice')}
          >
            {props.loading === 'ai' ? <AiWorking ai={props.ai} what="advice" /> : '✨ Demander à l’IA'}
          </button>
        </div>

        <Section title="Mes habitudes">
          <div className="net-toggles">
            {NETWORKS.map((n) => {
              const on = prefs.networks.includes(n.id)
              return (
                <button key={n.id} className={`net-toggle ${on ? 'on' : ''}`} style={on ? { borderColor: n.color } : undefined} onClick={() => props.onPrefs({ networks: on ? prefs.networks.filter((x) => x !== n.id) : [...prefs.networks, n.id] })}>
                  {n.icon} {n.label}
                </button>
              )
            })}
          </div>
          <Slider label="Publications au plus par jour et par réseau" value={prefs.perDay} min={1} max={6} onChange={(perDay) => props.onPrefs({ perDay })} />
          <label className="field">
            <span className="field-label">Hashtags ajoutés à chaque publication</span>
            <input defaultValue={prefs.hashtags} onBlur={(e) => props.onPrefs({ hashtags: normalizeHashtags(e.target.value) })} placeholder="#twitch #gaming" />
          </label>
        </Section>

        <Section title="✨ IA gratuite">
          <p className="muted small">
            Pas de clé, pas d’abonnement, rien à payer : elle tourne sur ton PC (sur la carte graphique si tu en as une) et rien n’est envoyé sur internet. Elle se télécharge toute seule au premier clic sur un bouton ✨ ({props.ai?.local.size ?? '2 Go'}, une seule fois). Comme elle ne va pas sur internet, ses conseils s’appuient sur tes lives, tes jeux et des repères connus sur les algorithmes de TikTok, Instagram et YouTube.
          </p>
          <div className="row wrap">
            {props.ai?.local.installed ? (
              <Pill tone="ok" title={props.ai.local.label}>
                ✓ Prête{props.ai.local.device ? ` · ${props.ai.local.device}` : ''}
              </Pill>
            ) : props.ai?.local.installing || localBusy === 'prepare' ? (
              <Pill tone="warn">Téléchargement…</Pill>
            ) : (
              <Pill>Pas encore téléchargée</Pill>
            )}
            {props.ai && !props.ai.local.installed && !props.ai.local.installing && (
              <button className="btn small" disabled={!!localBusy} onClick={() => localAction('prepare')}>
                Télécharger maintenant
              </button>
            )}
            {props.ai?.local.installed && (
              <button
                className="btn small ghost danger"
                disabled={!!localBusy || !!props.loading}
                onClick={() => {
                  if (confirm(`Supprimer l’IA gratuite de ce PC ? (Libère ${props.ai?.local.size}. Elle se retéléchargera au prochain clic sur un bouton ✨.)`)) localAction('remove')
                }}
              >
                Supprimer ({props.ai.local.size})
              </button>
            )}
          </div>
          {(localError ?? props.ai?.local.error) && <p className="error small">{localError ?? props.ai?.local.error}</p>}
          {props.ai?.engine === 'claude' && <p className="muted small">Les boutons ✨ utilisent Claude en ce moment (option payante juste en dessous).</p>}
        </Section>

        <details className="ai-paid">
          <summary>Option payante : Claude (avec recherches sur le web)</summary>
          <Select label="IA des boutons ✨" value={prefs.aiEngine} options={ENGINES} onChange={(aiEngine) => props.onPrefs({ aiEngine })} />
          <p className="muted small">
            Avec une clé API Anthropic (console.anthropic.com, payée à l’usage), Claude fait des recherches sur le web pour savoir ce que TikTok, Instagram et YouTube mettent en avant en ce moment, croise avec tes horaires de live et propose tes créneaux (gardés une semaine). Il peut aussi écrire les descriptions et hashtags. Coût indicatif d’une demande de conseils : environ 0,05 $ avec Haiku, 0,15 $ avec Sonnet, 0,30 $ avec Opus ; une description coûte bien moins. La clé reste chiffrée sur ce PC.
          </p>
          {props.ai?.hasKey ? (
            <div className="row">
              <Pill tone="ok">✓ Clé enregistrée</Pill>
              <button className="btn small ghost danger" onClick={() => void api().setAiKey(null).then(props.onAi)}>
                Supprimer la clé
              </button>
            </div>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                setKeyError(null)
                void api()
                  .setAiKey(key)
                  .then((s) => {
                    setKey('')
                    props.onAi(s)
                  })
                  .catch((err) => setKeyError(errorText(err)))
              }}
            >
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Clé API (sk-ant-…)" autoComplete="off" />
              <button className="btn small primary" disabled={!key.trim()}>
                Enregistrer
              </button>
            </form>
          )}
          {keyError && <p className="error small">{keyError}</p>}
          <Select label="Modèle" value={prefs.aiModel} options={AI_MODELS} onChange={(aiModel) => props.onPrefs({ aiModel })} />
        </details>
      </div>
    </aside>
  )
}

export function PublishPage({ openId }: { openId?: string }) {
  const [clips] = useClips()
  const posts = usePosts()
  const [prefs, setPrefs] = useState<PublishPrefs | null>(null)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [adviceLoading, setAdviceLoading] = useState<string | null>(null)
  const [adviceError, setAdviceError] = useState<string | null>(null)
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [view, setView] = useState<'week' | 'month'>('week')
  const [anchor, setAnchor] = useState(() => startOfWeek(Date.now()))
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const toSchedule = openId?.startsWith('programmer-') ? openId.slice('programmer-'.length) : null
  const [open, setOpen] = useState<string | null>(toSchedule ? null : (openId ?? null))
  const [showAdvice, setShowAdvice] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const handled = useRef<string | null>(null)

  useEffect(() => {
    void api().getPublishPrefs().then(setPrefs)
    void api().aiStatus().then(setAi)
  }, [])
  useEffect(() => {
    if (openId && !toSchedule) setOpen(openId)
  }, [openId])

  const refreshAi = (): void => void api().aiStatus().then(setAi)
  const loadAdvice = (mode: 'auto' | 'local' | 'ai'): void => {
    setAdviceLoading(mode === 'ai' ? 'ai' : 'local')
    setAdviceError(null)
    void api()
      .getAdvice(mode)
      .then(setAdvice)
      .catch((e) => setAdviceError(errorText(e)))
      .finally(() => {
        setAdviceLoading(null)
        if (mode === 'ai') refreshAi()
      })
  }
  useEffect(() => loadAdvice('auto'), [])

  const byId = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips])
  const ready = useMemo(
    () => clips.filter((c) => c.status === 'done' && clipFile(c) && !posts.some((p) => p.clipId === c.id)).sort((a, b) => b.momentAt - a.momentAt),
    [clips, posts]
  )
  const due = posts.filter((p) => postState(p) === 'due')
  const upcoming = posts.filter((p) => p.at >= Date.now() && postState(p) !== 'published').sort((a, b) => a.at - b.at)
  const slots = useMemo(
    () =>
      advice && prefs
        ? upcomingSlots({ weekly: advice.slots, from: Date.now(), days: 42, posts: posts.map((p) => ({ at: p.at, networks: p.targets.map((t) => t.network) })), perDay: prefs.perDay }).filter(
            (s) => prefs.networks.length === 0 || prefs.networks.includes(s.network)
          )
        : [],
    [advice, prefs, posts]
  )
  const openPost = posts.find((p) => p.id === open) ?? null

  const create = async (clipId: string, when: number): Promise<void> => {
    if (!prefs) return
    setError(null)
    try {
      const s = await api().suggestCaption(clipId, false)
      const post = await api().savePost({ clipId, at: when, caption: s.caption, hashtags: s.hashtags, networks: prefs.networks.length ? prefs.networks : NETWORKS.map((n) => n.id) })
      setOpen(post.id)
      setShowAdvice(false)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const move = async (postId: string, when: number): Promise<void> => {
    const p = posts.find((x) => x.id === postId)
    if (!p) return
    try {
      await api().savePost({ id: p.id, clipId: p.clipId, at: when, caption: p.caption, hashtags: p.hashtags, networks: p.targets.map((t) => t.network) })
    } catch (e) {
      setError(errorText(e))
    }
  }
  const drop = (e: DragEvent, when: number | ((data: DragData) => number)): void => {
    e.preventDefault()
    setHover(null)
    const data = readDrag(e)
    if (!data) return
    const t = typeof when === 'function' ? when(data) : when
    if (data.kind === 'clip') void create(data.id, t)
    else void move(data.id, t)
  }
  /** Programme un clip au meilleur créneau libre (bouton « Programmer »). */
  const scheduleBest = (clipId: string, list: Post[] = posts): void => {
    if (!prefs) return
    const best = advice ? bestSlot({ weekly: advice.slots, from: Date.now(), posts: list.map((p) => ({ at: p.at, networks: p.targets.map((t) => t.network) })), perDay: prefs.perDay, networks: prefs.networks }) : null
    const fallback = new Date()
    fallback.setHours(fallback.getHours() + 2, 0, 0, 0)
    void create(clipId, best?.at ?? fallback.getTime())
  }

  // Arrivée depuis le bouton 📅 d'un clip (page Clips) : programmé au meilleur créneau libre.
  useEffect(() => {
    if (!toSchedule || !prefs || adviceLoading || handled.current === toSchedule) return
    handled.current = toSchedule
    window.location.hash = '#/publier'
    // Liste relue ici : celle de la page n'est peut-être pas encore chargée (pas de doublon).
    void api()
      .listPosts()
      .then((list) => {
        const existing = list.find((p) => p.clipId === toSchedule)
        if (existing) setOpen(existing.id)
        else scheduleBest(toSchedule, list)
      })
  }, [toSchedule, prefs, adviceLoading])

  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i))
  const monthStart = useMemo(() => startOfWeek(month.getTime()), [month])

  // La semaine s'ouvre sur les heures utiles : ses publications et ses ⭐ à venir, sinon l'heure actuelle.
  const calendarRef = useRef<HTMLElement>(null)
  const scrolledFor = useRef<number | null>(null)
  useEffect(() => {
    const cal = calendarRef.current
    if (view !== 'week') {
      scrolledFor.current = null
      return
    }
    if (!cal || (!advice && !adviceError) || scrolledFor.current === anchor.getTime()) return
    scrolledFor.current = anchor.getTime()
    const start = anchor.getTime()
    const end = start + 7 * 86_400_000
    const from = Math.max(start, Date.now() - 3600_000)
    const hours = [...posts.map((p) => p.at), ...slots.map((s) => s.at)].filter((t) => t >= from && t < end).map((t) => new Date(t).getHours())
    const hour = Math.max(FIRST_HOUR, Math.min(17, (hours.length > 0 ? Math.min(...hours) : new Date().getHours()) - 1))
    const row = cal.querySelectorAll<HTMLElement>('.week-row')[hour - FIRST_HOUR]
    const head = cal.querySelector<HTMLElement>('.week-head')
    if (row) cal.scrollTop += row.getBoundingClientRect().top - cal.getBoundingClientRect().top - (head?.offsetHeight ?? 0) - 6
  }, [view, anchor, advice, adviceError, posts, slots])
  const shift = (dir: number): void => {
    if (view === 'week') setAnchor(addDays(anchor, 7 * dir))
    else setMonth(new Date(month.getFullYear(), month.getMonth() + dir, 1))
  }
  const switchView = (v: 'week' | 'month'): void => {
    // Le mois affiché suit la semaine affichée (et inversement).
    if (v === 'month') {
      const mid = addDays(anchor, 3)
      setMonth(new Date(mid.getFullYear(), mid.getMonth(), 1))
    } else if (view === 'month') {
      const now = new Date()
      setAnchor(startOfWeek(now.getMonth() === month.getMonth() && now.getFullYear() === month.getFullYear() ? now.getTime() : month.getTime()))
    }
    setView(v)
  }
  const goToday = (): void => {
    setAnchor(startOfWeek(Date.now()))
    setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  }
  const today = Date.now()
  const label =
    view === 'week'
      ? `Semaine du ${anchor.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
      : month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  return (
    <div className="publish">
      <header className="publish-head">
        <div>
          <h1>Publier</h1>
          <p className="muted">Glisse un clip terminé sur l’agenda. Les ⭐ sont les meilleurs créneaux ; à l’heure prévue, GoClip te prévient et prépare la vidéo et le texte.</p>
        </div>
        <div className="row wrap">
          <div className="tabs">
            <button className={view === 'week' ? 'active' : ''} onClick={() => switchView('week')}>
              Semaine
            </button>
            <button className={view === 'month' ? 'active' : ''} onClick={() => switchView('month')}>
              Mois
            </button>
          </div>
          <button className="btn icon" onClick={() => shift(-1)} title="Précédent">
            ‹
          </button>
          <button className="btn small" onClick={goToday}>
            Aujourd’hui
          </button>
          <button className="btn icon" onClick={() => shift(1)} title="Suivant">
            ›
          </button>
          <button className={`btn ${showAdvice ? 'primary' : ''}`} onClick={() => {
            setShowAdvice(!showAdvice)
            setOpen(null)
          }}>
            ⭐ Conseils{advice?.source === 'ia' ? ' IA' : ''}
          </button>
        </div>
      </header>
      {due.length > 0 && (
        <div className="banner warn">
          <span>
            À publier maintenant : {due.map((p) => `« ${clipName(byId.get(p.clipId))} »`).join(', ')}
          </span>
          <button className="btn small primary" onClick={() => setOpen(due[0].id)}>
            Publier
          </button>
        </div>
      )}
      {error && <p className="error publish-error">{error}</p>}

      <div className={`publish-body ${open || showAdvice ? 'with-panel' : ''}`}>
        <aside className="publish-side">
          <h3>À programmer</h3>
          {ready.length === 0 ? (
            <p className="muted small">Les clips terminés (onglet Rendus) arrivent ici. Glisse-les sur l’agenda.</p>
          ) : (
            ready.map((c) => (
              <div key={c.id} className="ready-clip" draggable onDragStart={(e) => setDrag(e, { kind: 'clip', id: c.id })} title="Glisse-moi sur l’agenda">
                {c.thumbnail ? <img src={mediaUrl(c.thumbnail)} alt="" /> : <div className="thumb-empty">🎬</div>}
                <div className="ready-clip-body">
                  <b>{clipName(c)}</b>
                  <span className="muted small">{c.channel}</span>
                  <button className="btn small" onClick={() => scheduleBest(c.id)} title="Le programmer au meilleur créneau libre">
                    ⭐ Programmer
                  </button>
                </div>
              </div>
            ))
          )}
          <h3>À venir</h3>
          {upcoming.length === 0 ? (
            <p className="muted small">Rien de programmé.</p>
          ) : (
            upcoming.slice(0, 8).map((p) => (
              <button key={p.id} className="upcoming" onClick={() => setOpen(p.id)}>
                <b>{new Date(p.at).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })} {fmtTime(p.at)}</b>
                <span>{clipName(byId.get(p.clipId))}</span>
              </button>
            ))
          )}
        </aside>

        <section className="calendar" ref={calendarRef}>
          <div className="calendar-title">{label}</div>
          {view === 'week' ? (
            <div className="week">
              <div className="week-head">
                <span />
                {days.map((d) => (
                  <span key={d.getTime()} className={sameLocalDay(d.getTime(), today) ? 'today' : ''}>
                    {d.toLocaleDateString('fr-FR', { weekday: 'short' })} <b>{d.getDate()}</b>
                  </span>
                ))}
              </div>
              <div className="week-grid">
                {HOURS.map((h) => (
                  <div key={h} className="week-row">
                    <span className="hour">{h}h</span>
                    {days.map((d) => {
                      const start = at(d, h, 0)
                      const key = `${start}`
                      const inCell = posts.filter((p) => p.at >= start && p.at < start + 3600_000)
                      const cellSlots = slots.filter((s) => s.at >= start && s.at < start + 3600_000)
                      const past = start + 3600_000 < today
                      return (
                        <div
                          key={key}
                          className={`cell ${past ? 'past' : ''} ${hover === key ? 'over' : ''} ${cellSlots.length ? 'good' : ''}`}
                          onDragOver={(e) => {
                            e.preventDefault()
                            if (hover !== key) setHover(key)
                          }}
                          onDragLeave={() => setHover((x) => (x === key ? null : x))}
                          onDrop={(e) => {
                            const r = e.currentTarget.getBoundingClientRect()
                            const half = e.clientY - r.top > r.height / 2
                            drop(e, at(d, h, half ? 30 : 0))
                          }}
                        >
                          <SlotStar slots={cellSlots} />
                          {inCell.map((p) => (
                            <PostChip key={p.id} post={p} clip={byId.get(p.clipId)} onOpen={() => {
                              setOpen(p.id)
                              setShowAdvice(false)
                            }} compact />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="month">
              <div className="month-head">
                {DAYS.map((d) => (
                  <span key={d}>{d.slice(0, 3)}</span>
                ))}
              </div>
              <div className="month-grid">
                {Array.from({ length: 42 }, (_, i) => addDays(monthStart, i)).map((d) => {
                  const key = `m${d.getTime()}`
                  const inDay = posts.filter((p) => sameLocalDay(p.at, d.getTime())).sort((a, b) => a.at - b.at)
                  const daySlots = slots.filter((s) => sameLocalDay(s.at, d.getTime()))
                  const other = d.getMonth() !== month.getMonth()
                  return (
                    <div
                      key={key}
                      className={`day ${sameLocalDay(d.getTime(), today) ? 'today' : ''} ${hover === key ? 'over' : ''} ${other ? 'other' : ''}`}
                      onDragOver={(e) => {
                        e.preventDefault()
                        if (hover !== key) setHover(key)
                      }}
                      onDragLeave={() => setHover((x) => (x === key ? null : x))}
                      onDrop={(e) =>
                        drop(e, (data) => {
                          // Sur un jour : le meilleur créneau de ce jour-là (ou la même heure pour un déplacement).
                          if (data.kind === 'post') {
                            const p = posts.find((x) => x.id === data.id)
                            if (p) {
                              const t = new Date(p.at)
                              return at(d, t.getHours(), t.getMinutes())
                            }
                          }
                          const best = [...daySlots].sort((a, b) => b.score - a.score)[0]
                          return best ? best.at : at(d, 18, 0)
                        })
                      }
                    >
                      <span className="day-num">
                        {d.getDate()} {daySlots.length > 0 && <SlotStar slots={daySlots.slice(0, 3)} />}
                      </span>
                      {inDay.slice(0, 3).map((p) => (
                        <PostChip key={p.id} post={p} clip={byId.get(p.clipId)} onOpen={() => {
                          setOpen(p.id)
                          setShowAdvice(false)
                        }} compact />
                      ))}
                      {inDay.length > 3 && <span className="muted small">+{inDay.length - 3}</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {posts.length === 0 && ready.length === 0 && (
            <Empty title="Rien à publier pour l’instant" icon="📅">
              Termine un clip (bouton « Terminé » dans l’éditeur) : il apparaîtra à gauche, prêt à être glissé sur l’agenda.
            </Empty>
          )}
        </section>

        {openPost && prefs && (
          <PostPanel post={openPost} clip={byId.get(openPost.clipId)} prefs={prefs} advice={advice} posts={posts} ai={ai} onAiUsed={refreshAi} onClose={() => {
            setOpen(null)
            if (window.location.hash.startsWith('#/publier/')) window.location.hash = '#/publier'
          }} />
        )}
        {!openPost && showAdvice && prefs && (
          <AdvicePanel
            advice={advice}
            loading={adviceLoading}
            error={adviceError}
            prefs={prefs}
            ai={ai}
            onRefresh={loadAdvice}
            onPrefs={(p) =>
              void api()
                .setPublishPrefs(p)
                .then((next) => {
                  setPrefs(next)
                  refreshAi()
                })
            }
            onAi={setAi}
            onClose={() => setShowAdvice(false)}
          />
        )}
      </div>
    </div>
  )
}
