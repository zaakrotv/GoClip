import { useState, type KeyboardEvent } from 'react'
import type { DepName } from '../../../shared/api'
import { normalizeChatWords } from '../../../shared/chatcommand'
import type { AppState, DetectionSettings, Settings, WhisperModel } from '../../../shared/types'
import { api, errorText } from '../api'
import { Pill, Progress, Section, Select, Slider, Toggle } from '../components/ui'
import { formatBytes, useSettings } from '../hooks'

const MODELS: { value: WhisperModel; label: string }[] = [
  { value: 'base', label: 'Rapide (≈ 60 Mo, moins précis)' },
  { value: 'small', label: 'Équilibré (≈ 190 Mo, conseillé)' },
  { value: 'large-v3-turbo', label: 'Précis (≈ 570 Mo, plus lent)' }
]

const LANGS = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'Anglais' },
  { value: 'es', label: 'Espagnol' },
  { value: 'de', label: 'Allemand' },
  { value: 'it', label: 'Italien' },
  { value: 'pt', label: 'Portugais' },
  { value: 'auto', label: 'Détection automatique' }
]

/** Transforme une touche pressée en raccourci Electron (ex : « Ctrl+Shift+F8 »). */
function accelerator(e: KeyboardEvent): string | null {
  const code = e.code
  let key: string | null = null
  if (/^F\d{1,2}$/.test(code)) key = code
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`
  else {
    const map: Record<string, string> = {
      Space: 'Space', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Pause: 'Pause', ScrollLock: 'Scrolllock',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
    }
    key = map[code] ?? null
  }
  if (!key) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
  return [...mods, key].join('+')
}

/** Liste de pseudos Twitch séparés par des virgules (enregistrée quand on quitte le champ). */
function TrustedInput(props: { value: string[]; onChange: (v: string[]) => void }) {
  const joined = props.value.join(', ')
  const [text, setText] = useState(joined)
  const [focused, setFocused] = useState(false)
  const commit = (): void => {
    const list = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter((s) => /^[a-z0-9_]{2,25}$/.test(s)))]
    setText(list.join(', '))
    if (list.join(',') !== props.value.join(',')) props.onChange(list)
  }
  return (
    <label className="field">
      <span className="field-label">Pseudos de confiance (un seul « clip » de leur part suffit)</span>
      <input
        value={focused ? text : joined}
        placeholder="ton pseudo, tes potes… séparés par des virgules"
        onFocus={() => {
          setText(joined)
          setFocused(true)
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

/** Mots du tchat qui demandent un clip, séparés par des virgules (enregistrés quand on quitte le champ). */
function ChatWordsInput(props: { value: string[]; onChange: (v: string[]) => void }) {
  const joined = props.value.join(', ')
  const [text, setText] = useState(joined)
  const [focused, setFocused] = useState(false)
  const commit = (): void => {
    const list = normalizeChatWords(text)
    setText(list.join(', '))
    if (list.join(',') !== props.value.join(',')) props.onChange(list)
  }
  return (
    <label className="field">
      <span className="field-label">Mot qui demande un clip (plusieurs possibles, séparés par des virgules)</span>
      <input
        value={focused ? text : joined}
        placeholder="clip"
        onFocus={() => {
          setText(joined)
          setFocused(true)
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function DepRow(props: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className="dep-row">
      <span>{props.label}</span>
      {props.ok === null ? <Pill>—</Pill> : props.ok ? <Pill tone="ok">✓ {props.detail ?? 'Prêt'}</Pill> : <Pill tone="warn">{props.detail ?? 'À installer'}</Pill>}
    </div>
  )
}

export function SettingsPage({ state }: { state: AppState | null }) {
  const [settings, update] = useSettings()
  const [error, setError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  if (!settings) return <div className="page">Chargement…</div>
  const deps = state?.deps
  const dl = deps?.download
  const det = (patch: Partial<DetectionSettings>): void => void update({ detection: { ...settings.detection, ...patch } })
  /** Le mot du tchat qui demande un clip (le premier choisi), pour les libellés. */
  const chatWord = settings.detection.chatWords?.[0] ?? 'clip'
  const install = async (what: DepName[]): Promise<void> => {
    setError(null)
    try {
      await api().installDeps(what)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => void update({ [k]: v } as Partial<Settings>)

  return (
    <div className="page settings">
      <header className="page-head">
        <div>
          <h1>Réglages</h1>
          <p className="muted">Tout est enregistré automatiquement.</p>
        </div>
      </header>

      <Section title="Application">
        <div className="dep-row">
          <span>GoClip version {state?.version ?? '…'}</span>
          {state?.update.status === 'ready' ? (
            <Pill tone="ok">Version {state.update.version} prête</Pill>
          ) : state?.update.status === 'downloading' ? (
            <Pill tone="accent">Téléchargement de la {state.update.version ?? 'mise à jour'} : {Math.round((state.update.progress ?? 0) * 100)} %</Pill>
          ) : state?.update.status === 'checking' ? (
            <Pill>Recherche…</Pill>
          ) : state?.update.status === 'none' ? (
            <Pill tone="ok">À jour</Pill>
          ) : state?.update.status === 'error' ? (
            <Pill tone="warn" title={state.update.error ?? ''}>
              Vérification impossible
            </Pill>
          ) : null}
        </div>
        {state?.update.status === 'unconfigured' ? (
          <p className="muted small">Les mises à jour automatiques s’activent quand tu publies GoClip sur GitHub (voir le README, « Publier une mise à jour ») : toutes les personnes qui l’ont installé reçoivent alors chaque nouvelle version toute seule.</p>
        ) : (
          <div className="row wrap">
            <button className="btn" disabled={state?.update.status === 'checking' || state?.update.status === 'downloading'} onClick={() => void api().checkForUpdates()}>
              Rechercher une mise à jour
            </button>
            {state?.update.status === 'ready' && (
              <button className="btn primary" onClick={() => void api().installUpdate()}>
                Redémarrer et installer la {state.update.version}
              </button>
            )}
          </div>
        )}
      </Section>

      <Section title="Outils">
        <DepRow label="Streamlink (enregistrement des lives)" ok={deps?.streamlink ?? null} />
        <DepRow label="FFmpeg (découpe et montage)" ok={deps?.ffmpeg ?? null} detail={deps?.ffmpeg ? (deps.encoder ? `Encodeur : ${deps.encoder}` : 'Prêt') : undefined} />
        <DepRow label="Sous-titres dans la vidéo (libass)" ok={deps?.ass ?? null} detail={deps?.ass === false ? 'Absent de ce FFmpeg' : undefined} />
        <DepRow label="Whisper (transcription)" ok={deps?.whisper ?? null} />
        <DepRow label="Modèle de transcription" ok={deps ? deps.model && deps.vad : null} />
        {dl && (
          <div className="download">
            <span>
              {dl.name} {dl.total > 0 ? `— ${formatBytes(dl.done)} / ${formatBytes(dl.total)}` : '…'}
            </span>
            <Progress value={dl.total > 0 ? dl.done / dl.total : 0.05} />
          </div>
        )}
        {(deps?.error || error) && <p className="error">{deps?.error ?? error}</p>}
        <div className="row wrap">
          <button className="btn primary" disabled={!!dl} onClick={() => void install(['streamlink', 'whisper', 'model'])}>
            Installer ce qui manque
          </button>
          <button className="btn" disabled={!!dl} onClick={() => void install(['model'])}>
            Télécharger le modèle choisi
          </button>
        </div>
        <p className="muted small">Téléchargés depuis les sites officiels (GitHub de Streamlink et de whisper.cpp, Hugging Face). Environ 100 Mo + le modèle.</p>
      </Section>

      <Section title="Dossiers">
        <div className="path-row">
          <div>
            <b>Enregistrements des lives</b>
            <code>{settings.recordingsDir}</code>
          </div>
          <button className="btn small" onClick={() => void api().chooseFolder('recordings').then(() => update({}))}>
            Changer
          </button>
        </div>
        <div className="path-row">
          <div>
            <b>Clips prêts (vidéos finales)</b>
            <code>{settings.readyDir}</code>
          </div>
          <button className="btn small" onClick={() => void api().chooseFolder('ready').then(() => update({}))}>
            Changer
          </button>
        </div>
      </Section>

      <Section title="Enregistrement">
        <Select
          label="Qualité enregistrée"
          value={settings.quality}
          options={[
            { value: '1080p60,best', label: '1080p 60 i/s (meilleure)' },
            { value: '720p60,720p,best', label: '720p (prend moins de place)' },
            { value: '480p,best', label: '480p (très léger)' }
          ]}
          onChange={set('quality')}
        />
        <Toggle label="Supprimer le live après l’analyse" hint="Garde seulement les clips (gagne beaucoup de place)" checked={settings.deleteRecordingAfterAnalysis} onChange={set('deleteRecordingAfterAnalysis')} />
      </Section>

      <Section title="Trouver les moments forts">
        <Toggle label="Le tchat s’emballe" checked={settings.detection.chat} onChange={(chat) => det({ chat })} />
        <Toggle label="Le son monte d’un coup (cri, rire, explosion)" checked={settings.detection.volume} onChange={(volume) => det({ volume })} />
        <Toggle label={`Le tchat écrit « ${chatWord} »`} checked={settings.detection.clipWord} onChange={(clipWord) => det({ clipWord })} />
        <Toggle label="La touche Clip" checked={settings.detection.hotkey} onChange={(hotkey) => det({ hotkey })} />
        <Slider label="Sensibilité" value={settings.detection.sensitivity} min={0.5} max={2} step={0.1} format={(v) => (v < 0.8 ? 'Peu de clips' : v > 1.3 ? 'Beaucoup de clips' : 'Normale')} onChange={(sensitivity) => det({ sensitivity })} />
        <Slider label="Clips automatiques au plus, par heure de live" value={settings.detection.maxPerHour} min={1} max={20} onChange={(maxPerHour) => det({ maxPerHour })} />
      </Section>

      <Section title="Durée des clips">
        <Select
          label="Durée de chaque nouveau clip"
          value={settings.detection.fixedLength}
          options={[
            { value: 0, label: 'Automatique (selon le moment)' },
            ...(
              [
                [15, '15 secondes'],
                [20, '20 secondes'],
                [30, '30 secondes'],
                [45, '45 secondes'],
                [60, '1 minute'],
                [90, '1 min 30'],
                [120, '2 minutes'],
                [180, '3 minutes']
              ] as [number, string][]
            ).map(([value, label]) => ({ value, label }))
          ]}
          onChange={(fixedLength) => det({ fixedLength })}
        />
        {settings.detection.fixedLength === 0 ? (
          <div className="two">
            <Slider label="Durée minimale" value={settings.detection.minLength} min={8} max={40} format={(v) => `${v} s`} onChange={(minLength) => det({ minLength })} />
            <Slider label="Durée maximale" value={settings.detection.maxLength} min={30} max={180} step={5} format={(v) => `${v} s`} onChange={(maxLength) => det({ maxLength })} />
          </div>
        ) : (
          <p className="muted small">Tous les nouveaux clips (moments forts, touche Clip, « clip » écrit ou dit) dureront {settings.detection.fixedLength} secondes. Tu peux toujours allonger ou raccourcir un clip dans le montage.</p>
        )}
        <Slider
          label="Gardé après le moment signalé (touche Clip, « clip »)"
          value={settings.detection.after}
          min={0}
          max={15}
          format={(v) => `${v} s`}
          onChange={(after) => det({ after })}
        />
      </Section>

      <Section title={`Le tchat écrit « ${chatWord} »`}>
        <ChatWordsInput value={settings.detection.chatWords} onChange={(chatWords) => det({ chatWords })} />
        <p className="muted small">
          {settings.detection.chatWords.includes('clip') ? 'Avec « clip », ses variantes marchent aussi (clips, clippe, clippez…). ' : ''}
          Pour donner aussi un titre : <b>« {chatWord} : headshot »</b> → le clip s’appelle « headshot » dans GoClip (tu peux le changer dans le montage). « {chatWord} » tout seul marche toujours.
        </p>
        <Select
          label={`Il faut que « ${chatWord} » soit écrit par`}
          value={settings.detection.chatUsers}
          options={[
            { value: 1, label: 'Une seule personne (n’importe qui)' },
            { value: 2, label: '2 personnes différentes en 30 secondes' },
            { value: 3, label: '3 personnes différentes en 30 secondes' },
            { value: 4, label: '4 personnes différentes en 30 secondes' },
            { value: 5, label: '5 personnes différentes en 30 secondes' }
          ]}
          onChange={(chatUsers) => det({ chatUsers })}
        />
        <TrustedInput value={settings.detection.trusted} onChange={(trusted) => det({ trusted })} />
        <p className="muted small">Le streamer, les modos et les VIP comptent toujours tout de suite. Mets ton pseudo Twitch dans la liste pour que ton « clip » marche aussi sur les chaînes où tu n’es pas modo.</p>
      </Section>

      <Section title="Le streamer dit « clip »">
        <Toggle
          label="Faire un clip quand le streamer dit « clip » à voix haute"
          hint="Pendant l’enregistrement, Whisper écoute le son du live sur ton PC (sans internet), toutes les 4 secondes. Ça marche comme la touche Clip."
          checked={settings.detection.voice}
          onChange={(voice) => det({ voice })}
        />
        {settings.detection.voice && (
          <p className="muted small">
            {deps?.whisper
              ? 'Le petit modèle « Rapide » (≈ 60 Mo) sert à l’écoute : il se télécharge tout seul s’il manque. L’écoute utilise un peu de processeur pendant les lives (environ un cœur).'
              : 'Whisper n’est pas encore installé : il se télécharge tout seul (voir la section Outils).'}{' '}
            Ce que l’écoute entend s’affiche sur la carte de la chaîne.
          </p>
        )}
      </Section>

      <Section title="Touche Clip">
        <Toggle label="Activer la touche Clip" hint="Marche même quand tu es en jeu" checked={settings.hotkey.enabled} onChange={(enabled) => void update({ hotkey: { ...settings.hotkey, enabled } })} />
        <div className="field">
          <span className="field-label">Touche</span>
          <button
            className={`btn hotkey ${capturing ? 'capturing' : ''}`}
            onClick={() => setCapturing(true)}
            onBlur={() => setCapturing(false)}
            onKeyDown={(e) => {
              if (!capturing) return
              e.preventDefault()
              const acc = accelerator(e)
              if (acc) {
                void update({ hotkey: { ...settings.hotkey, accelerator: acc } })
                setCapturing(false)
              }
            }}
          >
            {capturing ? 'Appuie sur une touche…' : settings.hotkey.accelerator}
          </button>
        </div>
        {settings.detection.fixedLength === 0 ? (
          <Select
            label="Durée gardée avant l’appui"
            value={settings.hotkey.before}
            options={[15, 30, 45, 60, 90, 120].map((v) => ({ value: v, label: `${v} secondes` }))}
            onChange={(before) => void update({ hotkey: { ...settings.hotkey, before } })}
          />
        ) : (
          <p className="muted small">La durée des clips est fixée à {settings.detection.fixedLength} secondes (section « Durée des clips ») : l’appui garde les {Math.max(1, settings.detection.fixedLength - settings.detection.after)} secondes d’avant et {settings.detection.after} secondes d’après.</p>
        )}
      </Section>

      <Section title="Transcription (sous-titres)">
        <Toggle label="Transcrire automatiquement les nouveaux clips" checked={settings.transcription.enabled} onChange={(enabled) => void update({ transcription: { ...settings.transcription, enabled } })} />
        <Select label="Langue parlée" value={settings.transcription.language} options={LANGS} onChange={(language) => void update({ transcription: { ...settings.transcription, language } })} />
        <Select label="Modèle" value={settings.transcription.model} options={MODELS} onChange={(model) => void update({ transcription: { ...settings.transcription, model } })} />
        <Toggle label="Utiliser une carte graphique NVIDIA" hint="Bien plus rapide (téléchargement d’environ 700 Mo). Réinstalle Whisper après avoir coché." checked={settings.transcription.gpu} onChange={(gpu) => void update({ transcription: { ...settings.transcription, gpu } })} />
      </Section>

      <Section title="Rendu vidéo">
        <Toggle label="Faire le rendu automatiquement" hint="Chaque nouveau clip est monté avec ta patte dès la fin du live" checked={settings.render.auto} onChange={(auto) => void update({ render: { ...settings.render, auto } })} />
        <Select
          label="Images par seconde"
          value={settings.render.fps}
          options={[
            { value: 30, label: '30 i/s (plus rapide)' },
            { value: 60, label: '60 i/s (plus fluide)' }
          ]}
          onChange={(fps) => void update({ render: { ...settings.render, fps } })}
        />
        <Select
          label="Encodeur"
          value={settings.render.encoder}
          options={[
            { value: 'auto', label: `Automatique${deps?.encoder ? ` (${deps.encoder})` : ''}` },
            { value: 'libx264', label: 'Processeur (libx264)' }
          ]}
          onChange={(encoder) => void update({ render: { ...settings.render, encoder } })}
        />
      </Section>

      <Section title="Démarrage">
        <Toggle label="Lancer GoClip avec Windows" hint="Il démarre discrètement dans la barre des tâches pour ne rater aucun live" checked={settings.openAtLogin} onChange={set('openAtLogin')} />
      </Section>
    </div>
  )
}
