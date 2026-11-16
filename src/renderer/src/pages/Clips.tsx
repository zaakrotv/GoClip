// Bibliothèque de clips, rangée en un dossier par chaîne.
// Parcours d'un clip : À trier → Garder → (monter, Valider, revoir…) → Terminé → Rendus.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { editSignature, formatDuration } from '../../../shared/presets'
import type { AppState, Clip, ClipStatus, Reason, Template } from '../../../shared/types'
import { api, errorText, mediaUrl } from '../api'
import { KeepButton } from '../components/KeepButton'
import { Empty, Pill, Progress, Select } from '../components/ui'
import { timeAgo, useClips, useSettings, useTemplates } from '../hooks'
import { openClip } from '../nav'
import { usePosts } from './Publish'

/** Onglet, dossier et tri gardés quand on revient de l'éditeur. */
function useSessionState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => (sessionStorage.getItem(`autoclip.${key}`) as T | null) ?? initial)
  useEffect(() => sessionStorage.setItem(`autoclip.${key}`, value), [key, value])
  return [value, setValue]
}

const REASONS: Record<Reason, string> = { chat: '💬 Tchat', volume: '🔊 Son', 'clip-word': '« clip » écrit', hotkey: '⚡ Touche', manual: '✋ Manuel', voice: '🎙 « clip » dit' }
type Filter = 'new' | 'kept' | 'done' | 'all' | 'trash'
const FILTERS: [Filter, string][] = [
  ['new', 'À trier'],
  ['kept', 'Gardés'],
  ['done', 'Rendus'],
  ['all', 'Tous'],
  ['trash', 'Corbeille']
]
const HINTS: Record<Filter, string> = {
  new: 'Les moments trouvés automatiquement. Garde ceux qui te plaisent.',
  kept: 'Tes clips en cours de montage : modifie, « Valider » pour revoir la vidéo, autant de fois que tu veux. « Terminé » les envoie dans Rendus.',
  done: 'Les clips terminés, prêts à publier. Leurs vidéos sont dans le dossier Clips prêts ; 📅 les programme dans l’agenda de publication.',
  all: 'Tous les clips (sauf la corbeille).',
  trash: 'Les clips jetés. Vider la corbeille supprime leurs fichiers de travail.'
}

function flames(score: number): string {
  return score >= 14 ? '🔥🔥🔥' : score >= 8 ? '🔥🔥' : '🔥'
}

function renderInfo(c: Clip, progress: number | null): ReactElement | null {
  if (c.render.state === 'running') return <Progress value={progress ?? 0} />
  if (c.render.state === 'queued') return <small className="muted">Validation en attente…</small>
  if (c.render.state === 'error')
    return (
      <small className="error" title={c.render.error ?? ''}>
        Rendu raté : {c.render.error}
      </small>
    )
  if (c.status === 'kept') {
    if (!c.output) return <small className="muted">Pas encore validé</small>
    return c.renderSig === editSignature(c) ? <small className="ok-text">✓ Validé</small> : <small className="warn-text">Modifications non validées</small>
  }
  return null
}

