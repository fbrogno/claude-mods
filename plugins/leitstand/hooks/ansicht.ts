// Die Ansicht als reines Datenmodell: Zeilen aus farbigen Textstücken mit fester Breite, dazu Zellraster (Ring, Crew).
// Nichts hier berührt die Engine; register.tsx macht daraus Elemente. So lässt sich alles ohne Sitzung prüfen.

import type { LeitstandAgent, LeitstandSitzung, LeitstandZaehler, LeitstandZiel, LeitstandZustand } from '../types'
import { FARBEN, RING_SPALTEN, RING_ZEILEN, STANDARD, ringZellen, crewHoehe, crewZellen, jeBand, modellFarbe } from './clawd'
import type { Figur, MannZustand, Zellen } from './clawd'
import {
  cacheErsparnis,
  cacheStand,
  dauer,
  dollar,
  eingabeGesamt,
  ganzzahl,
  istAktiv,
  kuerzen,
  limitName,
  limitsJeProfil,
  modelleSumme,
  modellFamilie,
  prozent,
  resetZeit,
  sichtbareAgents,
  sortieren,
  summen,
  tokens,
  trefferQuote,
  uhr,
  vorZeit,
  zaehlBeginnNotiz,
  zaehlerSumme,
  zustandJetzt,
} from './logik'

/** Ab dieser Breite gilt das volle Layout, darunter das kompakte. */
export const VOLL_AB = 56
export const MIN_BREITE = 24

export type Seg = { t: string; c?: string; dim?: boolean; b?: boolean }
export type KnopfZiel =
  | { was: 'alle' }
  | { was: 'sitzung'; id: string }
  | { was: 'haupt'; sitzungId: string }
  | { was: 'agent'; sitzungId: string; id: string }

export type Zeile =
  | { art: 'text'; segs: Seg[] }
  | { art: 'knopf'; key: string; ziel: KnopfZiel; segs: Seg[] }
  | { art: 'raster'; key: string; raster: Zellen }
  | { art: 'block'; key: string; links: Seg[][]; raster: Zellen; rechts: Seg[][] }
  | { art: 'aktionen'; ziel: LeitstandZiel; darfNachricht: boolean; darfStopp: boolean; stoppBitte: boolean; einrueck: number }
  | { art: 'eingabe'; ziel: LeitstandZiel; einrueck: number }

export type AnsichtDaten = {
  jetzt: number
  breite: number
  /** Zeilen, die das Pane zeigen kann (null: unbekannt). */
  hoehe: number | null
  eigeneId: string
  /** Alle Sitzungen von heute (laufende und beendete), die eigene mit dem Live-Stand. */
  sitzungen: LeitstandSitzung[]
  auswahl: string | null
  aktion: LeitstandZiel | null
  eingabe: LeitstandZiel | null
  stoppBitte: { ziel: string; bis: number } | null
  meldung: string
  /** Kann die Fläche Raster zeichnen (nur das Terminal)? */
  raster: boolean
  bildMs: number
}

export type Ansicht = {
  zeilen: Zeile[]
  /** Der animierte Crew-Streifen, falls gezeichnet. */
  crew: { key: string; figuren: Figur[]; spalten: number } | null
}

// ---- Text-Bausteine ----------------------------------------------------------------------------------

const S = (t: string, o: Omit<Seg, 't'> = {}): Seg => ({ t, ...o })
const W = (t: string): number => Array.from(t).length
export const segBreite = (segs: Seg[]): number => segs.reduce((n, s) => n + W(s.t), 0)
const leerzeichen = (n: number): Seg[] => (n > 0 ? [S(' '.repeat(n))] : [])

/** Auf genau `breite` Zellen bringen: zu lange Stücke werden mit „…" gekürzt, zu kurze aufgefüllt. */
export function passend(segs: Seg[], breite: number, ausr: 'l' | 'r' | 'm' = 'l'): Seg[] {
  if (breite <= 0) return []
  const aus: Seg[] = []
  let rest = breite
  for (const s of segs) {
    if (rest <= 0) break
    const z = Array.from(s.t)
    if (z.length <= rest) {
      aus.push(s)
      rest -= z.length
    } else {
      aus.push({ ...s, t: rest === 1 ? '…' : `${z.slice(0, rest - 1).join('')}…` })
      rest = 0
    }
  }
  if (rest <= 0) return aus
  if (ausr === 'r') return [...leerzeichen(rest), ...aus]
  if (ausr === 'm') return [...leerzeichen(Math.floor(rest / 2)), ...aus, ...leerzeichen(rest - Math.floor(rest / 2))]
  return [...aus, ...leerzeichen(rest)]
}

const reihe = (...teile: Seg[][]): Seg[] => teile.flat()

/** Linie mit Titel: „── TITEL ───────────". */
function abschnittsKopf(titel: string, breite: number, rechts = ''): Seg[] {
  const links = [S('── ', { dim: true }), S(titel, { b: true }), S(' ')]
  const ende = rechts ? [S(' '), S(rechts, { dim: true }), S(' ──', { dim: true })] : []
  const fuell = breite - segBreite(links) - segBreite(ende)
  if (fuell < 2) return passend([...links, S('─'.repeat(Math.max(0, fuell)), { dim: true })], breite)
  return passend([...links, S('─'.repeat(fuell), { dim: true }), ...ende], breite)
}

