// Réglages du « look » d'un montage (cadrage, sous-titres, titre, intro, habillage).
// Partagés par l'éditeur de clip et l'éditeur de patte.
import type { ReactNode } from 'react'
import { applySubtitlePreset, FONTS, LAYOUTS, SUBTITLE_PRESETS, suggestedSubtitleY } from '../../../shared/presets'
import type { IntroStyle, Look } from '../../../shared/types'
import { api, fontFamily } from '../api'
import { SourceFramer, type FrameSource } from './Preview'
import { ColorInput, FilePicker, Section, Select, Slider, Toggle } from './ui'

export type LookTab = 'cadrage' | 'sous-titres' | 'titre' | 'intro' | 'habillage'
export const LOOK_TABS: [LookTab, string][] = [
  ['cadrage', 'Cadrage'],
  ['sous-titres', 'Sous-titres'],
  ['titre', 'Titre'],
  ['intro', 'Intro'],
  ['habillage', 'Habillage']
]
const FONT_OPTIONS = FONTS.map((f) => ({ value: f.id, label: f.label }))

function ExtraSection(props: { kind: 'intro' | 'outro'; slot: IntroStyle; onChange: (s: IntroStyle) => void; onPreview?: () => void; previewing: boolean }) {
  const { kind, slot } = props
  const intro = kind === 'intro'
  const set = (patch: Partial<IntroStyle>): void => props.onChange({ ...slot, ...patch })
  return (
    <Section title={intro ? 'Intro (avant chaque clip)' : 'Outro (après chaque clip)'}>
      <Toggle label={intro ? 'Mettre l’intro' : 'Mettre l’outro'} checked={slot.enabled} onChange={(enabled) => set({ enabled })} />
      <FilePicker
        label={`Fichier de l’${kind} (vidéo ou image)`}
        file={slot.file}
        onPick={async () => {
          const f = await api().chooseFile('media')
          if (f) set({ enabled: true, file: f })
        }}
        onClear={() => set({ enabled: false, file: null })}
      />
      {slot.enabled && slot.file && (
        <>
          <div className="field">
            <span className="field-label">{intro ? 'Pendant l’intro' : 'Pendant l’outro'}</span>
            <div className="choice">
              <button className={slot.mode === 'pause' ? 'active' : ''} onClick={() => set({ mode: 'pause' })}>
                ⏸ {intro ? 'Le clip attend' : 'Image figée'}
                <small>{intro ? 'Sa première image reste figée derrière, il démarre après' : 'La dernière image du clip reste figée derrière'}</small>
              </button>
              <button className={slot.mode === 'play' ? 'active' : ''} onClick={() => set({ mode: 'play' })}>
                ▶ {intro ? 'Le clip démarre dessous' : 'Sur la fin du clip'}
                <small>{intro ? 'L’intro passe sur le début du clip, qui joue déjà' : 'L’outro passe pendant les dernières secondes du clip'}</small>
              </button>
            </div>
          </div>
          <Slider label="Flou du clip derrière" value={slot.blur} min={0} max={100} step={5} format={(v) => (v === 0 ? 'Aucun' : `${v} %`)} onChange={(blur) => set({ blur })} />
          <Slider
            label={intro ? 'Fondu vers le clip' : 'Fondu depuis le clip'}
            value={Math.round(slot.fade * 10)}
            min={0}
            max={20}
            format={(v) => (v === 0 ? 'Coupe franche' : `${(v / 10).toFixed(1).replace('.', ',')} s`)}
            onChange={(v) => set({ fade: v / 10 })}
          />
          {props.onPreview && (
            <button className="btn small" onClick={props.onPreview} disabled={props.previewing}>
              {props.previewing ? 'Aperçu en cours…' : `▶ Aperçu de l’${kind}`}
            </button>
          )}
        </>
      )}
    </Section>
  )
}