function ClipCard(props: {
  clip: Clip
  selected: boolean
  onSelect: (v: boolean) => void
  progress: number | null
  onError: (m: string) => void
  onOpen: () => void
  templates: Template[]
  /** Patte qui s'applique à ce clip (la sienne, ou celle de sa chaîne). */
  template: string | null
  /** Déjà dans l'agenda de publication. */
  scheduled: boolean
}) {
  const c = props.clip
  const open = props.onOpen
  const act = (fn: () => Promise<unknown>) => () => void fn().catch((e) => props.onError(errorText(e)))
  return (
    <div className={`card clip ${props.selected ? 'selected' : ''}`}>
      <div className="thumb" onClick={open}>
        {c.thumbnail ? <img src={mediaUrl(c.thumbnail)} alt="" loading="lazy" /> : <div className="thumb-empty">🎬</div>}
        <span className="duration">{formatDuration(c.end - c.start)}</span>
        <span className="flames" title={`Force du moment : ${c.score}`}>
          {flames(c.score)}
        </span>
        <label className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={props.selected} onChange={(e) => props.onSelect(e.target.checked)} />
        </label>
        {c.live && <span className="live-tag">pendant le live</span>}
      </div>
      <div className="clip-body">
        <div className="clip-title" onClick={open}>
          {c.title || (c.chatWord ? 'Le tchat veut ce clip' : 'Moment fort du live')}
        </div>
        <div className="clip-meta">
          <span>{c.channel}</span>
          <span>{timeAgo(c.momentAt)}</span>
        </div>
        <div className="chips">
          {c.level === 'review' && c.status === 'new' && <Pill tone="warn">À valider</Pill>}
          {c.reasons.map((r) => (
            <Pill key={r}>{REASONS[r]}</Pill>
          ))}
        </div>
        {renderInfo(c, props.progress)}
        <div className="clip-actions">
          {c.status === 'new' && (
            <>
              <KeepButton ids={[c.id]} templates={props.templates} current={props.template} small onError={props.onError} />
              <button className="btn small" onClick={open}>
                ✂ Monter
              </button>
            </>
          )}
          {c.status === 'kept' && (
            <>
              <button className="btn small primary" onClick={open}>
                ✂ Monter
              </button>
              <button className="btn small" onClick={act(() => api().finishClips([c.id]))} title="Terminé : le clip va dans Rendus, prêt à publier">
                ✓ Terminé
              </button>
            </>
          )}
          {c.status === 'done' && (
            <>
              <button className="btn small primary" onClick={act(() => api().openPath(c.final ?? c.output!))} disabled={!c.final && !c.output}>
                ▶ Voir
              </button>
              <button className="btn small" onClick={act(() => api().showInFolder(c.final ?? c.output!))} title="Montrer le fichier dans Clips prêts">
                📂
              </button>
              <button className="btn small" onClick={open} title="Le remodifier (il repassera dans Gardés)">
                ✂
              </button>
              <button
                className="btn small"
                onClick={() => (window.location.hash = props.scheduled ? '#/publier' : `#/publier/programmer-${c.id}`)}
                title={props.scheduled ? 'Déjà dans l’agenda : voir l’agenda' : 'Le programmer au meilleur créneau (agenda de publication)'}
              >
                {props.scheduled ? '📅✓' : '📅'}
              </button>
            </>
          )}
          {c.status !== 'trash' ? (
            <button className="btn small ghost" onClick={act(() => api().setClipsStatus([c.id], 'trash'))} title="Mettre à la corbeille">
              🗑
            </button>
          ) : (
            <button className="btn small" onClick={act(() => api().setClipsStatus([c.id], 'new'))}>
              Restaurer
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function ClipsPage({ state }: { state: AppState | null }) {
  const [clips] = useClips()
  const [templates] = useTemplates()
  const [settings] = useSettings()
  const [filter, setFilter] = useSessionState<Filter>('filtre', 'new')
  const [folder, setFolder] = useSessionState<string>('dossier', '')
  const [sort, setSort] = useSessionState<'date' | 'score'>('tri', 'date')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const posts = usePosts()
  const [template, setTemplate] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Un dossier par chaîne (suivies + chaînes qui ont déjà des clips, comme les vidéos importées).
  const folders = useMemo(() => {
    const names = new Set([...(settings?.channels.map((c) => c.login) ?? []), ...clips.map((c) => c.channel)])
    return [...names].map((login) => {
      const cfg = settings?.channels.find((c) => c.login === login)
      const mine = clips.filter((c) => c.channel === login)
      return {
        login,
        name: cfg?.displayName ?? (login === 'imports' ? 'Vidéos importées' : login),
        avatar: cfg?.avatar ?? null,
        todo: mine.filter((c) => c.status === 'new').length,
        kept: mine.filter((c) => c.status === 'kept').length,
        done: mine.filter((c) => c.status === 'done').length
      }
    })
  }, [settings, clips])

  const inFolder = useMemo(() => clips.filter((c) => !folder || c.channel === folder), [clips, folder])
  const counts = useMemo(() => {
    const n: Record<Filter, number> = { new: 0, kept: 0, done: 0, all: 0, trash: 0 }
    for (const c of inFolder) {
      n[c.status]++
      if (c.status !== 'trash') n.all++
    }
    return n
  }, [inFolder])

  const list = useMemo(() => {
    const f = inFolder.filter((c) => (filter === 'all' ? c.status !== 'trash' : c.status === filter))
    return f.sort((a, b) => (sort === 'score' ? b.score - a.score : b.momentAt - a.momentAt))
  }, [inFolder, filter, sort])

  const sel = [...selected].filter((id) => list.some((c) => c.id === id))
  const running = state?.queue.running
  const run = (fn: () => Promise<unknown>): void => {
    setError(null)
    void fn()
      .then(() => setSelected(new Set()))
      .catch((e) => setError(errorText(e)))
  }
  const setStatus = (status: ClipStatus): void => run(() => api().setClipsStatus(sel, status))
  const current = folders.find((f) => f.login === folder)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{current ? current.name : 'Clips'}</h1>
          <p className="muted">{HINTS[filter]}</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => run(() => api().openReadyFolder(folder || null))} title="Ouvre le dossier des vidéos terminées">
            📂 Clips prêts{current ? ` de ${current.name}` : ''}
          </button>
        </div>
      </header>

      <div className="folders">
        <button className={`folder ${folder === '' ? 'active' : ''}`} onClick={() => setFolder('')}>
          <span className="folder-icon">🗂</span>
          <span className="folder-name">
            <b>Toutes les chaînes</b>
            <small>{clips.filter((c) => c.status !== 'trash').length} clips</small>
          </span>
        </button>
        {folders.map((f) => (
          <button key={f.login} className={`folder ${folder === f.login ? 'active' : ''}`} onClick={() => setFolder(f.login)} title={`À trier : ${f.todo} · Gardés : ${f.kept} · Rendus : ${f.done}`}>
            {f.avatar ? <img className="folder-icon" src={f.avatar} alt="" /> : <span className="folder-icon">📁</span>}
            <span className="folder-name">
              <b>{f.name}</b>
              <small>
                {f.todo} à trier · {f.kept} gardés · {f.done} rendus
              </small>
            </span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <div className="tabs">
          {FILTERS.map(([id, label]) => (
            <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
              {label} <span>{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="row">
          <Select
            value={sort}
            options={[
              { value: 'date', label: 'Plus récents' },
              { value: 'score', label: 'Plus forts' }
            ]}
            onChange={setSort}
          />
          {filter === 'trash' && counts.trash > 0 && (
            <button
              className="btn danger"
              onClick={() => {
                if (confirm(`Supprimer définitivement ${counts.trash} clip(s) et leurs fichiers de travail ? Les vidéos déjà dans « Clips prêts » sont gardées.`)) run(() => api().emptyTrash())
              }}
            >
              Vider la corbeille
            </button>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {sel.length > 0 && (
        <div className="selection-bar">
          <b>{sel.length} sélectionné(s)</b>
          <button className="btn small" onClick={() => setSelected(new Set(list.map((c) => c.id)))}>
            Tout sélectionner
          </button>
          {filter !== 'kept' && filter !== 'done' && (
            <KeepButton ids={sel} templates={templates} current={null} small onDone={() => setSelected(new Set())} onError={setError} />
          )}
          <button className="btn small" onClick={() => run(() => api().renderClips(sel))}>
            🎞 Valider
          </button>
          <button className="btn small primary" onClick={() => run(() => api().finishClips(sel))}>
            ✓ Terminé
          </button>
          <Select value={template} options={[{ value: '', label: 'Appliquer une patte…' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} onChange={setTemplate} />
          {template && (
            <button
              className="btn small"
              onClick={() => {
                const t = templates.find((x) => x.id === template)
                if (t) run(() => api().applyLook(sel, t.look, t.id, false))
                setTemplate('')
              }}
            >
              Appliquer
            </button>
          )}
          <button className="btn small ghost" onClick={() => setStatus('trash')}>
            🗑 Corbeille
          </button>
          <button className="btn small ghost" onClick={() => setSelected(new Set())}>
            Annuler
          </button>
        </div>
      )}

      {list.length === 0 ? (
        <Empty title={filter === 'new' ? 'Aucun clip à trier' : filter === 'done' ? 'Aucun clip terminé' : 'Rien ici'} icon="🎬">
          {filter === 'new' && 'Les clips arrivent ici pendant le live (touche Clip, « clip » dans le tchat) et à la fin de chaque live. Tu peux aussi analyser une vidéo dans « Enregistrements ».'}
          {filter === 'done' && 'Ouvre un clip gardé, valide-le, puis clique sur « Terminé » : il arrive ici, prêt à publier.'}
        </Empty>
      ) : (
        <div className="grid clips">
          {list.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              selected={selected.has(c.id)}
              progress={running?.clipId === c.id ? running.progress : null}
              onError={setError}
              onOpen={() => openClip(c.id, list.map((x) => x.id), FILTERS.find(([f]) => f === filter)?.[1] ?? '')}
              templates={templates}
              template={c.templateId ?? settings?.channels.find((ch) => ch.login === c.channel)?.templateId ?? settings?.defaultTemplateId ?? null}
              scheduled={posts.some((p) => p.clipId === c.id)}
              onSelect={(v) => {
                const n = new Set(selected)
                if (v) n.add(c.id)
                else n.delete(c.id)
                setSelected(n)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
