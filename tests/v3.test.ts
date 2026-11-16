// Tests de la version 0.3 : intro/outro, mots, publication, file des travaux, migration.
// Lancer : npm test
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configurePaths } from '../src/main/paths'
import { ProcGroup, procContext, run } from '../src/main/proc'
import * as store from '../src/main/store'
import { defaultLook, editSignature, extraTimeline, introBlurRadius, normalizeLook } from '../src/shared/presets'
import { audienceMap, bestSlot, formatCaption, localWeeklySlots, normalizeHashtags, slotScore, toHashtag, upcomingSlots, weekday, type WeeklySlot } from '../src/shared/publishing'
import type { Clip, Look, Word } from '../src/shared/types'
import { insertWordAfter, removeWords, replaceRange, replaceWord, retimeWords } from '../src/shared/words'

let passed = 0
const pending: Promise<void>[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  const done = (err?: unknown): void => {
    if (err) {
      console.log(`✗ ${name}\n   ${(err as Error).message}`)
      process.exitCode = 1
    } else {
      passed++
      console.log(`✓ ${name}`)
    }
  }
  try {
    const r = fn()
    if (r instanceof Promise) pending.push(r.then(() => done(), done))
    else done()
  } catch (e) {
    done(e)
  }
}

const withIntro = (patch: Partial<Look['intro']>, outro: Partial<Look['outro']> = {}): Look => {
  const l = defaultLook()
  return { ...l, intro: { ...l.intro, enabled: true, file: 'i.webm', ...patch }, outro: { ...l.outro, enabled: true, file: 'o.webm', ...outro } }
}

// ---------- Intro / outro ----------

test('intro « pause » : le clip attend, la vidéo s’allonge', () => {
  const t = extraTimeline(withIntro({ mode: 'pause', fade: 0.5 }, { mode: 'pause', fade: 0 }), 20, 3, 2)
  assert.deepEqual([t.padStart, t.padEnd, t.introEnd, t.outroStart, t.total], [3, 2, 3, 23, 25])
  assert.equal(t.fadeIn, 0.5)
  assert.equal(t.fadeOut, 0)
})

test('intro « play » : le clip démarre dessous, même durée', () => {
  const t = extraTimeline(withIntro({ mode: 'play', fade: 1 }, { mode: 'play', fade: 0.4 }), 20, 3, 2)
  assert.deepEqual([t.padStart, t.padEnd, t.introEnd, t.outroStart, t.total], [0, 0, 3, 18, 20])
  assert.equal(t.fadeOut, 0.4)
  // Intro plus longue que le clip : coupée à la fin du clip ; fondu jamais plus long que l'intro.
  const long = extraTimeline(withIntro({ mode: 'play', fade: 2 }), 1.5, 4, 0)
  assert.equal(long.introEnd, 1.5)
  assert.equal(long.fadeIn, 1.5)
  assert.equal(long.total, 1.5)
})

test('sans intro ni outro : rien ne change', () => {
  const t = extraTimeline(defaultLook(), 12, 0, 0)
  assert.deepEqual([t.padStart, t.padEnd, t.introEnd, t.outroStart, t.total], [0, 0, 0, 12, 12])
})

test('anciens montages : intro en pause, flou d’origine, pas de fondu', () => {
  const old = normalizeLook({ intro: { enabled: true, file: 'x.mp4' }, outro: { enabled: false, file: null } })
  assert.deepEqual(old.intro, { enabled: true, file: 'x.mp4', mode: 'pause', blur: 60, fade: 0 })
  assert.equal(introBlurRadius(60), 10)
  assert.equal(introBlurRadius(0), 0)
  const bad = normalizeLook({ intro: { enabled: true, file: 'x', mode: 'nimporte', blur: 500, fade: -3 } })
  assert.deepEqual([bad.intro.mode, bad.intro.blur, bad.intro.fade], ['pause', 100, 0])
})

