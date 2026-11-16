import { useEffect, useRef, useState } from 'react'
import type { AppState, ChannelConfig, ChannelState, ChannelSuggestion, Settings } from '../../../shared/types'
import { api, errorText } from '../api'
import { Empty, Pill, Select } from '../components/ui'
import { useSettings, useTemplates } from '../hooks'

function since(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

function compact(n: number | null): string {
  if (n === null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '')} M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',').replace(',0', '')} k`
  return String(n)
}

function StatusPill({ s }: { s: ChannelState }) {
  switch (s.status) {
    case 'recording':
      return <Pill tone="live">● Enregistrement {s.recordingSince ? `depuis ${since(s.recordingSince)}` : ''}</Pill>
    case 'live':
      return <Pill tone="accent">En direct (non enregistré)</Pill>
    case 'reconnecting':
      return <Pill tone="warn">Reconnexion…</Pill>
    case 'checking':
      return <Pill>Vérification…</Pill>
    case 'paused':
      return <Pill>En pause</Pill>
    case 'error':
      return <Pill tone="danger">Problème</Pill>
    default:
      return <Pill>Hors ligne</Pill>
  }
}

/** Ce qu'AutoClip a fait du dernier « clip » écrit dans le tchat (avec de quoi faire confiance à la personne). */
function LastRequest({ s, settings }: { s: ChannelState; settings: Settings | null }) {
  const r = s.lastRequest
  if (!r || !settings) return null
  const trusted = settings.detection.trusted.includes(r.user.toLowerCase())
  const trust = (): void => {
    void api().updateSettings({ detection: { ...settings.detection, trusted: [...new Set([...settings.detection.trusted, r.user.toLowerCase()])] } })
  }
  return (
    <div className={`last-request ${r.outcome}`}>
      <span>
        « {r.word || 'clip'}
        {r.title ? ` : ${r.title}` : ''} » de <b>{r.user}</b>{' '}
        {r.outcome === 'clip'
          ? `→ clip en préparation${r.title ? ` (« ${r.title} »)` : ''}, il arrive dans « À trier »`
          : r.outcome === 'already'
            ? '→ ce moment a déjà son clip'
            : `→ en attente : ${r.count}/${r.needed} personnes en 30 s`}
      </span>
      {r.outcome === 'waiting' && !trusted && (
        <button className="btn small" onClick={trust} title="Son « clip » suffira à lui seul (Réglages > Le tchat écrit…)">
          Faire confiance à {r.user}
        </button>
      )}
    </div>
  )
}

function ChannelCard({ cfg, s, templates, settings }: { cfg: ChannelConfig; s: ChannelState; templates: { value: string; label: string }[]; settings: Settings | null }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (s.status !== 'recording') return
    const t = setInterval(() => tick((x) => x + 1), 30_000)
    return () => clearInterval(t)
  }, [s.status])
  return (
    <div className={`card channel ${s.status}`}>
      <div className="channel-head">
        {cfg.avatar ? <img className="avatar" src={cfg.avatar} alt="" /> : <div className="avatar placeholder">{cfg.login[0].toUpperCase()}</div>}
        <div className="channel-name">
          <b>{cfg.displayName ?? cfg.login}</b>
          <a href={`https://www.twitch.tv/${cfg.login}`} target="_blank" rel="noreferrer">
            twitch.tv/{cfg.login}
          </a>
        </div>
        <StatusPill s={s} />
      </div>
      {s.message && <p className="muted small">{s.message}</p>}
      {s.status === 'recording' && (
        <>
          <div className="channel-stats">
            <span>💬 {s.chat ? (s.chat.connected ? `${s.chat.messages} messages` : 'connexion au tchat…') : '—'}</span>
            <span title="Messages du tchat qui demandent un clip (« clip », « clippez »…)">✂ « clip » × {s.chat?.requests ?? 0}</span>
            <span title="Clips déjà découpés pendant ce live (touche Clip, « clip » écrit ou dit)">🎬 {s.liveClips} clip{s.liveClips > 1 ? 's' : ''} pendant le live</span>
            {s.voice && (
              <span title={s.voice.error ?? (s.voice.heard ? `Dernière fois entendu : « ${s.voice.heard} »` : 'Whisper écoute le live et lance un clip quand le streamer dit « clip »')}>
                🎙 {s.voice.error ? 'écoute impossible' : s.voice.active ? (s.voice.heardAt ? `« clip » entendu il y a ${since(s.voice.heardAt)}` : 'écoute « clip »') : 'écoute en pause'}
              </span>
            )}
          </div>
          <LastRequest s={s} settings={settings} />
        </>
      )}
      <div className="channel-actions">
        <Select
          label="Patte de cette chaîne"
          value={cfg.templateId ?? ''}
          options={[{ value: '', label: 'Patte par défaut' }, ...templates]}
          onChange={(v) => void api().setChannelTemplate(cfg.login, v || null)}
        />
        <div className="row">
          {s.status === 'recording' && (
            <button className="btn small" onClick={() => void api().stopRecording(cfg.login)}>
              ⏹ Arrêter ce live
            </button>
          )}
          {s.status === 'live' && (
            <button className="btn small" onClick={() => void api().resumeRecording(cfg.login)}>
              ⏺ Enregistrer
            </button>
          )}
          <button className="btn small" onClick={() => void api().setChannelPaused(cfg.login, !cfg.paused)}>
            {cfg.paused ? '▶ Reprendre la surveillance' : '⏸ Pause'}
          </button>
          <button
            className="btn small ghost danger"
            onClick={() => {
              if (confirm(`Ne plus suivre ${cfg.displayName ?? cfg.login} ? Les clips déjà faits sont gardés.`)) void api().removeChannel(cfg.login)
            }}
          >
            Retirer
          </button>
        </div>
      </div>
    </div>
  )
}