const linie = (breite: number): Seg[] => [S('─'.repeat(Math.max(0, breite)), { dim: true })]

type Rahmen = { farbe?: string; dim?: boolean }

/** Oberer Strich einer Karte mit Titel: „╭ Titel ─────╮" in der Breite `breite`. */
function kartenKopf(titel: string, breite: number, stil: Rahmen): Seg[] {
  const r = (t: string) => S(t, { c: stil.farbe, dim: stil.dim })
  return passend([r('╭ '), S(titel, { b: true }), r(` ${'─'.repeat(Math.max(0, breite - W(titel) - 4))}╮`)], breite)
}

/** Rahmen um Zeilen gleicher Innenbreite (Breite − 4); optional mit Titel im oberen Strich. */
function rahmen(inhalt: Seg[][], breite: number, stil: Rahmen, titel?: string): Zeile[] {
  const r = (t: string) => S(t, { c: stil.farbe, dim: stil.dim })
  const oben: Seg[] = titel
    ? passend([r('╭ '), S(titel, { b: true }), r(` ${'─'.repeat(Math.max(0, breite - W(titel) - 4))}╮`)], breite)
    : [r(`╭${'─'.repeat(breite - 2)}╮`)]
  const zeilen: Zeile[] = [{ art: 'text', segs: oben }]
  for (const i of inhalt) zeilen.push({ art: 'text', segs: reihe([r('│ ')], passend(i, breite - 4), [r(' │')]) })
  zeilen.push({ art: 'text', segs: [r(`╰${'─'.repeat(breite - 2)}╯`)] })
  return zeilen
}

// ---- Spalten-Wahl -------------------------------------------------------------------------------------------

type Spalte = { id: string; min: number; max?: number; flex?: boolean; /** bekommt, was nach den Höchstwerten übrig ist */ rest?: boolean; prio: number }

/** Welche Spalten bei `breite` passen (niedrigste Priorität fällt zuerst weg) und wie breit; Rest geht an die flexiblen. */
function waehle(spalten: Spalte[], breite: number, luecke = 1): Map<string, number> {
  const aktiv = [...spalten]
  const belegt = () => aktiv.reduce((n, s) => n + s.min, 0) + Math.max(0, aktiv.length - 1) * luecke
  while (aktiv.length > 1 && belegt() > breite) {
    let schwach = 0
    aktiv.forEach((s, i) => {
      if (s.prio < aktiv[schwach]!.prio) schwach = i
    })
    aktiv.splice(schwach, 1)
  }
  const breiten = new Map(aktiv.map(s => [s.id, s.min]))
  let frei = breite - belegt()
  // zuerst die flexiblen Spalten bis zu ihrem Höchstwert, in Reihenfolge
  for (const s of aktiv) {
    if (frei <= 0) break
    if (!s.flex) continue
    const mehr = Math.min(frei, (s.max ?? 999) - s.min)
    breiten.set(s.id, s.min + mehr)
    frei -= mehr
  }
  // was nach den Höchstwerten übrig ist, bekommt die Spalte mit `rest` (sonst die erste flexible)
  if (frei > 0) {
    const ziel = aktiv.find(s => s.rest) ?? aktiv.find(s => s.flex)
    if (ziel) breiten.set(ziel.id, (breiten.get(ziel.id) ?? 0) + frei)
  }
  return breiten
}

function zeileAus(spalten: Spalte[], breiten: Map<string, number>, zellen: Record<string, { segs: Seg[]; ausr?: 'l' | 'r' | 'm' }>, luecke = 1): Seg[] {
  const teile: Seg[][] = []
  for (const s of spalten) {
    const b = breiten.get(s.id)
    if (!b) continue
    const z = zellen[s.id] ?? { segs: [] }
    teile.push(passend(z.segs, b, z.ausr ?? 'l'))
  }
  const aus: Seg[] = []
  teile.forEach((t, i) => {
    if (i > 0 && luecke > 0) aus.push(S(' '.repeat(luecke)))
    aus.push(...t)
  })
  return aus
}

// ---- Zustände ------------------------------------------------------------------------------------------------

type ZustandsText = { icon: string; wort: string; c: string; dim?: boolean; b?: boolean }

function zustandsText(z: LeitstandZustand, seit: number, jetzt: number): ZustandsText {
  switch (z) {
    case 'arbeitet':
      return { icon: '●', wort: 'arbeitet', c: FARBEN.sonnet }
    case 'wartet':
      return { icon: '?', wort: `wartet ${vorZeit(jetzt - seit)}`, c: FARBEN.akzent }
    case 'braucht':
      return { icon: '!', wort: 'braucht dich', c: FARBEN.warnung, b: true }
    case 'abgebrochen':
      return { icon: '✗', wort: 'abgebrochen', c: FARBEN.warnung }
    case 'fehler':
      return { icon: '✗', wort: 'Fehler', c: FARBEN.fehler }
    case 'ruht':
      return { icon: 'z', wort: `ruht ${vorZeit(jetzt - seit)}`, c: FARBEN.grau, dim: true }
  }
}

function mannZustand(z: LeitstandZustand): MannZustand {
  switch (z) {
    case 'arbeitet':
      return 'arbeitet'
    case 'braucht':
      return 'braucht'
    case 'fehler':
      return 'fehler'
    case 'ruht':
      return 'ruht'
    default:
      return 'wartet'
  }
}