test('un clip validé avant la mise à jour reste « à jour »', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoclip-test-'))
  try {
    configurePaths({ data: dir, resources: dir })
    // Look tel qu'il était enregistré en 0.2 (intro sans mode / flou / fondu).
    const look = defaultLook() as unknown as Record<string, unknown>
    const oldLook = { ...look, intro: { enabled: true, file: 'intro.webm' }, outro: { enabled: false, file: null } }
    const clip = { id: 'a', look: oldLook, title: 'T', start: 1, end: 9, words: null, renderSig: '', render: { state: 'done', progress: 1, error: null, at: 1 } }
    clip.renderSig = editSignature(clip as unknown as Clip)
    const edited = { ...clip, id: 'b', renderSig: 'ancienne-empreinte' }
    writeFileSync(join(dir, 'clips.json'), JSON.stringify([clip, edited]))
    store.loadStore(dir)
    const [a, b] = store.getClips()
    assert.equal(a.look.intro.mode, 'pause')
    assert.equal(a.renderSig, editSignature(a), 'le rendu validé doit rester à jour')
    assert.equal(b.renderSig, 'ancienne-empreinte', 'un rendu déjà périmé le reste')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- Transcription mot par mot ----------

const W = (text: string, start: number, end: number): Word => ({ text, start, end })
const words = [W('salut', 1, 1.4), W('tout', 1.5, 1.8), W('le', 1.8, 2), W('monde', 2, 2.5), W('ça', 4, 4.3), W('va', 4.3, 4.6)]

test('corriger un mot (et le couper en deux)', () => {
  assert.equal(replaceWord(words, 3, 'MONDE')[3].text, 'MONDE')
  const split = replaceWord(words, 0, 'bon jour')
  assert.equal(split.length, words.length + 1)
  assert.deepEqual([split[0].text, split[1].text], ['bon', 'jour'])
  assert.equal(split[0].start, 1)
  assert.equal(split[1].end, 1.4)
  assert.equal(replaceWord(words, 0, '   ').length, words.length - 1)
})

test('supprimer et ajouter des mots', () => {
  assert.deepEqual(removeWords(words, [1, 2]).map((w) => w.text), ['salut', 'monde', 'ça', 'va'])
  // Silence après « monde » (2,5 → 4) : le mot ajouté s'y place.
  const a = insertWordAfter(words, 3, 'oh')
  assert.equal(a.index, 4)
  assert.deepEqual([a.words[4].text, a.words[4].start], ['oh', 2.5])
  // Pas de silence après « le » : il partage son temps.
  const b = insertWordAfter(words, 2, 'grand')
  assert.equal(b.words[3].text, 'grand')
  assert.ok(b.words[2].end <= b.words[3].start)
})

test('retaper le texte garde l’instant des mots inchangés', () => {
  const out = retimeWords(words, 'salut à tout le monde, ça va bien', 0, 6)
  assert.deepEqual(
    out.map((w) => w.text),
    ['salut', 'à', 'tout', 'le', 'monde,', 'ça', 'va', 'bien']
  )
  assert.equal(out[0].start, 1)
  assert.equal(out[2].start, 1.5)
  assert.equal(out[5].start, 4)
  assert.ok(out[1].start >= 1.4 && out[1].end <= 1.5 + 0.2, 'le mot ajouté se place entre ses voisins')
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].start)
  // Sans repère : répartis selon leur longueur (« un » 2 lettres, « deux » 4 lettres).
  assert.deepEqual(retimeWords([], 'un deux', 2, 3).map((w) => w.start), [2, 2.33])
  const r = replaceRange(words, 1.5, 2.6, [W('X', 1.5, 2)])
  assert.deepEqual(r.map((w) => w.text), ['salut', 'X', 'ça', 'va'])
})

// ---------- Publication ----------

test('hashtags et textes par réseau', () => {
  assert.equal(normalizeHashtags('twitch, #Gaming  fr #gaming'), '#twitch #Gaming #fr')
  assert.equal(toHashtag('Call of Duty: Modern Warfare 4'), '#CallofDutyModernWarfare4')
  assert.equal(toHashtag('Pokémon'), '#Pokemon')
  const yt = formatCaption('youtube', 'Il a pas vu venir le coup 😱\nEn live sur twitch', '#twitch')
  assert.equal(yt.title, 'Il a pas vu venir le coup 😱 #Shorts')
  assert.ok(yt.text.endsWith('#twitch'))
  const long = formatCaption('youtube', 'x'.repeat(150), '')
  assert.ok(long.title!.length <= 100 && long.title!.endsWith('#Shorts'))
  assert.equal(formatCaption('tiktok', 'Salut', '#a').title, null)
})

