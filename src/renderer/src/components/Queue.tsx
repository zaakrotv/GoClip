// Petite case des travaux (en bas à gauche) : ce qui tourne, ce qui attend, et les commandes
// pour tout mettre en pause, annuler, mettre de côté ou faire passer un travail en premier.
import { useEffect, useState } from 'react'
import type { AppState, Job, JobKind } from '../../../shared/types'
import { api } from '../api'
import { Progress } from './ui'

const ICONS: Record<JobKind, string> = { analyze: '🔎', render: '🎞', transcribe: '💬', download: '⬇', 'live-clip': '✂' }

function open(job: Job): void {
  if (job.clipId) window.location.hash = `#/clip/${job.clipId}`
  else if (job.kind === 'analyze') window.location.hash = '#/enregistrements'
}

function JobRow(props: { job: Job; running: boolean; paused: boolean; first: boolean }) {
  const { job } = props
  return (
    <div className={`job-row ${job.held ? 'held' : ''} ${props.running ? 'running' : ''}`}>
      <span className="job-icon">{ICONS[job.kind]}</span>
      <div className="job-text">
        <b title={job.label}>{job.label}</b>
        <span className="muted small">{props.running ? (props.paused ? '⏸ En pause' : `${job.step} · ${Math.round(job.progress * 100)} %`) : job.held ? 'Mis de côté' : 'En attente'}</span>
        {props.running && <Progress value={job.progress} />}
      </div>
      <div className="job-actions">
        {props.running ? (
          <button className="mini" title={props.paused ? 'Reprendre' : 'Mettre en pause'} onClick={() => void api().pauseQueue(!props.paused)}>
            {props.paused ? '▶' : '⏸'}
          </button>
        ) : (
          <>
            {!props.first && (
              <button className="mini" title="Faire passer en premier" onClick={() => void api().prioritizeJob(job.id)}>
                ⬆
              </button>
            )}
            <button className="mini" title={job.held ? 'Relancer' : 'Mettre de côté (il ne démarrera pas)'} onClick={() => void api().holdJob(job.id, !job.held)}>
              {job.held ? '▶' : '⏸'}
            </button>
          </>
        )}
        {job.clipId && (
          <button className="mini" title="Ouvrir le clip" onClick={() => open(job)}>
            ↗
          </button>
        )}
        <button className="mini danger" title="Annuler" onClick={() => void api().cancelJob(job.id)}>
          ✕
        </button>
      </div>
    </div>
  )
}

function QueuePanel({ state }: { state: AppState }) {
  const q = state.queue
  const total = (q.running ? 1 : 0) + q.pending.length
  return (
    <div className="queue-panel" onMouseDown={(e) => e.stopPropagation()}>
      <header>
        <b>Travaux</b>
        <div className="row">
          <button className="btn small" onClick={() => void api().pauseQueue(!q.paused)}>
            {q.paused ? '▶ Reprendre' : '⏸ Tout mettre en pause'}
          </button>
          {total > 0 && (
            <button
              className="btn small ghost danger"
              onClick={() => {
                if (confirm(`Annuler les ${total} travaux (rendus, transcriptions, analyses) ?`)) void api().cancelAllJobs()
              }}
            >
              Tout annuler
            </button>
          )}
        </div>
      </header>
      <div className="queue-list">
        {q.side.map((j) => (
          <div key={j.id} className="job-row running">
            <span className="job-icon">{ICONS[j.kind]}</span>
            <div className="job-text">
              <b>{j.label}</b>
              <span className="muted small">Découpe en cours (passe à côté de la file)</span>
            </div>
          </div>
        ))}
        {q.running && <JobRow job={q.running} running paused={q.paused} first />}
        {q.pending.map((j, i) => (
          <JobRow key={j.id} job={j} running={false} paused={q.paused} first={i === 0} />
        ))}
        {total === 0 && q.side.length === 0 && <p className="muted small">Aucun travail.</p>}
      </div>
      {q.paused && <p className="muted small">En pause : le travail en cours est suspendu et reprendra là où il en était. Les clips demandés pendant un live sont toujours découpés.</p>}
    </div>
  )
}

export function QueueBox({ state }: { state: AppState }) {
  const [panel, setPanel] = useState(false)
  const q = state.queue
  const job = q.running
  const waiting = q.pending.length
  const busy = !!job || waiting > 0 || q.side.length > 0

  // Un clic ailleurs ferme le panneau.
  useEffect(() => {
    if (!panel) return
    const close = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.queue-wrap')) setPanel(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [panel])

  if (!busy && !q.paused) return <div className="queue idle">Rien en cours</div>
  return (
    <div className="queue-wrap">
      {panel && <QueuePanel state={state} />}
      <div className={`queue clickable ${q.paused ? 'paused' : ''}`} onClick={() => setPanel(!panel)} title="Clique pour voir et gérer les travaux">
        {job ? (
          <>
            <div className="queue-title" title={job.label}>
              {ICONS[job.kind]} {job.label}
            </div>
            <div className="queue-step">{q.paused ? '⏸ En pause' : `${job.step} · ${Math.round(job.progress * 100)} %`}</div>
            <Progress value={job.progress} />
          </>
        ) : q.paused ? (
          <div className="queue-title">⏸ File en pause</div>
        ) : null}
        {q.side.map((j) => (
          <div key={j.id} className="queue-step">
            ✂ {j.label}…
          </div>
        ))}
        <div className="queue-foot">
          <span className="queue-step">{waiting > 0 ? `${waiting} en attente` : ''}</span>
          <span className="queue-buttons" onClick={(e) => e.stopPropagation()}>
            <button className="mini" title={q.paused ? 'Reprendre' : 'Tout mettre en pause'} onClick={() => void api().pauseQueue(!q.paused)}>
              {q.paused ? '▶' : '⏸'}
            </button>
            {job && (
              <button className="mini danger" title="Annuler ce travail" onClick={() => void api().cancelJob(job.id)}>
                ✕
              </button>
            )}
            <button className="mini" title="Voir tous les travaux" onClick={() => setPanel(!panel)}>
              ☰
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