function agentMannZustand(a: LeitstandAgent): MannZustand {
  return a.stand === 'laeuft' ? 'arbeitet' : a.stand === 'wartet' ? 'wartet' : a.stand === 'fertig' ? 'fertig' : 'fehler'
}

/** Kurzname der Modellfamilie für Tabellen („opus"). */
const famName = (modell: string) => modell.split(' ')[0] ?? modell

/** Eindeutige Anzeigenamen: zwei Sitzungen im selben Ordner bekommen ein Kürzel der ID. */
function anzeigeNamen(liste: LeitstandSitzung[]): Map<string, string> {
  const zaehl = new Map<string, number>()
  for (const s of liste) zaehl.set(s.projekt, (zaehl.get(s.projekt) ?? 0) + 1)
  return new Map(liste.map(s => [s.sessionId, (zaehl.get(s.projekt) ?? 0) > 1 ? `${s.projekt} ·${s.sessionId.slice(0, 4)}` : s.projekt]))
}

/** Farbe des leeren Balkenteils (dunkel, aber auf dunklem Grund sichtbar). */
const BALKEN_REST = '#4B5563'

const balken = (anteil: number, n: number, voll: string, leer: string): string => {
  const f = Math.max(0, Math.min(n, Math.round(anteil * n)))
  return voll.repeat(f) + leer.repeat(n - f)
}

// ---- Die Ansicht ------------------------------------------------------------------------------------------------

type Abschnitt = { id: string; zeilen: Zeile[] }

/** Entfall-Reihenfolge, wenn das Pane niedriger ist als der Inhalt: zuerst die letzten dieser Liste. */
const ENTFALL = ['fuss', 'modelle', 'limits', 'karte', 'cache', 'sprites']

