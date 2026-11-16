import { useState } from 'react'
import { LAYOUTS, SUBTITLE_PRESETS } from '../../../shared/presets'
import type { Template } from '../../../shared/types'
import { api, fontFamily } from '../api'
import { Empty, Pill } from '../components/ui'
import { useClips, useSettings, useTemplates } from '../hooks'

function TemplateCard({ t, isDefault, channels, clipCount }: { t: Template; isDefault: boolean; channels: string[]; clipCount: number }) {
  const [clips] = useClips()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(t.name)
  const sub = t.look.subtitles
  const preset = SUBTITLE_PRESETS.find((p) => p.id === sub.preset)
  const extras = [
    t.look.intro.enabled && 'Intro',
    t.look.outro.enabled && 'Outro',
    t.look.title.enabled && 'Titre',
    t.look.logo.enabled && 'Logo',
    t.look.music.enabled && 'Musique'
  ].filter(Boolean) as string[]
  return (
    <div className="card template">
      <div className="template-sample" style={{ fontFamily: fontFamily(sub.font), color: sub.base, WebkitTextStroke: `${Math.max(1, sub.outline / 3)}px ${sub.outlineColor}` }}>
        {sub.enabled ? (
          <>
            <span style={{ color: sub.color }}>{sub.uppercase ? 'C’EST' : 'C’est'}</span> {sub.uppercase ? 'MON STYLE' : 'mon style'}
          </>
        ) : (
          <span className="muted">Sans sous-titres</span>
        )}
      </div>
      <div className="template-body">
        {renaming ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void api().updateTemplate(t.id, { name })
              setRenaming(false)
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <button className="btn small primary">OK</button>
          </form>
        ) : (
          <h3>
            {t.name} {isDefault && <Pill tone="accent">Par défaut</Pill>}
          </h3>
        )}
        <div className="chips">
          <Pill>{LAYOUTS.find((l) => l.id === t.look.framing.layout)?.label}</Pill>
          {sub.enabled && <Pill>Sous-titres {preset?.label ?? ''}</Pill>}
          {extras.map((x) => (
            <Pill key={x}>{x}</Pill>
          ))}
        </div>
        <p className="muted small">
          {channels.length > 0 ? `Chaînes : ${channels.join(', ')}` : isDefault ? 'Utilisée par toutes les chaînes sans patte' : 'Utilisée par aucune chaîne'} · {clipCount} clip(s)
        </p>
        <div className="row wrap">
          <button className="btn small primary" onClick={() => (window.location.hash = `#/patte/${t.id}`)} title="Modifier cette patte sur une fausse image de stream">
            ✏️ Modifier
          </button>
          <button className="btn small" onClick={() => void api().setDefaultTemplate(isDefault ? null : t.id)}>
            {isDefault ? 'Ne plus utiliser par défaut' : 'Utiliser par défaut'}
          </button>
          <button
            className="btn small"
            onClick={() => {
              // Les clips terminés (Rendus) ne sont pas touchés : seulement ceux à trier et gardés.
              const targets = clips.filter((c) => c.status === 'new' || c.status === 'kept')
              if (confirm(`Appliquer « ${t.name} » à ${targets.length} clip(s) à trier ou gardés ? Ceux déjà validés seront refaits. Les clips terminés ne changent pas.`))
                void api().applyLook(targets.map((c) => c.id), t.look, t.id, false)
            }}
          >
            Appliquer aux clips en cours
          </button>
          <button className="btn small ghost" onClick={() => setRenaming(true)}>
            Renommer
          </button>
          <button
            className="btn small ghost danger"
            onClick={() => {
              if (confirm(`Supprimer la patte « ${t.name} » ? Les clips gardent leur montage actuel.`)) void api().deleteTemplate(t.id)
            }}
          >
            Supprimer
          </button>
        </div>
      </div>
    </div>
  )
}

export function TemplatesPage() {
  const [templates] = useTemplates()
  const [settings] = useSettings()
  const [clips] = useClips()
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Pattes</h1>
          <p className="muted">Une patte est ton montage type. Elle s’applique automatiquement à chaque nouveau clip (par chaîne ou partout).</p>
        </div>
        <button className="btn primary" onClick={() => (window.location.hash = '#/patte/nouvelle')}>
          ＋ Nouvelle patte
        </button>
      </header>
      <div className="hint-box">
        <b>Créer ou modifier une patte</b>
        <span>« Nouvelle patte » ouvre une fausse image de stream (jeu + caméra) : règle le cadrage, les sous-titres, l’intro… sans avoir de clip. Tu peux aussi partir d’une capture de ton stream, ou monter un clip et l’enregistrer comme patte (onglet « Patte » de l’éditeur).</span>
      </div>
      {templates.length === 0 ? (
        <Empty title="Pas encore de patte" icon="🎨">
          Sans patte, les nouveaux clips prennent le style de base (jeu sur fond flou + sous-titres Classique).
        </Empty>
      ) : (
        <div className="grid templates">
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              t={t}
              isDefault={settings?.defaultTemplateId === t.id}
              channels={settings?.channels.filter((c) => c.templateId === t.id).map((c) => c.displayName ?? c.login) ?? []}
              clipCount={clips.filter((c) => c.templateId === t.id).length}
            />
          ))}
        </div>
      )}
    </div>
  )
}
