import { useCallback, useEffect, useState } from 'react'
import type { AppState, RecordingInfo } from '../../../shared/types'
import { api, errorText } from '../api'
import { Empty, Pill } from '../components/ui'
import { formatBytes, useSettings } from '../hooks'

export function RecordingsPage({ state }: { state: AppState | null }) {
  const [list, setList] = useState<RecordingInfo[]>([])
  const [settings] = useSettings()
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => void api().listRecordings().then(setList), [])
  const queueKey = `${state?.queue.running?.id ?? ''}|${state?.queue.pending.length ?? 0}|${state?.channels.map((c) => c.status).join(',')}`
  useEffect(() => reload(), [reload, queueKey])

  const busy = (file: string): boolean => state?.queue.running?.file === file || !!state?.queue.pending.some((j) => j.file === file)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Enregistrements</h1>
          <p className="muted">Les lives enregistrés. Tu peux relancer l’analyse (par exemple après avoir changé la sensibilité) ou analyser n’importe quelle vidéo de ton PC.</p>
        </div>
        <div className="row">
          {settings && (
            <button className="btn" onClick={() => void api().showInFolder(settings.recordingsDir)}>
              📂 Ouvrir le dossier
            </button>
          )}
          <button
            className="btn primary"
            onClick={async () => {
              try {
                setError(null)
                await api().importVideo()
                reload()
              } catch (e) {
                setError(errorText(e))
              }
            }}
          >
            + Analyser une vidéo
          </button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {list.length === 0 ? (
        <Empty title="Aucun enregistrement" icon="💾">
          Les lives apparaissent ici pendant et après leur enregistrement.
        </Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Fichier</th>
              <th>Chaîne</th>
              <th>Date</th>
              <th>Taille</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.file}>
                <td className="file-cell" title={r.file}>
                  {r.file.split(/[\\/]/).pop()}
                </td>
                <td>{r.channel}</td>
                <td>{new Date(r.modifiedAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{formatBytes(r.size)}</td>
                <td>
                  {r.recording ? (
                    <Pill tone="live">● En cours</Pill>
                  ) : busy(r.file) ? (
                    <Pill tone="accent">Analyse…</Pill>
                  ) : r.analyzed ? (
                    <Pill tone="ok">{r.clips} clip(s)</Pill>
                  ) : (
                    <Pill tone="warn">Pas analysé</Pill>
                  )}
                </td>
                <td className="actions">
                  {!r.recording && !busy(r.file) && (
                    <button className="btn small" onClick={() => void api().analyzeRecording(r.file).then(reload)}>
                      {r.analyzed ? 'Réanalyser' : 'Analyser'}
                    </button>
                  )}
                  <button className="btn small ghost" onClick={() => void api().showInFolder(r.file)}>
                    📂
                  </button>
                  {!r.recording && (
                    <button
                      className="btn small ghost danger"
                      onClick={async () => {
                        if (!confirm('Supprimer cet enregistrement ? Les clips déjà découpés sont gardés.')) return
                        try {
                          await api().deleteRecording(r.file)
                          reload()
                        } catch (e) {
                          setError(errorText(e))
                        }
                      }}
                    >
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