/** Champ de recherche : propose les chaînes Twitch existantes et dit si elles sont en live. */
function ChannelSearch({ followed, onAdded }: { followed: string[]; onAdded: () => void }) {
  const [input, setInput] = useState('')
  const [results, setResults] = useState<ChannelSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const query = useRef(0)

  useEffect(() => {
    const q = input.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    const n = ++query.current
    const t = setTimeout(async () => {
      const r = await api().searchChannels(q)
      if (n === query.current) {
        setResults(r)
        setActive(-1)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [input])

  const add = async (login: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api().addChannel(login)
      if (r.ok) {
        setInput('')
        setResults([])
        setOpen(false)
        onAdded()
      } else setError(r.error ?? 'Impossible d’ajouter cette chaîne.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="channel-search">
      <form
        className="add-channel"
        onSubmit={(e) => {
          e.preventDefault()
          const pick = active >= 0 ? results[active] : null
          if (pick) void add(pick.login)
          else if (input.trim()) void add(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(results.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(-1, a - 1))
            } else if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="Cherche un pseudo Twitch ou colle le lien de la chaîne"
        />
        <button className="btn primary" disabled={busy || !input.trim()}>
          {busy ? 'Ajout…' : 'Suivre la chaîne'}
        </button>
      </form>
      {open && results.length > 0 && (
        <div className="suggestions">
          {results.map((r, i) => {
            const already = followed.includes(r.login)
            return (
              <button key={r.login} className={`suggestion ${i === active ? 'active' : ''}`} disabled={already || busy} onMouseDown={(e) => e.preventDefault()} onClick={() => void add(r.login)}>
                {r.avatar ? <img src={r.avatar} alt="" /> : <span className="avatar placeholder small">{r.login[0].toUpperCase()}</span>}
                <span className="suggestion-name">
                  <b>{r.displayName}</b>
                  <small>
                    twitch.tv/{r.login}
                    {r.followers !== null && ` · ${compact(r.followers)} abonnés`}
                  </small>
                </span>
                {already ? <Pill>Déjà suivie</Pill> : r.live ? <Pill tone="live">● En live{r.viewers !== null ? ` · ${compact(r.viewers)} spectateurs` : ''}</Pill> : <Pill>Hors ligne</Pill>}
              </button>
            )
          })}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export function ChannelsPage({ state }: { state: AppState | null }) {
  const [settings] = useSettings()
  const [templates] = useTemplates()
  const tplOptions = templates.map((t) => ({ value: t.id, label: t.name }))
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Chaînes suivies</h1>
          <p className="muted">Dès qu’une chaîne passe en live, GoClip l’enregistre avec son tchat. Les clips demandés pendant le live (touche Clip, « clip » dans le tchat) arrivent tout de suite dans « À trier » ; les autres moments forts à la fin du live.</p>
        </div>
      </header>
      <ChannelSearch followed={settings?.channels.map((c) => c.login) ?? []} onAdded={() => {}} />
      {settings && settings.channels.length === 0 ? (
        <Empty title="Aucune chaîne pour l’instant" icon="📡">
          Tape un pseudo Twitch juste au-dessus : GoClip te propose les chaînes qui existent et te dit si elles sont en live.
        </Empty>
      ) : (
        <div className="grid channels">
          {settings?.channels.map((c) => {
            const s = state?.channels.find((x) => x.login === c.login) ?? {
              login: c.login,
              status: 'offline' as const,
              message: null,
              recordingSince: null,
              file: null,
              chat: null,
              marks: 0,
              liveClips: 0,
              nextCheckAt: null,
              lastRequest: null,
              voice: null
            }
            return <ChannelCard key={c.login} cfg={c} s={s} templates={tplOptions} settings={settings} />
          })}
        </div>
      )}
      {settings && (
        <div className="hint-box">
          <b>Touche Clip : {settings.hotkey.enabled ? settings.hotkey.accelerator : 'désactivée'}</b>
          <span>
            Pendant un live, appuie dessus (même en jeu) pour garder{' '}
            {settings.detection.fixedLength > 0 ? `un clip de ${settings.detection.fixedLength} secondes` : `les ${settings.hotkey.before} dernières secondes`} : le clip arrive dans « À trier » une quinzaine de secondes plus tard.
          </span>
        </div>
      )}
    </div>
  )
}
