// Transcription modifiable mot par mot : clic = aller au mot, double-clic = le corriger,
// ✕ ou Suppr = le supprimer, ＋ = ajouter un mot après. Ou tout retaper en mode texte.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Word } from '../../../shared/types'
import { insertWordAfter, removeWords, replaceRange, replaceWord, retimeWords } from '../../../shared/words'

export function WordsEditor(props: { words: Word[]; start: number; end: number; time: number; onChange: (w: Word[]) => void; onSeek: (t: number) => void }) {
  const { words, start, end } = props
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [textMode, setTextMode] = useState(false)
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const inClip = words.map((w, i) => ({ w, i })).filter(({ w }) => w.end > start && w.start < end)
  const active = inClip.find(({ w }) => props.time >= w.start && props.time < w.end)?.i ?? null

  // La liste change (annuler, autre clip…) : la sélection doit rester valable.
  useEffect(() => {
    if (selected !== null && selected >= words.length) setSelected(null)
    if (editing !== null && editing >= words.length) setEditing(null)
  }, [words.length])

  const edit = (i: number): void => {
    setSelected(i)
    setEditing(i)
    setDraft(words[i].text)
  }
  const commit = (): void => {
    if (editing === null) return
    const i = editing
    setEditing(null)
    if (draft === words[i]?.text) return
    props.onChange(replaceWord(words, i, draft))
    if (!draft.trim()) setSelected(null)
    box.current?.focus()
  }
  const remove = (i: number): void => {
    props.onChange(removeWords(words, [i]))
    const nextSel = inClip.find(({ i: j }) => j > i)?.i
    setSelected(nextSel !== undefined ? nextSel - 1 : null)
  }
  const add = (i: number): void => {
    const r = insertWordAfter(words, i, '…')
    props.onChange(r.words)
    setSelected(r.index)
    setEditing(r.index)
    setDraft('')
  }
  const move = (dir: 1 | -1): void => {
    const pos = inClip.findIndex(({ i }) => i === selected)
    const target = inClip[Math.max(0, Math.min(inClip.length - 1, pos < 0 ? 0 : pos + dir))]
    if (target) {
      setSelected(target.i)
      props.onSeek(target.w.start)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (editing !== null) return
    if (selected === null) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') move(1)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(selected)
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      edit(selected)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Insert' || e.key === '+') {
      e.preventDefault()
      add(selected)
    }
  }

  if (textMode) {
    return (
      <div className="stack">
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <p className="muted small">Retape ou corrige le texte : les mots qui n’ont pas changé gardent leur instant, les nouveaux se placent entre eux.</p>
        <div className="row">
          <button
            className="btn small primary"
            onClick={() => {
              const old = inClip.map(({ w }) => w)
              props.onChange(replaceRange(words, start, end, retimeWords(old, text, start, end)))
              setTextMode(false)
            }}
          >
            Appliquer
          </button>
          <button className="btn small ghost" onClick={() => setTextMode(false)}>
            Annuler
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="row wrap words-tools">
        <button className="btn small" disabled={selected === null} onClick={() => selected !== null && edit(selected)} title="Corriger le mot sélectionné (Entrée ou double-clic)">
          ✏️ Corriger
        </button>
        <button className="btn small" disabled={selected === null} onClick={() => selected !== null && remove(selected)} title="Supprimer le mot sélectionné (Suppr)">
          🗑 Supprimer
        </button>
        <button className="btn small" disabled={selected === null} onClick={() => selected !== null && add(selected)} title="Ajouter un mot après le mot sélectionné (+)">
          ＋ Mot après
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            setText(inClip.map(({ w }) => w.text).join(' '))
            setTextMode(true)
          }}
          title="Modifier tout le texte d’un coup"
        >
          Mode texte
        </button>
      </div>
      {inClip.length === 0 ? (
        <p className="muted small">Personne ne parle dans ce passage.</p>
      ) : (
        <div className="words" ref={box} tabIndex={0} onKeyDown={onKey}>
          {inClip.map(({ w, i }) =>
            editing === i ? (
              <input
                key={i}
                className="word-input"
                value={draft}
                autoFocus
                size={Math.max(3, draft.length + 1)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commit()
                  if (e.key === 'Escape') {
                    setEditing(null)
                    if (!words[i].text.trim() || words[i].text === '…') props.onChange(removeWords(words, [i]))
                    box.current?.focus()
                  }
                }}
              />
            ) : (
              <span
                key={i}
                className={`word ${selected === i ? 'selected' : ''} ${active === i ? 'active' : ''}`}
                onClick={() => {
                  setSelected(i)
                  props.onSeek(w.start)
                  box.current?.focus()
                }}
                onDoubleClick={() => edit(i)}
                title={`${w.start.toFixed(1)} s — double-clic pour corriger`}
              >
                {w.text}
                <button
                  className="word-x"
                  title="Supprimer ce mot"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(i)
                  }}
                >
                  ✕
                </button>
              </span>
            )
          )}
        </div>
      )}
      <p className="muted small">Clic : aller au mot · double-clic ou Entrée : corriger · Suppr : supprimer · + : ajouter après · ← → : mot précédent / suivant</p>
    </div>
  )
}
