import { useState } from 'react'
import { api } from './api'
import { QueueBox } from './components/Queue'
import { Toasts } from './components/Toast'
import { Progress } from './components/ui'
import { useAppState, useHashRoute } from './hooks'
import { ChannelsPage } from './pages/Channels'
import { ClipsPage } from './pages/Clips'
import { EditorPage } from './pages/Editor'
import { PublishPage, usePosts } from './pages/Publish'
import { RecordingsPage } from './pages/Recordings'
import { SettingsPage } from './pages/Settings'
import { TemplateEditorPage } from './pages/TemplateEditor'
import { TemplatesPage } from './pages/Templates'

const NAV = [
  { id: 'chaines', label: 'Chaînes', icon: '📡' },
  { id: 'clips', label: 'Clips', icon: '🎬' },
  { id: 'publier', label: 'Publier', icon: '📅' },
  { id: 'pattes', label: 'Pattes', icon: '🎨' },
  { id: 'enregistrements', label: 'Enregistrements', icon: '💾' },
  { id: 'reglages', label: 'Réglages', icon: '⚙️' }
]

export function App() {
  const state = useAppState()
  const [route, go] = useHashRoute()
  const [markInfo, setMarkInfo] = useState<string | null>(null)
  const mark = async (): Promise<void> => {
    const n = await api().markMoment()
    setMarkInfo(n > 0 ? '✓ Moment gardé' : 'Aucun live en cours d’enregistrement')
    setTimeout(() => setMarkInfo(null), 3000)
  }
  const [page, param, sub] = route.split('/')
  const missing = state && (!state.deps.streamlink || !state.deps.ffmpeg)
  const recording = state?.channels.filter((c) => c.status === 'recording').length ?? 0
  const posts = usePosts()
  const due = posts.filter((p) => p.targets.some((t) => t.state === 'due')).length

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">✂</span>
          <div>
            <b>GoClip</b>
            <small>{recording > 0 ? `● ${recording} live${recording > 1 ? 's' : ''} enregistré${recording > 1 ? 's' : ''}` : 'Clips automatiques'}</small>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={page === n.id || (page === 'clip' && n.id === 'clips') || (page === 'patte' && n.id === 'pattes') ? 'active' : ''} onClick={() => go(n.id)}>
              <span>{n.icon}</span>
              {n.label}
              {n.id === 'publier' && due > 0 && (
                <span className="nav-badge" title={`${due} publication(s) à faire maintenant`}>
                  {due}
                </span>
              )}
            </button>
          ))}
        </nav>
        <button className="btn mark" onClick={() => void mark()} title="Garde les dernières secondes du live en cours (touche Clip)">
          {markInfo ?? '⚡ Garder ce moment'}
        </button>
        {state && <QueueBox state={state} />}
      </aside>
      <main className="content">
        {state?.deps.download ? (
          <div className="banner download-banner">
            <span>
              Préparation des outils : {state.deps.download.name}
              {state.deps.download.total > 0 && ` — ${Math.round((state.deps.download.done / state.deps.download.total) * 100)} %`}
            </span>
            <Progress value={state.deps.download.total > 0 ? state.deps.download.done / state.deps.download.total : 0.05} />
          </div>
        ) : (
          missing &&
          page !== 'reglages' && (
            <div className="banner">
              <span>{state?.deps.error ? `Téléchargement des outils impossible : ${state.deps.error}` : 'Il manque les outils d’enregistrement (Streamlink + FFmpeg).'}</span>
              <button className="btn primary small" onClick={() => go('reglages')}>
                Installer
              </button>
            </div>
          )
        )}
        {state?.notice && <div className="banner warn">{state.notice}</div>}
        {state?.update.status === 'ready' && (
          <div className="banner ok-banner">
            <span>La version {state.update.version} de GoClip est prête.</span>
            <button className="btn primary small" onClick={() => void api().installUpdate()}>
              Redémarrer et mettre à jour
            </button>
          </div>
        )}
        {page === 'chaines' && <ChannelsPage state={state} />}
        {page === 'clips' && <ClipsPage state={state} />}
        {page === 'clip' && param && <EditorPage key={param} id={param} initialTab={sub} state={state} onClose={() => go('clips')} />}
        {page === 'publier' && <PublishPage openId={param} />}
        {page === 'pattes' && <TemplatesPage />}
        {page === 'patte' && <TemplateEditorPage key={param ?? 'nouvelle'} id={param && param !== 'nouvelle' ? param : null} />}
        {page === 'enregistrements' && <RecordingsPage state={state} />}
        {page === 'reglages' && <SettingsPage state={state} />}
        <Toasts />
      </main>
    </div>
  )
}