export function LookTabContent(props: {
  tab: LookTab
  look: Look
  setLook: (fn: (l: Look) => Look) => void
  /** Image du live pour placer les zones caméra / jeu. */
  source: FrameSource | null
  /** Texte du titre (titre du clip, ou exemple pour une patte). */
  title: string
  onTitle: (t: string) => void
  /** Section « Texte » des sous-titres (transcription du clip) ; absente pour une patte. */
  wordsSection?: ReactNode
  onPreviewIntro?: (kind: 'intro' | 'outro') => void
  previewing?: 'intro' | 'outro' | null
}) {
  const { look, setLook } = props
  switch (props.tab) {
    case 'cadrage':
      return (
        <>
          <Section title="Mise en page">
            <div className="layout-grid">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  className={`layout-card ${look.framing.layout === l.id ? 'active' : ''}`}
                  onClick={() => setLook((x) => ({ ...x, framing: { ...x.framing, layout: l.id }, subtitles: { ...x.subtitles, y: suggestedSubtitleY({ ...x.framing, layout: l.id }) } }))}
                  title={l.hint}
                >
                  <span className={`layout-icon ${l.id}`} />
                  {l.label}
                </button>
              ))}
            </div>
          </Section>
          {look.framing.layout !== 'horizontal' && (
            <Section title="Zones de l’image">
              <p className="muted small">Déplace et redimensionne les cadres sur l’image du live. Les pointillés montrent ce qui sera vraiment gardé.</p>
              <SourceFramer video={props.source} framing={look.framing} width={340} onChange={(framing) => setLook((x) => ({ ...x, framing }))} />
              {look.framing.layout === 'camera-game' && (
                <>
                  <Slider label="Hauteur de la caméra" value={look.framing.split} min={400} max={1400} step={10} format={(v) => `${Math.round((v / 1920) * 100)} %`} onChange={(split) => setLook((x) => ({ ...x, framing: { ...x.framing, split } }))} />
                  <Toggle label="Caméra en haut" checked={look.framing.cameraOnTop} onChange={(cameraOnTop) => setLook((x) => ({ ...x, framing: { ...x.framing, cameraOnTop } }))} />
                </>
              )}
            </Section>
          )}
        </>
      )

    case 'sous-titres':
      return (
        <>
          <Toggle label="Sous-titres" hint="Le texte de ce qui est dit, mot par mot" checked={look.subtitles.enabled} onChange={(enabled) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, enabled } }))} />
          {look.subtitles.enabled && (
            <>
              {props.wordsSection}
              <Section title="Style">
                <div className="preset-grid">
                  {SUBTITLE_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={`preset ${look.subtitles.preset === p.id ? 'active' : ''}`}
                      onClick={() => setLook((x) => ({ ...x, subtitles: applySubtitlePreset(x.subtitles, p.id) }))}
                      style={{ fontFamily: fontFamily(p.font), color: p.base, WebkitTextStroke: `${Math.max(1, p.outline / 3)}px ${p.outlineColor}` }}
                    >
                      <span style={{ color: p.color }}>{p.uppercase ? 'TROP' : 'Trop'}</span> {p.uppercase ? 'FORT' : 'fort'}
                      <small>{p.label}</small>
                    </button>
                  ))}
                </div>
              </Section>
              <Section title="Réglages fins">
                <Select label="Police" value={look.subtitles.font} options={FONT_OPTIONS} onChange={(font) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, font } }))} />
                <Slider label="Taille" value={look.subtitles.size} min={36} max={160} onChange={(size) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, size } }))} />
                <Slider label="Position verticale" value={Math.round(look.subtitles.y * 100)} min={5} max={95} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, y: v / 100 } }))} />
                <Slider label="Mots affichés ensemble" value={look.subtitles.words} min={1} max={8} onChange={(words) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, words } }))} />
                <div className="two">
                  <ColorInput label="Mot prononcé" value={look.subtitles.color} onChange={(color) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, color } }))} />
                  <ColorInput label="Autres mots" value={look.subtitles.base} onChange={(base) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, base } }))} />
                </div>
                <div className="two">
                  <ColorInput label="Contour" value={look.subtitles.outlineColor} onChange={(outlineColor) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, outlineColor } }))} />
                  <Slider label="Épaisseur" value={look.subtitles.outline} min={0} max={14} onChange={(outline) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, outline } }))} />
                </div>
                <Slider label="Ombre" value={look.subtitles.shadow} min={0} max={10} onChange={(shadow) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, shadow } }))} />
                <Slider label="Zoom du mot prononcé" value={Math.round(look.subtitles.pop * 100)} min={100} max={140} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, pop: v / 100 } }))} />
                <Toggle label="Majuscules" checked={look.subtitles.uppercase} onChange={(uppercase) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, uppercase } }))} />
                <Toggle label="Effet karaoké" hint="Les mots déjà dits restent en couleur" checked={look.subtitles.karaoke} onChange={(karaoke) => setLook((x) => ({ ...x, subtitles: { ...x.subtitles, karaoke } }))} />
              </Section>
            </>
          )}
        </>
      )

    case 'titre':
      return (
        <>
          <Toggle label="Titre d’accroche" hint="Une phrase affichée en haut de la vidéo" checked={look.title.enabled} onChange={(enabled) => setLook((x) => ({ ...x, title: { ...x.title, enabled } }))} />
          {look.title.enabled && (
            <Section title="Titre">
              <label className="field">
                <span className="field-label">Texte (le même que le titre du clip)</span>
                <textarea rows={2} value={props.title} onChange={(e) => props.onTitle(e.target.value)} placeholder="Ex : IL A PAS VU VENIR LE COUP 😱" />
              </label>
              <Select label="Police" value={look.title.font} options={FONT_OPTIONS} onChange={(font) => setLook((x) => ({ ...x, title: { ...x.title, font } }))} />
              <Slider label="Taille" value={look.title.size} min={32} max={120} onChange={(size) => setLook((x) => ({ ...x, title: { ...x.title, size } }))} />
              <Slider label="Position verticale" value={Math.round(look.title.y * 100)} min={5} max={95} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, title: { ...x.title, y: v / 100 } }))} />
              <div className="two">
                <ColorInput label="Lettres" value={look.title.color} onChange={(color) => setLook((x) => ({ ...x, title: { ...x.title, color } }))} />
                <ColorInput label="Bandeau" value={look.title.background} onChange={(background) => setLook((x) => ({ ...x, title: { ...x.title, background } }))} />
              </div>
              <Toggle label="Bandeau de couleur derrière le texte" checked={look.title.band} onChange={(band) => setLook((x) => ({ ...x, title: { ...x.title, band } }))} />
              <Slider label="Durée d’affichage" value={look.title.duration} min={0} max={15} format={(v) => (v === 0 ? 'Tout le clip' : `${v} s`)} onChange={(duration) => setLook((x) => ({ ...x, title: { ...x.title, duration } }))} />
            </Section>
          )}
        </>
      )

    case 'intro':
      return (
        <>
          <ExtraSection kind="intro" slot={look.intro} onChange={(intro) => setLook((x) => ({ ...x, intro }))} onPreview={props.onPreviewIntro && (() => props.onPreviewIntro!('intro'))} previewing={props.previewing === 'intro'} />
          <ExtraSection kind="outro" slot={look.outro} onChange={(outro) => setLook((x) => ({ ...x, outro }))} onPreview={props.onPreviewIntro && (() => props.onPreviewIntro!('outro'))} previewing={props.previewing === 'outro'} />
          <p className="muted small">
            Une vidéo transparente (WebM VP9 avec alpha, MOV ProRes 4444, PNG, GIF) laisse voir le clip à travers. Le flou ne concerne que le clip derrière l’intro ; le fondu fait disparaître l’intro (et le flou) en douceur. Une image fixe reste 3 secondes.
          </p>
          <p className="muted small">Mets l’intro dans ta patte pour qu’elle soit sur tous tes clips. « Aperçu » la montre tout de suite ; « Valider » puis « Rendu final » montre la vraie vidéo.</p>
        </>
      )

    case 'habillage':
      return (
        <>
          <Section title="Logo / filigrane">
            <Toggle label="Afficher un logo" checked={look.logo.enabled} onChange={(enabled) => setLook((x) => ({ ...x, logo: { ...x.logo, enabled } }))} />
            <FilePicker
              label="Image (PNG transparent conseillé)"
              file={look.logo.file}
              onPick={async () => {
                const f = await api().chooseFile('image')
                if (f) setLook((x) => ({ ...x, logo: { ...x.logo, enabled: true, file: f } }))
              }}
              onClear={() => setLook((x) => ({ ...x, logo: { ...x.logo, enabled: false, file: null } }))}
            />
            {look.logo.enabled && (
              <>
                <Slider label="Taille" value={Math.round(look.logo.width * 100)} min={5} max={60} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, logo: { ...x.logo, width: v / 100 } }))} />
                <Slider label="Position horizontale" value={Math.round(look.logo.x * 100)} min={0} max={100} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, logo: { ...x.logo, x: v / 100 } }))} />
                <Slider label="Position verticale" value={Math.round(look.logo.y * 100)} min={0} max={100} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, logo: { ...x.logo, y: v / 100 } }))} />
                <Slider label="Opacité" value={Math.round(look.logo.opacity * 100)} min={10} max={100} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, logo: { ...x.logo, opacity: v / 100 } }))} />
              </>
            )}
          </Section>
          <Section title="Son">
            <Slider label="Volume du live" value={Math.round(look.sourceVolume * 100)} min={0} max={200} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, sourceVolume: v / 100 }))} />
            <Toggle label="Musique de fond" checked={look.music.enabled} onChange={(enabled) => setLook((x) => ({ ...x, music: { ...x.music, enabled } }))} />
            <FilePicker
              label="Musique"
              file={look.music.file}
              onPick={async () => {
                const f = await api().chooseFile('audio')
                if (f) setLook((x) => ({ ...x, music: { ...x.music, enabled: true, file: f } }))
              }}
              onClear={() => setLook((x) => ({ ...x, music: { ...x.music, enabled: false, file: null } }))}
            />
            {look.music.enabled && <Slider label="Volume de la musique" value={Math.round(look.music.volume * 100)} min={0} max={100} format={(v) => `${v} %`} onChange={(v) => setLook((x) => ({ ...x, music: { ...x.music, volume: v / 100 } }))} />}
          </Section>
        </>
      )
  }
}
