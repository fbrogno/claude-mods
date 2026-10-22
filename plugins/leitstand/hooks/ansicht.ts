// Die Ansicht als reines Datenmodell: Zeilen aus farbigen Textstücken mit fester Breite, dazu Zellraster (Ring, Crew).
// Nichts hier berührt die Engine; register.tsx macht daraus Elemente. So lässt sich alles ohne Sitzung prüfen.

import type { LeitstandAgent, LeitstandLimit, LeitstandSitzung, LeitstandZaehler, LeitstandZiel, LeitstandZustand } from '../types'
import { BREITE, FARBEN, FIGUR_ABSTAND, RING_SPALTEN, RING_ZEILEN, STANDARD, ringZellen, crewHoehe, crewZellen, jeBand, modellFarbe } from './clawd'
import type { Figur, MannZustand, Zellen } from './clawd'
import {
  LIMIT_FRISCH_MS,
  anzeigeNamen,
  cacheErsparnis,
  cacheStand,
  dauer,
  dollar,
  eingabeGesamt,
  ganzzahl,
  gruppiere,
  istAktiv,
  kuerzen,
  limitName,
  limitOffen,
  limitsJeProfil,
  modelleSumme,
  modellFamilie,
  prozent,
  resetZeit,
  sichtbareAgents,
  sitzungsGrundname,
  summen,
  tokens,
  trefferQuote,
  uhr,
  vorZeit,
  zaehlBeginnNotiz,
  zaehlerSumme,
  zustandInaktiv,
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
  | { art: 'block'; key: string; /** Schlüssel des Rasters (Ziel von `blit`), sonst `<key>-raster` */ rasterKey?: string; links: Seg[][]; raster: Zellen; rechts: Seg[][] }
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
  /** Die animierten Crew-Streifen (einer je Sitzung in der Übersicht, einer im Detail), falls gezeichnet. */
  crew: Array<{ key: string; figuren: Figur[]; spalten: number }>
  /** Wie stark verdichtet wurde (0 = voll), damit nichts weggelassen werden muss, wenn das Pane niedrig ist. */
  stufe: number
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

/** Farbe des leeren Balkenteils (dunkel, aber auf dunklem Grund sichtbar). */
const BALKEN_REST = '#4B5563'

const balken = (anteil: number, n: number, voll: string, leer: string): string => {
  const f = Math.max(0, Math.min(n, Math.round(anteil * n)))
  return voll.repeat(f) + leer.repeat(n - f)
}

// ---- Die Ansicht ------------------------------------------------------------------------------------------------

type Abschnitt = { id: string; zeilen: Zeile[] }

/**
 * Was bei wenig Höhe zuerst verschwindet: Beiwerk, nie ganze Abschnitte. (0.2 strich bei einem niedrigen Pane die Abschnitte
 * Fuß, Modelle und Limits: Limits und Modelle fehlten dann, obwohl die Kacheln Daten zeigten.) Reicht auch die letzte Stufe
 * nicht, scrollt das Pane selbst (`e.props.scroll`, vom Host gesteuert) und es fehlt trotzdem nichts.
 */
export type Verdichtung = {
  ohneFuss?: boolean
  /** Der Cache-Treffer-Balken fällt weg, wenn der Ring dieselbe Zahl zeigt. */
  ohneBalken?: boolean
  /** Limits: eine Zeile je Profil statt je Fenster. */
  limitsKompakt?: boolean
  /** Crew-Übersicht: Sitzungen ohne Agents als eine Textzeile statt als Figurenblock. */
  leereCrewKompakt?: boolean
  kachelnKompakt?: boolean
  /** Kosten-Karte ohne Ring und ohne Reihe je Sitzung (die Kosten stehen auch in der Sitzungsliste): zwei, drei Zeilen. */
  karteKompakt?: boolean
  ohneFiguren?: boolean
}

export const STUFEN: readonly Verdichtung[] = (() => {
  const schritte: Verdichtung[] = [
    {},
    { ohneFuss: true },
    { ohneBalken: true },
    { limitsKompakt: true },
    { leereCrewKompakt: true },
    { kachelnKompakt: true },
    { karteKompakt: true },
    { ohneFiguren: true },
  ]
  let summe: Verdichtung = {}
  return schritte.map(s => (summe = { ...summe, ...s }))
})()

const LEER_ZEILEN = 3

export function baueAnsicht(d: AnsichtDaten): Ansicht {
  let a = bauen(d, STUFEN[0]!, 0)
  if (d.hoehe === null) return a
  for (let i = 0; i < STUFEN.length; i++) {
    if (i > 0) a = bauen(d, STUFEN[i]!, i)
    if (ansichtHoehe(a) <= d.hoehe) return a
  }
  return a
}

const MAX_FIGUREN = 5
const MAX_CREW_SITZUNGEN = 4
const MAX_SITZUNGEN = 8
const MAX_BEENDET = 5

function bauen(d: AnsichtDaten, v: Verdichtung, stufe: number): Ansicht {
  const B = Math.max(10, Math.floor(d.breite))
  if (B < MIN_BREITE) {
    return { zeilen: [{ art: 'text', segs: passend([S('Pane zu schmal', { dim: true })], B) }], crew: [], stufe }
  }
  const voll = B >= VOLL_AB
  const ring = d.raster && voll && !v.karteKompakt
  const sprites = d.raster && voll && !v.ohneFiguren
  const jetzt = d.jetzt

  const alle = d.sitzungen
  const gewaehlt = d.auswahl ? (alle.find(s => s.sessionId === d.auswahl) ?? null) : null
  // EIN Umfang für Kacheln, Cache, Kosten und Modelle: die gewählte Sitzung, sonst alle heutigen Sitzungen (auch beendete).
  const umfang = gewaehlt ? [gewaehlt] : alle
  const gr = gruppiere(alle, d.eigeneId, jetzt)
  const sichtbar = [...gr.aktiv, ...gr.beendet, ...(gewaehlt && !gr.aktiv.includes(gewaehlt) && !gr.beendet.includes(gewaehlt) ? [gewaehlt] : [])]
  const namen = anzeigeNamen(sichtbar, jetzt)
  const name = (s: LeitstandSitzung) => namen.get(s.sessionId) ?? sitzungsGrundname(s, jetzt)
  const sum = summen(alle, jetzt)

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
    // Die Zahlen gehen vor der Uhr: erst die ausführlichste Variante, die (mit oder ohne Uhr) hineinpasst.
    suche: for (const va of varianten) {
      for (const mitUhr of [true, false]) {
        const fest = segBreite(titel) + 2 + segBreite(va) + (mitUhr ? 2 + segBreite(uhrSeg) : 0)
        if (fest <= inner) {
          const luecke = inner - segBreite(titel) - 2 - segBreite(va) - (mitUhr ? segBreite(uhrSeg) : 0)
          inhalt = reihe(titel, leerzeichen(2), va, leerzeichen(luecke), mitUhr ? uhrSeg : [])
          break suche
        }
      }
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
    return { zeilen: abschnitte.flatMap(a => a.zeilen), crew: [], stufe }
  }

  // ---- Kacheln -----------------------------------------------------------------------------------
  const z = zaehlerSumme(umfang)
  const gezaehlt = z.anfragen > 0
  const zuWert = (n: number, f: (n: number) => string) => (gezaehlt ? f(n) : '–')
  const kacheln = [
    { zahl: zuWert(z.anfragen, ganzzahl), name: 'Anfragen', kurz: 'Anfragen', c: '#A78BFA' },
    { zahl: zuWert(z.eingabe, tokens), name: 'Eingabe neu', kurz: 'Eingabe', c: '#60A5FA' },
    { zahl: zuWert(z.cacheLesen, tokens), name: 'Cache lesen', kurz: 'Cache', c: '#4ADE80' },
    { zahl: zuWert(z.ausgabe, tokens), name: 'Ausgabe', kurz: 'Ausgabe', c: '#FACC15' },
  ]
  if (v.kachelnKompakt) {
    const teil = (k: (typeof kacheln)[number]): Seg[] => [S(k.zahl, { c: k.c, b: true }), S(` ${k.kurz}`, { dim: true })]
    const punkt = S('  ·  ', { dim: true })
    const alleVier = reihe([S(' ')], teil(kacheln[0]!), [punkt], teil(kacheln[1]!), [punkt], teil(kacheln[2]!), [punkt], teil(kacheln[3]!))
    if (segBreite(alleVier) <= B) neu('kacheln', [text(alleVier)])
    else neu('kacheln', [text(reihe([S(' ')], teil(kacheln[0]!), [punkt], teil(kacheln[1]!))), text(reihe([S(' ')], teil(kacheln[2]!), [punkt], teil(kacheln[3]!)))])
  } else {
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

  const umfangText = gewaehlt ? kuerzen(name(gewaehlt), 30) : 'alle Sitzungen'
  const q = gezaehlt ? trefferQuote(z) : null

  // ---- Cache-Treffer-Leiste (entfällt bei Platzmangel, wenn der Ring dieselbe Zahl zeigt) -----------------
  if (!(v.ohneBalken && (ring || v.karteKompakt))) {
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

  // ---- Kosten heute (gleicher Umfang wie die Kacheln) --------------------------------------------------
  {
    const nachKosten = umfang.filter(s => s.kostenHeute !== null && s.kostenHeute > 0).sort((a, b) => (b.kostenHeute ?? 0) - (a.kostenHeute ?? 0))
    const hatMessung = umfang.some(s => s.kostenHeute !== null)
    const gesamtKosten = hatMessung ? umfang.reduce((n, s) => n + (s.kostenHeute ?? 0), 0) : null
    const ersparnis = gezaehlt ? cacheErsparnis(z) : null
    const innen = B - 4 - (ring ? RING_SPALTEN + 1 : 0)
    const kopfInhalt = reihe([S(gesamtKosten === null ? '$ –' : dollar(gesamtKosten), { b: true })], [S(`  gemessen · ${umfangText}`, { dim: true })])
    const maxZeilen = ring ? RING_ZEILEN - 2 : 3
    const zeigeReihen = !gewaehlt && !v.karteKompakt
    const zeilenSitz: Seg[][] = zeigeReihen
      ? nachKosten.slice(0, maxZeilen).map(s => {
          const aktiv = istAktiv(s, jetzt)
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
      : []
    const inhalt: Seg[][] = [kopfInhalt, ...zeilenSitz]
    const weitere = zeigeReihen ? nachKosten.length - maxZeilen : 0
    const ersparnisZeile =
      ersparnis === null
        ? [S('Cache spart: noch keine Messung', { dim: true })]
        : [S('Cache spart ', { dim: true }), S(`≈ ${Math.round(ersparnis)} %`, { c: FARBEN.gut, b: true }), S(' der Eingabekosten', { dim: true })]
    const beginn = zaehlBeginnNotiz(umfang, jetzt)
    const zeilen: Zeile[] = []
    if (ring) {
      const links = [...inhalt]
      while (links.length < RING_ZEILEN - 1) links.push([])
      links.push(ersparnisZeile)
      const blockLinks = links.slice(0, RING_ZEILEN).map(l => reihe([S('│ ', { dim: true })], passend(l, innen), [S(' ')]))
      const raster = ringZellen(q === null ? null : q / 100, q === null ? '–' : prozent(q), FARBEN.gut, FARBEN.grau)
      const blockRechts = blockLinks.map(() => [S(' │', { dim: true })])
      zeilen.push({ art: 'text', segs: kartenKopf('Kosten heute', B, { dim: true }) })
      zeilen.push({ art: 'block', key: 'ring', links: blockLinks, raster, rechts: blockRechts })
      const zusatz: Seg[][] = []
      if (weitere > 0) zusatz.push([S(`+ ${weitere} weitere Sitzung${weitere === 1 ? '' : 'en'}`, { dim: true })])
      if (beginn !== null) zusatz.push([S(`gezählt ab ${uhr(beginn)}`, { c: FARBEN.warnung }), S(' (Mod später gestartet)', { dim: true })])
      for (const zl of zusatz) zeilen.push({ art: 'text', segs: reihe([S('│ ', { dim: true })], passend(zl, B - 4), [S(' │', { dim: true })]) })
      zeilen.push({ art: 'text', segs: [S(`╰${'─'.repeat(B - 2)}╯`, { dim: true })] })
    } else {
      const rest = [...inhalt]
      if (weitere > 0) rest.push([S(`+ ${weitere} weitere`, { dim: true })])
      if (v.karteKompakt) rest.push(q === null ? [S('Cache-Treffer: noch keine Messung', { dim: true })] : [S('Cache-Treffer ', { dim: true }), S(prozent(q), { c: FARBEN.gut, b: true }), ...(ersparnis === null ? [] : [S('  ·  spart ', { dim: true }), S(`≈ ${Math.round(ersparnis)} %`, { c: FARBEN.gut, b: true }), S(' der Eingabekosten', { dim: true })])])
      else rest.push(ersparnisZeile)
      if (beginn !== null) rest.push([S(`gezählt ab ${uhr(beginn)}`, { c: FARBEN.warnung })])
      zeilen.push(...rahmen(rest, B, { dim: true }, 'Kosten heute'))
    }
    neu('karte', zeilen)
  }

  // ---- Limits (kontoweit: der jüngste Stand je Profil aus ALLEN heutigen Dateien) ----------------------
  {
    const gruppen = limitsJeProfil(alle)
    if (gruppen.length > 0) {
      const mehrere = gruppen.length > 1
      const zeilen: Zeile[] = [text(abschnittsKopf('LIMITS', B))]
      const farbeFuer = (p: number) => (p >= 90 ? FARBEN.fehler : p >= 70 ? FARBEN.warnung : FARBEN.akzent)
      const balkenSegs = (l: LeitstandLimit, n: number): Seg[] => {
        const offen = limitOffen(l, jetzt)
        const f = Math.max(0, Math.min(n, Math.round(Math.min(1, l.prozent / 100) * n)))
        return [S('▄'.repeat(f), { c: offen ? farbeFuer(l.prozent) : FARBEN.grau, dim: !offen }), S('▄'.repeat(n - f), { c: BALKEN_REST })]
      }
      const nameBreite = Math.max(3, ...gruppen.flatMap(g => g.limits.map(l => W(limitName(l.art)))))
      const standText = (zeit: number) => `Stand ${resetZeit(zeit, jetzt)}`
      const veraltet = (zeit: number) => jetzt - zeit > LIMIT_FRISCH_MS
      const resetKurz = (l: LeitstandLimit) => (l.reset === null ? '' : limitOffen(l, jetzt) ? resetZeit(l.reset, jetzt) : 'vorbei')

      // Eine Zeile je Profil mit allen Fenstern; die Spalten sind über alle Profile gleich breit (untereinander ausgerichtet).
      const resetBreiten: number[] = []
      for (const g of gruppen) g.limits.forEach((l, i) => (resetBreiten[i] = Math.max(resetBreiten[i] ?? 0, W(resetKurz(l)))))
      const standBreite = Math.max(0, ...gruppen.map(g => (veraltet(g.zeit) ? W(`  ${standText(g.zeit)}`) : 0)))
      const spaltenMax = Math.max(...gruppen.map(g => g.limits.length))
      const tagBreite = mehrere ? 7 : 1
      const festeBreite = tagBreite + (spaltenMax - 1) * 3 + standBreite + resetBreiten.reduce((n, r) => n + nameBreite + 1 + 1 + 5 + (r > 0 ? 1 + r : 0), 0)
      const balkenProFenster = Math.min(12, Math.floor((B - festeBreite) / Math.max(1, spaltenMax)))
      const profilZeile = (g: (typeof gruppen)[number]): Seg[] | null => {
        if (balkenProFenster < 4) return null
        const stand = veraltet(g.zeit) ? `  ${standText(g.zeit)}` : ''
        const teile = g.limits.map((l, i) => {
          const offen = limitOffen(l, jetzt)
          const rb = resetBreiten[i] ?? 0
          return reihe(
            [S(limitName(l.art).padEnd(nameBreite))],
            [S(' ')],
            balkenSegs(l, balkenProFenster),
            [S(' ')],
            passend([S(prozent(l.prozent), { b: true, dim: !offen })], 5, 'r'),
            rb > 0 ? [S(' '), ...passend([S(resetKurz(l), { dim: true })], rb)] : [],
          )
        })
        const mitte = teile.flatMap((t, i) => (i === 0 ? t : [S('   '), ...t]))
        return reihe(mehrere ? [S(' '), ...passend([S(g.kurz, { c: FARBEN.akzent })], 6)] : [S(' ')], mitte, stand ? [S(stand, { dim: true })] : [])
      }

      // Eine Zeile je Fenster; die Reset-Angabe richtet sich nach der Breite (mit oder ohne „Reset", mit oder ohne „Stand").
      const fensterZeilen = (g: (typeof gruppen)[number]): Zeile[] => {
        const stand = veraltet(g.zeit)
        const tagBreite = mehrere ? 7 : 1
        const resetVarianten: Array<(l: LeitstandLimit) => string> = [
          l => (l.reset === null ? '' : `${limitOffen(l, jetzt) ? `Reset ${resetZeit(l.reset, jetzt)}` : 'Reset vorbei'}${stand ? ` · ${standText(g.zeit)}` : ''}`),
          l => (l.reset === null ? '' : `${resetKurz(l)}${stand ? ` · ${standText(g.zeit)}` : ''}`),
          l => resetKurz(l),
          () => '',
        ]
        const luecke = B < 60 ? 1 : 2
        const frei = B - tagBreite - nameBreite - 6 - 5 - 3 * luecke
        const wahl = resetVarianten.find(f => Math.max(0, ...g.limits.map(l => W(f(l)))) <= frei) ?? resetVarianten[3]!
        const resetBr = Math.max(0, ...g.limits.map(l => W(wahl(l))))
        return g.limits.map((l, i) => {
          const offen = limitOffen(l, jetzt)
          const bw = Math.max(6, B - tagBreite - nameBreite - 5 - (resetBr > 0 ? resetBr + luecke : 0) - 2 * luecke)
          const abstand = S(' '.repeat(luecke))
          return text(
            reihe(
              mehrere ? [S(' '), ...passend([S(i === 0 ? g.kurz : '', { c: FARBEN.akzent })], 6)] : [S(' ')],
              [S(limitName(l.art).padEnd(nameBreite)), abstand],
              balkenSegs(l, bw),
              [abstand],
              passend([S(prozent(l.prozent), { b: true, dim: !offen })], 5, 'r'),
              resetBr > 0 ? [abstand, S(wahl(l), { dim: true })] : [],
            ),
          )
        })
      }

      for (const g of gruppen) {
        const kompakt = v.limitsKompakt || (mehrere && B >= 76)
        const eine = kompakt ? profilZeile(g) : null
        if (eine) zeilen.push(text(eine))
        else zeilen.push(...fensterZeilen(g))
      }
      neu('limits', zeilen)
    }
  }

  // ---- Sitzungen ---------------------------------------------------------------------------------------
  {
    const zeilen: Zeile[] = [text(abschnittsKopf('SITZUNGEN', B))]
    const sp: Spalte[] = [
      { id: 'marke', min: 1, prio: 10 },
      // Der Name (Titel) kommt vor Kontext, Modell und Cache: bei schmalem Pane fallen zuerst diese Spalten weg.
      { id: 'name', min: 16, max: 40, flex: true, rest: true, prio: 10 },
      { id: 'zustand', min: 16, max: 18, flex: true, prio: 9 },
      { id: 'kosten', min: 8, prio: 9 },
      { id: 'ctx', min: 7, prio: 6 },
      { id: 'modell', min: 6, prio: 5 },
      { id: 'cache', min: 6, prio: 4 },
    ]
    const w = waehle(sp, B)
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
    // (a) aktiv mit Inhalt
    for (const s of gr.aktiv.slice(0, MAX_SITZUNGEN)) {
      const istEigen = s.sessionId === d.eigeneId
      const gewaehltDiese = gewaehlt?.sessionId === s.sessionId
      const zst = zustandJetzt(s, jetzt)
      const zt = zustandsText(zst, s.zustandSeit, jetzt)
      const cache = cacheStand(s.letzteAntwort, jetzt)
      const fam = modellFamilie(s.modell)
      const kontext = s.kontextProzent
      const vorErster = s.gesamt.anfragen === 0 && s.letzteAntwort === null
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
          kosten: { segs: [S(s.kostenHeute === null ? '–' : dollar(s.kostenHeute))], ausr: 'r' },
          ctx: {
            segs:
              kontext === null
                ? [S(vorErster ? 'neu' : '–', { dim: true })]
                : [S(`${kontext} %`, { c: kontext >= 90 ? FARBEN.fehler : kontext >= 80 ? FARBEN.warnung : undefined })],
            ausr: 'r',
          },
          modell: { segs: [S(famName(s.modell), { c: modellFarbe(fam) })] },
          cache: {
            segs:
              cache === null
                ? [S(vorErster ? 'neu' : '–', { dim: true })]
                : [S(cache === 'warm' ? '● ' : '○ ', { c: cache === 'warm' ? FARBEN.gut : FARBEN.grau }), S(cache === 'warm' ? 'warm' : 'kalt', { dim: cache === 'kalt' })],
          },
        }),
      })
    }
    if (gr.aktiv.length > MAX_SITZUNGEN) zeilen.push(text([S(`  + ${gr.aktiv.length - MAX_SITZUNGEN} weitere`, { dim: true })]))
    // (b) leere Sitzungen: eine gedimmte Zeile
    if (gr.leer.length > 0) {
      const n = gr.leer.length
      const diese = gr.leer.some(s => s.sessionId === d.eigeneId)
      zeilen.push(text([S(' '), S(' '), S(`+${n} leere ${n === 1 ? 'Sitzung' : 'Sitzungen'}${diese ? ' (inkl. diese)' : ''}`, { dim: true })]))
    }
    // (c) heute beendet oder ruhend, mit Kosten: gedimmt unter einer feinen Trennzeile
    if (gr.beendet.length > 0) {
      const kopf = [S('── heute beendet/ruhend ', { dim: true })]
      zeilen.push(text([...kopf, S('─'.repeat(Math.max(0, B - segBreite(kopf))), { dim: true })]))
      for (const s of gr.beendet.slice(0, MAX_BEENDET)) {
        const gewaehltDiese = gewaehlt?.sessionId === s.sessionId
        const fam = modellFamilie(s.modell)
        zeilen.push({
          art: 'knopf',
          key: s.sessionId,
          ziel: { was: 'sitzung', id: s.sessionId },
          segs: zeileAus(sp, w, {
            marke: { segs: [S(gewaehltDiese ? '▶' : ' ', { c: FARBEN.akzent })] },
            name: { segs: [S(name(s), { dim: true, b: gewaehltDiese })] },
            zustand: { segs: [S('○ ', { c: FARBEN.grau, dim: true }), S(zustandInaktiv(s, jetzt), { dim: true })] },
            kosten: { segs: [S(s.kostenHeute === null ? '–' : dollar(s.kostenHeute), { dim: true })], ausr: 'r' },
            ctx: { segs: [], ausr: 'r' },
            modell: { segs: [S(famName(s.modell), { c: modellFarbe(fam), dim: true })] },
            cache: { segs: [] },
          }),
        })
      }
      if (gr.beendet.length > MAX_BEENDET) zeilen.push(text([S(`  + ${gr.beendet.length - MAX_BEENDET} weitere`, { dim: true })]))
    }
    neu('sitzungen', zeilen)
  }

  // ---- Crew ---------------------------------------------------------------------------------------------
  const crew: Ansicht['crew'] = []
  {
    const zeilen: Zeile[] = []
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
    const figurVon = (a: LeitstandAgent): Figur => ({
      hutKey: a.id,
      haupt: false,
      zustand: agentMannZustand(a),
      modell: a.art === 'fork' ? 'fork' : a.modell || '…',
      familie: a.art === 'fork' ? 'fork' : modellFamilie(a.modell),
      name: kuerzen(a.name || a.typ || 'Agent', 10),
      beendet: a.stand === 'fertig' || a.stand === 'fehler' ? a.beendet : null,
    })
    const hauptFigur = (s: LeitstandSitzung): Figur => ({
      hutKey: s.sessionId,
      haupt: true,
      zustand: mannZustand(zustandJetzt(s, jetzt)),
      modell: s.modell,
      familie: modellFamilie(s.modell),
      name: 'Haupt',
      beendet: null,
    })
    // Spalten der Werkzeugzeilen (Werkzeug Ziel · Laufzeit · Anfragen · ↑↓); der Name steht nur ohne Figuren dabei.
    const mitName = !sprites
    const zeilenSp: Spalte[] = [
      { id: 'rand', min: 2, prio: 10 },
      { id: 'icon', min: 1, prio: 10 },
      ...(mitName ? [{ id: 'name', min: 10, max: 14, flex: true, prio: 10 } as Spalte] : []),
      { id: 'werk', min: 14, flex: true, rest: true, prio: 9 },
      { id: 'dauer', min: 5, prio: 7 },
      { id: 'anfr', min: 9, prio: 6 },
      { id: 'tok', min: 14, prio: 3 },
    ]
    const zw = waehle(zeilenSp, B)
    const werkzeugZeile = (key: string, ziel: KnopfZiel, a: { icon: string; ic: string; name: string; werk: Seg[]; dauerMs: number | null; z: LeitstandZaehler; gewaehlt: boolean }): Zeile => ({
      art: 'knopf',
      key,
      ziel,
      segs: zeileAus(zeilenSp, zw, {
        rand: { segs: [S('  ')] },
        icon: { segs: [S(a.icon, { c: a.ic })] },
        name: { segs: [S(a.name, { b: a.gewaehlt })] },
        werk: { segs: a.werk },
        dauer: { segs: a.dauerMs === null ? [] : [S(dauer(a.dauerMs), { dim: true })], ausr: 'r' },
        anfr: { segs: [S(a.z.anfragen > 0 ? `${ganzzahl(a.z.anfragen)} Anfr.` : '–', { dim: true })], ausr: 'r' },
        tok: {
          segs: a.z.anfragen > 0 ? [S('↑', { dim: true }), S(tokens(eingabeGesamt(a.z))), S(' ↓', { dim: true }), S(tokens(a.z.ausgabe))] : [S('–', { dim: true })],
          ausr: 'r',
        },
      }),
    })
    const agentWerk = (a: LeitstandAgent, zt: ZustandsText): Seg[] =>
      a.stand === 'laeuft' && a.werkzeug ? [S(a.werkzeug), S(a.ziel ? `  ${a.ziel}` : '', { dim: true })] : a.stand === 'laeuft' ? [S('arbeitet', { dim: true })] : [S(zt.wort, { c: zt.c })]
    const agentZt = (a: LeitstandAgent): ZustandsText =>
      a.stand === 'laeuft'
        ? { icon: '●', wort: '', c: modellFarbe(a.art === 'fork' ? 'fork' : modellFamilie(a.modell)) }
        : a.stand === 'wartet'
          ? { icon: '?', wort: 'wartet', c: FARBEN.akzent }
          : a.stand === 'fertig'
            ? { icon: '✓', wort: 'fertig', c: FARBEN.gut }
            : { icon: '✗', wort: 'Fehler', c: FARBEN.fehler }

    if (gewaehlt) {
      // ---- Detail einer Sitzung: Figuren mit Modell und Name darunter; die Liste nur mit Werkzeug, Ziel, Zeiten, Tokens ----
      const cs = gewaehlt
      const agents = sichtbareAgents(cs, jetzt)
      const hauptZst = zustandJetzt(cs, jetzt)
      const figuren: Figur[] = [hauptFigur(cs), ...agents.map(figurVon)]
      zeilen.push(text(abschnittsKopf(`CREW · ${kuerzen(name(cs), Math.max(6, B - 14))}`, B)))
      const proBand = jeBand(B)
      const gezeigt = figuren.slice(0, proBand * 2)
      if (sprites) {
        zeilen.push({ art: 'raster', key: 'crew', raster: crewZellen(gezeigt, B, Math.floor(jetzt / d.bildMs), jetzt, d.bildMs) })
        crew.push({ key: 'crew', figuren: gezeigt, spalten: B })
      }
      const hauptZt = zustandsText(hauptZst, cs.zustandSeit, jetzt)
      const hauptWerk: Seg[] =
        hauptZst === 'arbeitet' && cs.werkzeug
          ? [S(cs.werkzeug), S(cs.ziel ? `  ${cs.ziel}` : '', { dim: true })]
          : hauptZst === 'arbeitet'
            ? [S('arbeitet', { dim: true })]
            : [S(hauptZt.wort, { c: hauptZt.dim ? undefined : hauptZt.c, dim: hauptZt.dim })]
      zeilen.push(
        werkzeugZeile(`h:${cs.sessionId}`, { was: 'haupt', sitzungId: cs.sessionId }, {
          icon: hauptZt.icon,
          ic: hauptZt.c,
          name: 'Haupt',
          werk: hauptWerk,
          dauerMs: hauptZst === 'arbeitet' ? jetzt - cs.zustandSeit : null,
          z: cs.haupt,
          gewaehlt: d.aktion?.art === 'sitzung' && d.aktion.id === cs.sessionId,
        }),
      )
      zeilen.push(...aktionenFuer({ art: 'sitzung', id: cs.sessionId }, cs.sessionId !== d.eigeneId, hauptZst === 'arbeitet'))
      if (agents.length === 0) zeilen.push(text([S('  keine Subagents', { dim: true })]))
      for (const a of agents.slice(0, 12)) {
        const zt = agentZt(a)
        zeilen.push(
          werkzeugZeile(`g:${a.id}`, { was: 'agent', sitzungId: cs.sessionId, id: a.id }, {
            icon: zt.icon,
            ic: zt.c,
            name: a.name || a.typ || 'Agent',
            werk: agentWerk(a, zt),
            dauerMs: (a.beendet ?? jetzt) - a.gestartet,
            z: a.z,
            gewaehlt: d.aktion?.art === 'agent' && d.aktion.id === a.id,
          }),
        )
        zeilen.push(...aktionenFuer({ art: 'agent', id: a.id }, true, a.stand === 'laeuft'))
      }
      if (figuren.length > gezeigt.length || agents.length > 12) {
        zeilen.push(text([S(`  + ${Math.max(figuren.length - gezeigt.length, agents.length - 12)} weitere`, { dim: true })]))
      }
    } else {
      // ---- Übersicht: je aktiver Sitzung mit Inhalt ein Block: Name links, Figuren daneben, laufende Agents darunter ----
      zeilen.push(text(abschnittsKopf('CREW', B, gr.aktiv.length > 0 ? 'je Sitzung' : '')))
      if (gr.aktiv.length === 0) zeilen.push(text([S('  keine aktive Sitzung mit Inhalt', { dim: true })]))
      const kMax = Math.max(1, Math.min(MAX_FIGUREN, Math.floor((B - 16 + 1) / FIGUR_ABSTAND)))
      // Die Namensspalte wird nur so schmal, wie die größte Figurenreihe es verlangt (mehr Platz für lange Titel).
      const kBedarf = Math.max(1, ...gr.aktiv.slice(0, MAX_CREW_SITZUNGEN).map(s => 1 + sichtbareAgents(s, jetzt).length))
      const kSpalte = Math.min(kMax, kBedarf)
      const linksBreite = B - (kSpalte * FIGUR_ABSTAND - (FIGUR_ABSTAND - BREITE))
      for (const s of gr.aktiv.slice(0, MAX_CREW_SITZUNGEN)) {
        const agents = sichtbareAgents(s, jetzt)
        const laufende = agents.filter(a => a.stand === 'laeuft')
        const hauptZst = zustandJetzt(s, jetzt)
        const hauptZt = zustandsText(hauptZst, s.zustandSeit, jetzt)
        const alsBlock = sprites && !(v.leereCrewKompakt && agents.length === 0)
        const istEigen = s.sessionId === d.eigeneId
        const nameSegs: Seg[] = [S(hauptZt.icon, { c: hauptZt.c, b: hauptZt.b }), S(' '), S(name(s), { b: true, c: hauptZst === 'braucht' ? FARBEN.warnung : undefined }), ...(istEigen ? [S(' ◀', { c: FARBEN.koerper })] : [])]
        const zustandSegs: Seg[] = [S(hauptZt.wort, { c: hauptZt.dim ? undefined : hauptZt.c, dim: hauptZt.dim, b: hauptZt.b }), ...(hauptZst === 'arbeitet' ? [S(` · ${dauer(jetzt - s.zustandSeit)}`, { dim: true })] : [])]
        const drittes: Seg[] =
          hauptZst === 'arbeitet' && s.werkzeug
            ? [S(s.werkzeug, { dim: true }), S(s.ziel ? ` ${s.ziel}` : '', { dim: true })]
            : [S(agents.length === 0 ? 'keine Agents' : `${laufende.length} von ${agents.length} Agents laufen`, { dim: true })]
        if (alsBlock) {
          const gezeigt = [hauptFigur(s), ...agents.map(figurVon)].slice(0, kMax)
          const versteckt = agents.length - (gezeigt.length - 1)
          const spalten = gezeigt.length * FIGUR_ABSTAND - (FIGUR_ABSTAND - BREITE)
          const links = (segs: Seg[]) => [...passend(segs, linksBreite - 1), S(' ')]
          const kopfLinks: Seg[][] = [[S(' '.repeat(linksBreite))], links(nameSegs), links([S('  '), ...zustandSegs]), links([S('  '), ...drittes]), [S(' '.repeat(linksBreite))], [S(' '.repeat(linksBreite))]]
          const schluessel = `crew:${s.sessionId}`
          zeilen.push({ art: 'block', key: schluessel, rasterKey: schluessel, links: kopfLinks, raster: crewZellen(gezeigt, spalten, Math.floor(jetzt / d.bildMs), jetzt, d.bildMs), rechts: kopfLinks.map(() => []) })
          crew.push({ key: schluessel, figuren: gezeigt, spalten })
          if (versteckt > 0) zeilen.push(text([S(`  + ${versteckt} weitere Agent${versteckt === 1 ? '' : 's'}`, { dim: true })]))
        } else {
          const kopf = [...nameSegs, S('  '), ...zustandSegs]
          const zusatz = agents.length > 0 ? `  · ${laufende.length}/${agents.length} Agents` : ''
          zeilen.push(text([...kopf, S(segBreite(kopf) + W(zusatz) <= B ? zusatz : '', { dim: true })]))
        }
        for (const a of laufende.slice(0, 6)) {
          const zt = agentZt(a)
          zeilen.push(
            werkzeugZeile(`g:${a.id}`, { was: 'agent', sitzungId: s.sessionId, id: a.id }, {
              icon: zt.icon,
              ic: zt.c,
              name: a.name || a.typ || 'Agent',
              werk: agentWerk(a, zt),
              dauerMs: (a.beendet ?? jetzt) - a.gestartet,
              z: a.z,
              gewaehlt: false,
            }),
          )
        }
        if (laufende.length > 6) zeilen.push(text([S(`  + ${laufende.length - 6} weitere laufende`, { dim: true })]))
      }
      if (gr.aktiv.length > MAX_CREW_SITZUNGEN) zeilen.push(text([S(`  + ${gr.aktiv.length - MAX_CREW_SITZUNGEN} weitere Sitzungen`, { dim: true })]))
    }
    neu('crew', zeilen)
  }

  // ---- Modelle (gleicher Umfang wie die Kacheln) --------------------------------------------------------
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
    if (liste.length > 6) zeilen.push(text([S(`  + ${liste.length - 6} weitere Modelle`, { dim: true })]))
    neu('modelle', zeilen)
  }

  // ---- Fuß ---------------------------------------------------------------------------------------------
  if (!v.ohneFuss) {
    const hilfe = voll ? ' /leitstand schließt · Klick oder Tab+Enter wählt · a Alle' : ' /leitstand schließt · Klick wählt'
    neu('fuss', [text(linie(B)), text([S(hilfe, { dim: true })])])
  }

  return { zeilen: abschnitte.flatMap(a => a.zeilen), crew, stufe }
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