export function baueAnsicht(d: AnsichtDaten): Ansicht {
  const B = Math.max(10, Math.floor(d.breite))
  if (B < MIN_BREITE) {
    return { zeilen: [{ art: 'text', segs: passend([S('Pane zu schmal', { dim: true })], B) }], crew: null }
  }
  const voll = B >= VOLL_AB
  const ring = d.raster && voll
  const sprites = d.raster && voll
  const jetzt = d.jetzt

  const alle = d.sitzungen
  const eigene = alle.find(s => s.sessionId === d.eigeneId) ?? null
  const gewaehlt = d.auswahl ? (alle.find(s => s.sessionId === d.auswahl) ?? null) : null
  const umfang = gewaehlt ? [gewaehlt] : alle
  const namen = anzeigeNamen(alle)
  const name = (s: LeitstandSitzung) => namen.get(s.sessionId) ?? s.projekt
  const sum = summen(alle, jetzt)
  const aktive = sortieren(
    alle.filter(s => s.sessionId === d.eigeneId || istAktiv(s, jetzt)),
    d.eigeneId,
    jetzt,
  )

  const abschnitte: Abschnitt[] = []
  const neu = (id: string, zeilen: Zeile[]) => {
    if (zeilen.length > 0) abschnitte.push({ id, zeilen })
  }
  const text = (segs: Seg[]): Zeile => ({ art: 'text', segs: passend(segs, B) })

  // ---- Kopf --------------------------------------------------------------------------------------
  {
    const inner = B - 4
    const kosten = sum.kostenHeute === null ? '–' : dollar(sum.kostenHeute)
    const agentsWort = (n: number, kurz: boolean) => (kurz ? `${n} Ag.` : `${n} ${n === 1 ? 'Agent' : 'Agents'}`)
    const varianten: Seg[][] = [
      reihe([S(`${sum.aktiv} aktiv`), S(' · ', { dim: true }), S(agentsWort(sum.agentsLaufen, false)), S(' · ', { dim: true }), S('heute ', { dim: true }), S(kosten, { b: true })]),
      reihe([S(`${sum.aktiv} aktiv`), S(' · ', { dim: true }), S(agentsWort(sum.agentsLaufen, true)), S(' · ', { dim: true }), S(kosten, { b: true })]),
      reihe([S(`${sum.aktiv} akt.`), S(' · ', { dim: true }), S(kosten, { b: true })]),
      [S(kosten, { b: true })],
    ]
    const titel = [S('◆ ', { c: FARBEN.akzent }), S('LEITSTAND', { c: FARBEN.akzent, b: true })]
    const uhrSeg = [S(uhr(jetzt), { dim: true })]
    let inhalt: Seg[] = passend(titel, inner)
    for (const mitUhr of [true, false]) {
      let gefunden = false
      for (const v of varianten) {
        const fest = segBreite(titel) + 2 + segBreite(v) + (mitUhr ? 2 + segBreite(uhrSeg) : 0)
        if (fest <= inner) {
          const luecke = inner - segBreite(titel) - 2 - segBreite(v) - (mitUhr ? segBreite(uhrSeg) : 0)
          inhalt = reihe(titel, leerzeichen(2), v, leerzeichen(luecke), mitUhr ? uhrSeg : [])
          gefunden = true
          break
        }
      }
      if (gefunden) break
    }
    neu('kopf', rahmen([inhalt], B, { farbe: FARBEN.akzent }))
    if (d.meldung) neu('meldung', [text([S(d.meldung, { c: FARBEN.warnung })])])
  }

  if (alle.length === 0) {
    const hinweis = 'Noch keine Sitzung gemeldet. Sobald eine Sitzung mit der Mod „leitstand“ läuft, erscheint sie hier.'
    const zeilen: Zeile[] = []
    const zz = Array.from(hinweis)
    for (let i = 0; i < zz.length; i += B - 2) zeilen.push(text([S(' '), S(zz.slice(i, i + B - 2).join(''), { dim: true })]))
    neu('leer', zeilen)
    return { zeilen: abschnitte.flatMap(a => a.zeilen), crew: null }
  }

  // ---- Kacheln -----------------------------------------------------------------------------------
  const z = zaehlerSumme(umfang)
  const gezaehlt = z.anfragen > 0
  const zuWert = (n: number, f: (n: number) => string) => (gezaehlt ? f(n) : '–')
  const kacheln = [
    { zahl: zuWert(z.anfragen, ganzzahl), name: 'Anfragen', c: '#A78BFA' },
    { zahl: zuWert(z.eingabe, tokens), name: 'Eingabe neu', c: '#60A5FA' },
    { zahl: zuWert(z.cacheLesen, tokens), name: 'Cache lesen', c: '#4ADE80' },
    { zahl: zuWert(z.ausgabe, tokens), name: 'Ausgabe', c: '#FACC15' },
  ]
  {
    const proReihe = voll ? 4 : 2
    const zeilen: Zeile[] = []
    for (let start = 0; start < kacheln.length; start += proReihe) {
      const gruppe = kacheln.slice(start, start + proReihe)
      const basis = Math.floor(B / gruppe.length)
      const breiten = gruppe.map((_, i) => basis + (i < B - basis * gruppe.length ? 1 : 0))
      const teile = gruppe.map((k, i) => {
        const w = breiten[i]!
        const r = (t: string) => S(t, { c: k.c })
        return [
          [r(`╭${'─'.repeat(w - 2)}╮`)],
          reihe([r('│')], passend([S(k.zahl, { c: k.c, b: true })], w - 2, 'm'), [r('│')]),
          reihe([r('│')], passend([S(k.name, { dim: true })], w - 2, 'm'), [r('│')]),
          [r(`╰${'─'.repeat(w - 2)}╯`)],
        ]
      })
      for (let r = 0; r < 4; r++) zeilen.push({ art: 'text', segs: teile.flatMap(t => t[r]!) })
    }
    neu('kacheln', zeilen)
  }

  // ---- Cache-Treffer-Leiste ---------------------------------------------------------------------------
  {
    const q = gezaehlt ? trefferQuote(z) : null
    const umfangText = gewaehlt ? name(gewaehlt) : 'alle Sitzungen'
    const pct = q === null ? '–' : prozent(q)
    const kopf = 'Cache-Treffer'
    const rest = B - 1 - W(kopf) - 1 - 1 - Math.max(5, W(pct) + 1)
    const mitUmfang = rest - 2 - W(umfangText) >= 12
    const bw = Math.max(4, mitUmfang ? rest - 2 - W(umfangText) : rest)
    const anteil = q === null ? 0 : q / 100
    const f = Math.max(0, Math.min(bw, Math.round(anteil * bw)))
    const segs = reihe(
      [S(' '), S(kopf, { dim: true }), S(' ')],
      [S('▄'.repeat(f), { c: FARBEN.gut }), S('▄'.repeat(bw - f), { c: BALKEN_REST })],
      passend([S(pct, { b: true })], Math.max(5, W(pct) + 1), 'r'),
      mitUmfang ? [S('  '), S(umfangText, { dim: true })] : [],
    )
    neu('cache', [text(segs)])
  }

  // ---- Kosten heute -----------------------------------------------------------------------------------
  {
    const nachKosten = alle
      .filter(s => !s.alt && s.kostenHeute !== null && s.kostenHeute > 0)
      .sort((a, b) => (b.kostenHeute ?? 0) - (a.kostenHeute ?? 0))
    const gesamtKosten = sum.kostenHeute
    const zAlle = zaehlerSumme(alle)
    const qAlle = zAlle.anfragen > 0 ? trefferQuote(zAlle) : null
    const ersparnis = zAlle.anfragen > 0 ? cacheErsparnis(zAlle) : null
    const innen = B - 4 - (ring ? RING_SPALTEN + 1 : 0)
    const kopfInhalt = reihe(
      [S(gesamtKosten === null ? '$ –' : dollar(gesamtKosten), { b: true })],
      [S('  gemessen · alle Sitzungen', { dim: true })],
      sum.ohneZaehler > 0 ? [S(` · +${sum.ohneZaehler} ohne Zähler`, { dim: true })] : [],
    )
    const maxZeilen = ring ? RING_ZEILEN - 2 : 3
    const zeilenSitz: Seg[][] = nachKosten.slice(0, maxZeilen).map(s => {
      const aktiv = istAktiv(s, jetzt) || s.sessionId === d.eigeneId
      const zt = zustandsText(zustandJetzt(s, jetzt), s.zustandSeit, jetzt)
      const anteil = gesamtKosten && gesamtKosten > 0 ? ((s.kostenHeute ?? 0) / gesamtKosten) * 100 : 0
      const sp: Spalte[] = [
        { id: 'punkt', min: 1, prio: 9 },
        { id: 'name', min: 8, flex: true, prio: 10 },
        { id: 'betrag', min: 9, prio: 8 },
        { id: 'anteil', min: 5, prio: 5 },
      ]
      const w = waehle(sp, innen)
      return zeileAus(sp, w, {
        punkt: { segs: [S(aktiv ? '●' : '○', { c: aktiv ? zt.c : FARBEN.grau, dim: !aktiv })] },
        name: { segs: [S(name(s), { dim: !aktiv })] },
        betrag: { segs: [S(dollar(s.kostenHeute ?? 0))], ausr: 'r' },
        anteil: { segs: [S(prozent(anteil), { dim: true })], ausr: 'r' },
      })
    })
    const inhalt: Seg[][] = [kopfInhalt, ...zeilenSitz]
    const weitere = nachKosten.length - maxZeilen
    const ersparnisZeile =
      ersparnis === null
        ? [S('Cache spart: noch keine Messung', { dim: true })]
        : [S('Cache spart ', { dim: true }), S(`≈ ${Math.round(ersparnis)} %`, { c: FARBEN.gut, b: true }), S(' der Eingabekosten', { dim: true })]
    const beginn = zaehlBeginnNotiz(alle, jetzt)
    const zeilen: Zeile[] = []
    if (ring) {
      const links = [...inhalt]
      while (links.length < RING_ZEILEN - 1) links.push([])
      links.push(ersparnisZeile)
      const blockLinks = links.slice(0, RING_ZEILEN).map(l => reihe([S('│ ', { dim: true })], passend(l, innen), [S(' ')]))
      const raster = ringZellen(qAlle === null ? null : qAlle / 100, qAlle === null ? '–' : prozent(qAlle), FARBEN.gut, FARBEN.grau)
      const blockRechts = blockLinks.map(() => [S(' │', { dim: true })])
      zeilen.push({ art: 'text', segs: kartenKopf('Kosten heute', B, { dim: true }) })
      zeilen.push({ art: 'block', key: 'ring', links: blockLinks, raster, rechts: blockRechts })
      const zusatz: Seg[][] = []
      if (weitere > 0) zusatz.push([S(`+ ${weitere} weitere Sitzung${weitere === 1 ? '' : 'en'}`, { dim: true })])
      if (beginn !== null) zusatz.push([S(`gezählt ab ${uhr(beginn)}`, { c: FARBEN.warnung }), S(' (Mod später gestartet)', { dim: true })])
      for (const zl of zusatz) zeilen.push({ art: 'text', segs: reihe([S('│ ', { dim: true })], passend(zl, B - 4 - 0), [S(' │', { dim: true })]) })
      zeilen.push({ art: 'text', segs: [S(`╰${'─'.repeat(B - 2)}╯`, { dim: true })] })
    } else {
      const rest = [...inhalt]
      if (weitere > 0) rest.push([S(`+ ${weitere} weitere`, { dim: true })])
      rest.push(ersparnisZeile)
      if (beginn !== null) rest.push([S(`gezählt ab ${uhr(beginn)}`, { c: FARBEN.warnung })])
      zeilen.push(...rahmen(rest, B, { dim: true }, 'Kosten heute'))
    }
    neu('karte', zeilen)
  }

  // ---- Limits -----------------------------------------------------------------------------------------
  {
    const gruppen = limitsJeProfil(alle, jetzt)
    const zeilen: Zeile[] = []
    const resetText = (reset: number | null) => (reset === null ? '' : voll ? `Reset ${resetZeit(reset, jetzt)}` : resetZeit(reset, jetzt))
    const resetBreite = Math.max(0, ...gruppen.flatMap(g => g.limits.map(l => W(resetText(l.reset)))))
    for (const g of gruppen) {
      if (gruppen.length > 1) zeilen.push(text([S(' '), S(g.profil, { dim: true })]))
      for (const l of g.limits) {
        const reset = resetText(l.reset)
        const farbe = l.prozent >= 90 ? FARBEN.fehler : l.prozent >= 70 ? FARBEN.warnung : FARBEN.akzent
        const sp: Spalte[] = [
          { id: 'rand', min: 1, prio: 10 },
          { id: 'name', min: 5, prio: 10 },
          { id: 'balken', min: 6, flex: true, rest: true, prio: 9 },
          { id: 'pct', min: 5, prio: 9 },
          { id: 'reset', min: Math.max(5, resetBreite), prio: 6 },
        ]
        const w = waehle(sp, B, 2)
        const anteil = Math.min(1, l.prozent / 100)
        const n = w.get('balken') ?? 6
        const f = Math.round(anteil * n)
        zeilen.push({
          art: 'text',
          segs: zeileAus(sp, w, {
            rand: { segs: [S(' ')] },
            name: { segs: [S(limitName(l.art))] },
            balken: { segs: [S('▄'.repeat(f), { c: farbe }), S('▄'.repeat(n - f), { c: BALKEN_REST })] },
            pct: { segs: [S(prozent(l.prozent), { b: true })], ausr: 'r' },
            reset: { segs: [S(reset, { dim: true })] },
          }, 2),
        })
      }
    }
    if (zeilen.length > 0) neu('limits', [text(abschnittsKopf('LIMITS', B)), ...zeilen])
  }

  // ---- Sitzungen ---------------------------------------------------------------------------------------
  {
    const zeilen: Zeile[] = [text(abschnittsKopf('SITZUNGEN', B))]
    const sp: Spalte[] = [
      { id: 'marke', min: 1, prio: 10 },
      { id: 'name', min: 12, max: 28, flex: true, rest: true, prio: 10 },
      { id: 'zustand', min: 14, max: 16, flex: true, prio: 9 },
      { id: 'kosten', min: 8, prio: 8 },
      { id: 'ctx', min: 7, prio: 6 },
      { id: 'modell', min: 6, prio: 5 },
      { id: 'cache', min: 6, prio: 4 },
    ]
    const w = waehle(sp, B)
    // Kopfzeile der Tabelle
    zeilen.push({
      art: 'text',
      segs: zeileAus(sp, w, {
        marke: { segs: [] },
        name: { segs: [S('Sitzung', { dim: true })] },
        zustand: { segs: [S('Zustand', { dim: true })] },
        kosten: { segs: [S('heute', { dim: true })], ausr: 'r' },
        ctx: { segs: [S('Kontext', { dim: true })], ausr: 'r' },
        modell: { segs: [S('Modell', { dim: true })] },
        cache: { segs: [S('Cache≈', { dim: true })] },
      }),
    })
    {
      const gewaehltAlle = !gewaehlt
      zeilen.push({
        art: 'knopf',
        key: 'alle',
        ziel: { was: 'alle' },
        segs: zeileAus(sp, w, {
          marke: { segs: [S(gewaehltAlle ? '▶' : ' ', { c: FARBEN.akzent })] },
          name: { segs: [S('Alle Sitzungen', { b: gewaehltAlle })] },
          zustand: { segs: [S(`${sum.aktiv} aktiv`, { dim: true })] },
          kosten: { segs: [S(sum.kostenHeute === null ? '–' : dollar(sum.kostenHeute), { b: gewaehltAlle })], ausr: 'r' },
        }),
      })
    }
    const MAX = 8
    for (const s of aktive.slice(0, MAX)) {
      const istEigen = s.sessionId === d.eigeneId
      const gewaehltDiese = gewaehlt?.sessionId === s.sessionId
      const zst = zustandJetzt(s, jetzt)
      const zt = zustandsText(zst, s.zustandSeit, jetzt)
      const cache = cacheStand(s.letzteAntwort, jetzt)
      const fam = modellFamilie(s.modell)
      const kontext = s.kontextProzent
      const nameZelle = reihe(
        [S(name(s), { b: gewaehltDiese || zst === 'braucht', c: zst === 'braucht' ? FARBEN.warnung : undefined })],
        istEigen ? [S(w.get('name')! >= W(name(s)) + 8 ? ' ◀ diese' : ' ◀', { c: FARBEN.koerper })] : [],
      )
      zeilen.push({
        art: 'knopf',
        key: s.sessionId,
        ziel: { was: 'sitzung', id: s.sessionId },
        segs: zeileAus(sp, w, {
          marke: { segs: [S(gewaehltDiese ? '▶' : ' ', { c: FARBEN.akzent })] },
          name: { segs: nameZelle },
          zustand: { segs: [S(`${zt.icon} `, { c: zt.c, b: zt.b }), S(zt.wort, { c: zt.dim ? undefined : zt.c, dim: zt.dim, b: zt.b })] },
          kosten: { segs: [S(s.alt ? '–' : s.kostenHeute === null ? '–' : dollar(s.kostenHeute))], ausr: 'r' },
          ctx: {
            segs: [S(kontext === null ? '–' : `${kontext} %`, { c: kontext !== null && kontext >= 90 ? FARBEN.fehler : kontext !== null && kontext >= 80 ? FARBEN.warnung : undefined })],
            ausr: 'r',
          },
          modell: { segs: [S(famName(s.modell), { c: modellFarbe(fam) })] },
          cache: {
            segs:
              cache === null
                ? [S('–', { dim: true })]
                : [S(cache === 'warm' ? '● ' : '○ ', { c: cache === 'warm' ? FARBEN.gut : FARBEN.grau }), S(cache === 'warm' ? 'warm' : 'kalt', { dim: cache === 'kalt' })],
          },
        }),
      })
    }
    if (aktive.length > MAX) zeilen.push(text([S(`  + ${aktive.length - MAX} weitere`, { dim: true })]))
    neu('sitzungen', zeilen)
  }

  // ---- Crew ---------------------------------------------------------------------------------------------
  let crew: Ansicht['crew'] = null
  {
    const cs = gewaehlt ?? eigene ?? aktive[0] ?? null
    if (cs) {
      const agents = sichtbareAgents(cs, jetzt)
      const hauptZst = zustandJetzt(cs, jetzt)
      const figuren: Figur[] = [
        { hutKey: cs.sessionId, haupt: true, zustand: mannZustand(hauptZst), modell: cs.modell, familie: modellFamilie(cs.modell), name: 'Haupt', beendet: null },
        ...agents.map(a => {
          const fam = a.art === 'fork' ? 'fork' : modellFamilie(a.modell)
          return {
            hutKey: a.id,
            haupt: false,
            zustand: agentMannZustand(a),
            modell: a.art === 'fork' ? 'fork' : a.modell || '…',
            familie: fam,
            name: kuerzen(a.name || a.typ || 'Agent', 10),
            beendet: a.stand === 'fertig' || a.stand === 'fehler' ? a.beendet : null,
          } satisfies Figur
        }),
      ]
      const zeilen: Zeile[] = [text(abschnittsKopf(`CREW · ${kuerzen(name(cs), Math.max(6, B - 14))}`, B))]
      const proBand = jeBand(B)
      const maxFiguren = proBand * 2
      const gezeigt = figuren.slice(0, maxFiguren)
      if (sprites) {
        const raster = crewZellen(gezeigt, B, Math.floor(jetzt / d.bildMs), jetzt, d.bildMs)
        zeilen.push({ art: 'raster', key: 'crew', raster })
        crew = { key: 'crew', figuren: gezeigt, spalten: B }
      }
      // Zeilen je Agent (anklickbar: wählt das Ziel für Nachricht und Stopp)
      const sp: Spalte[] = [
        { id: 'icon', min: 1, prio: 10 },
        { id: 'name', min: 10, max: 14, flex: true, prio: 10 },
        { id: 'werk', min: 16, flex: true, rest: true, prio: 9 },
        { id: 'dauer', min: 5, prio: 7 },
        { id: 'anfr', min: 8, prio: 6 },
        { id: 'tok', min: 14, prio: 3 },
      ]
      const w = waehle(sp, B)
      const agentZeile = (key: string, ziel: KnopfZiel, a: { icon: string; ic: string; name: string; werk: Seg[]; dauerMs: number | null; z: LeitstandZaehler; gewaehlt: boolean }): Zeile => ({
        art: 'knopf',
        key,
        ziel,
        segs: zeileAus(sp, w, {
          icon: { segs: [S(a.icon, { c: a.ic })] },
          name: { segs: [S(a.name, { b: a.gewaehlt })] },
          werk: { segs: a.werk },
          dauer: { segs: a.dauerMs === null ? [] : [S(dauer(a.dauerMs), { dim: true })], ausr: 'r' },
          anfr: { segs: [S(a.z.anfragen > 0 ? `${ganzzahl(a.z.anfragen)} Anfr.` : '–', { dim: true })], ausr: 'r' },
          tok: {
            segs:
              a.z.anfragen > 0
                ? [S('↑', { dim: true }), S(tokens(eingabeGesamt(a.z))), S(' ↓', { dim: true }), S(tokens(a.z.ausgabe))]
                : [S('–', { dim: true })],
            ausr: 'r',
          },
        }),
      })
      const hauptZt = zustandsText(hauptZst, cs.zustandSeit, jetzt)
      const hauptWerk: Seg[] =
        hauptZst === 'arbeitet' && cs.werkzeug
          ? [S(cs.werkzeug), S(cs.ziel ? `  ${cs.ziel}` : '', { dim: true })]
          : hauptZst === 'arbeitet'
            ? [S('arbeitet', { dim: true })]
            : [S(hauptZt.wort, { c: hauptZt.dim ? undefined : hauptZt.c, dim: hauptZt.dim })]
      const hauptGewaehlt = d.aktion?.art === 'sitzung' && d.aktion.id === cs.sessionId
      const hauptZaehler = cs.haupt
      zeilen.push(
        agentZeile(`h:${cs.sessionId}`, { was: 'haupt', sitzungId: cs.sessionId }, {
          icon: hauptZt.icon,
          ic: hauptZt.c,
          name: 'Haupt',
          werk: hauptWerk,
          dauerMs: hauptZst === 'arbeitet' ? jetzt - cs.zustandSeit : null,
          z: hauptZaehler,
          gewaehlt: hauptGewaehlt,
        }),
      )
      const aktionenFuer = (ziel: LeitstandZiel, darfNachricht: boolean, darfStopp: boolean): Zeile[] => {
        if (!d.aktion || d.aktion.art !== ziel.art || d.aktion.id !== ziel.id) return []
        const aus: Zeile[] = [
          {
            art: 'aktionen',
            ziel,
            darfNachricht,
            darfStopp,
            stoppBitte: d.stoppBitte !== null && d.stoppBitte.ziel === ziel.id && d.stoppBitte.bis > jetzt,
            einrueck: 2,
          },
        ]
        if (d.eingabe && d.eingabe.art === ziel.art && d.eingabe.id === ziel.id) aus.push({ art: 'eingabe', ziel, einrueck: 2 })
        return aus
      }
      zeilen.push(...aktionenFuer({ art: 'sitzung', id: cs.sessionId }, cs.sessionId !== d.eigeneId, hauptZst === 'arbeitet'))
      if (agents.length === 0) zeilen.push(text([S('  keine Subagents', { dim: true })]))
      for (const a of agents.slice(0, 12)) {
        const zt: ZustandsText =
          a.stand === 'laeuft'
            ? { icon: '●', wort: '', c: FARBEN.sonnet }
            : a.stand === 'wartet'
              ? { icon: '?', wort: 'wartet', c: FARBEN.akzent }
              : a.stand === 'fertig'
                ? { icon: '✓', wort: 'fertig', c: FARBEN.gut }
                : { icon: '✗', wort: 'Fehler', c: FARBEN.fehler }
        const werk: Seg[] =
          a.stand === 'laeuft' && a.werkzeug
            ? [S(a.werkzeug), S(a.ziel ? `  ${a.ziel}` : '', { dim: true })]
            : a.stand === 'laeuft'
              ? [S('arbeitet', { dim: true })]
              : [S(zt.wort, { c: zt.c })]
        const gewaehltA = d.aktion?.art === 'agent' && d.aktion.id === a.id
        zeilen.push(
          agentZeile(`g:${a.id}`, { was: 'agent', sitzungId: cs.sessionId, id: a.id }, {
            icon: zt.icon,
            ic: zt.c,
            name: a.name || a.typ || 'Agent',
            werk,
            dauerMs: (a.beendet ?? jetzt) - a.gestartet,
            z: a.z,
            gewaehlt: gewaehltA,
          }),
        )
        zeilen.push(...aktionenFuer({ art: 'agent', id: a.id }, true, a.stand === 'laeuft'))
      }
      if (figuren.length > gezeigt.length || agents.length > 12) {
        zeilen.push(text([S(`  + ${Math.max(figuren.length - gezeigt.length, agents.length - 12)} weitere`, { dim: true })]))
      }
      // Sprites fallen als eigener Abschnitt weg, wenn es eng wird: der Streifen steht darum als eigener Teil.
      const streifen = zeilen.filter(x => x.art === 'raster')
      const ohneStreifen = zeilen.filter(x => x.art !== 'raster')
      neu('crew', ohneStreifen.slice(0, 1))
      if (streifen.length) neu('sprites', streifen)
      neu('crew-liste', ohneStreifen.slice(1))
    }
  }

  // ---- Modelle ------------------------------------------------------------------------------------------
  {
    const liste = modelleSumme(umfang)
    const zeilen: Zeile[] = [text(abschnittsKopf('MODELLE', B, voll ? '↑ Eingabe gesamt  ↓ Ausgabe' : ''))]
    if (liste.length === 0) zeilen.push(text([S('  noch keine Anfragen gezählt', { dim: true })]))
    const summeAlle = liste.reduce((n, m) => n + eingabeGesamt(m.z) + m.z.ausgabe, 0)
    const sp: Spalte[] = [
      { id: 'punkt', min: 1, prio: 10 },
      { id: 'name', min: 10, flex: true, max: 12, prio: 10 },
      { id: 'balken', min: 10, flex: true, max: 20, rest: true, prio: 5 },
      { id: 'anfr', min: 9, prio: 7 },
      { id: 'ein', min: 8, prio: 9 },
      { id: 'aus', min: 7, prio: 9 },
    ]
    const w = waehle(sp, B)
    for (const m of liste.slice(0, 6)) {
      const fam = modellFamilie(m.modell)
      const anteil = summeAlle > 0 ? (eingabeGesamt(m.z) + m.z.ausgabe) / summeAlle : 0
      zeilen.push({
        art: 'text',
        segs: zeileAus(sp, w, {
          punkt: { segs: [S('●', { c: modellFarbe(fam) })] },
          name: { segs: [S(m.modell)] },
          balken: { segs: [S(balken(anteil, w.get('balken') ?? 10, '█', '░'), { c: modellFarbe(fam) })] },
          anfr: { segs: [S(`${ganzzahl(m.z.anfragen)} Anfr.`, { dim: true })], ausr: 'r' },
          ein: { segs: [S('↑', { dim: true }), S(tokens(eingabeGesamt(m.z)))], ausr: 'r' },
          aus: { segs: [S('↓', { dim: true }), S(tokens(m.z.ausgabe))], ausr: 'r' },
        }),
      })
    }
    neu('modelle', zeilen)
  }

  // ---- Fuß ---------------------------------------------------------------------------------------------
  {
    const hilfe = voll ? ' /leitstand schließt · Klick oder Tab+Enter wählt · a Alle' : ' /leitstand schließt · Klick wählt'
    neu('fuss', [text(linie(B)), text([S(hilfe, { dim: true })])])
  }

  // ---- Auf die Höhe bringen ---------------------------------------------------------------------------
  const hoeheVon = (z: Zeile): number => (z.art === 'raster' || z.art === 'block' ? z.raster.zeilen : 1)
  const gesamt = (liste: Abschnitt[]) => liste.reduce((n, a) => n + a.zeilen.reduce((m, z) => m + hoeheVon(z), 0), 0)
  let sichtbar = abschnitte
  if (d.hoehe !== null) {
    for (const id of ENTFALL) {
      if (gesamt(sichtbar) <= d.hoehe) break
      sichtbar = sichtbar.filter(a => a.id !== id)
    }
  }
  const crewZeigt = sichtbar.some(a => a.id === 'sprites')
  return { zeilen: sichtbar.flatMap(a => a.zeilen), crew: crewZeigt ? crew : null }
}

/** Die Höhe der Ansicht in Textzeilen. */
export function ansichtHoehe(a: Ansicht): number {
  return a.zeilen.reduce((n, z) => n + (z.art === 'raster' || z.art === 'block' ? z.raster.zeilen : 1), 0)
}

/** Die Breite einer Zeile (für Prüfungen); Raster zählen mit ihren Spalten. */
export function zeilenBreite(z: Zeile): number {
  switch (z.art) {
    case 'text':
    case 'knopf':
      return segBreite(z.segs)
    case 'raster':
      return z.raster.spalten
    case 'block':
      return segBreite(z.links[0] ?? []) + z.raster.spalten + segBreite(z.rechts[0] ?? [])
    case 'aktionen':
    case 'eingabe':
      return 0
  }
}

export { STANDARD, crewHoehe }