test('carte d’activité : les heures de live comptent', () => {
  // Lives tous les mardis de 20 h à 23 h pendant 4 semaines.
  const streams = Array.from({ length: 4 }, (_, k) => {
    const d = new Date(2026, 9, 6 + 7 * k, 20, 0, 0) // mardi 6 octobre 2026
    return { start: d.getTime(), end: d.getTime() + 3 * 3600_000 }
  })
  const map = audienceMap(streams)
  assert.equal(weekday(new Date(2026, 9, 6)), 1)
  assert.equal(map[1][20], 1)
  assert.equal(map[1][12], 0)
  // Juste avant le live (18 h) vaut mieux que le même créneau sans live.
  assert.ok(slotScore('tiktok', 1, 18, map) > slotScore('tiktok', 3, 18, map))
  const weekly = localWeeklySlots(map)
  for (const n of ['tiktok', 'instagram', 'youtube'] as const) {
    const mine = weekly.filter((s) => s.network === n)
    assert.equal(mine.length, 6)
    assert.equal(new Set(mine.map((s) => s.day)).size, 6, 'un créneau par jour au plus')
  }
})

test('créneaux à venir : maximum par jour et 3 h d’écart', () => {
  const weekly: WeeklySlot[] = [
    { network: 'tiktok', day: 0, hour: 12, minute: 0, score: 0.8, why: 'midi' },
    { network: 'tiktok', day: 0, hour: 13, minute: 0, score: 0.7, why: 'midi' },
    { network: 'tiktok', day: 0, hour: 19, minute: 0, score: 0.9, why: 'soir' }
  ]
  const monday = new Date(2026, 10, 16, 8, 0, 0).getTime() // lundi 16 novembre 2026, 8 h
  const all = upcomingSlots({ weekly, from: monday, days: 1, posts: [], perDay: 2 })
  assert.equal(all.length, 3)
  const taken = upcomingSlots({ weekly, from: monday, days: 1, posts: [{ at: new Date(2026, 10, 16, 12, 30).getTime(), networks: ['tiktok'] }], perDay: 2 })
  assert.deepEqual(taken.map((s) => new Date(s.at).getHours()), [19])
  const full = upcomingSlots({ weekly, from: monday, days: 1, posts: [{ at: monday + 3600_000, networks: ['tiktok'] }, { at: monday + 2 * 3600_000, networks: ['tiktok'] }], perDay: 2 })
  assert.equal(full.length, 0)
  // Le meilleur créneau : le premier qui vaut au moins 85 % du meilleur.
  const best = bestSlot({ weekly, from: monday, posts: [], perDay: 2, networks: ['tiktok'] })
  assert.equal(new Date(best!.at).getHours(), 12)
})

// ---------- File des travaux : pause ----------

test('pause : un programme ne démarre pas tant que la file est en pause', async () => {
  const group = new ProcGroup()
  await group.suspend()
  let started = false
  const p = procContext.run(group, () => run(process.execPath, ['-e', 'process.exit(0)']).then((r) => ((started = true), r)))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(started, false, 'le programme attend la reprise')
  await group.resume()
  const r = await p
  assert.equal(r.code, 0)
  assert.ok(group.pausedMs() >= 250)
})

test('pause : un programme en cours est vraiment suspendu puis reprend', async () => {
  if (process.platform !== 'win32') return
  const group = new ProcGroup()
  // Petit programme qui compte pendant ~1,5 s de temps réel d'exécution.
  const script = 'let n=0;const t=setInterval(()=>{n++;if(n>=15){clearInterval(t);console.log(n)}},100)'
  const started = Date.now()
  const p = procContext.run(group, () => run(process.execPath, ['-e', script]))
  await new Promise((r) => setTimeout(r, 400))
  await group.suspend()
  await new Promise((r) => setTimeout(r, 1500))
  await group.resume()
  const r = await p
  assert.equal(r.code, 0)
  assert.ok(Date.now() - started >= 2600, `il a dû attendre pendant la pause (${Date.now() - started} ms)`)
})

void Promise.all(pending).then(() => console.log(`\n${passed} test(s) réussi(s)`))
