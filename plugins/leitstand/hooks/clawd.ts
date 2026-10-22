// Pixel-Clawd: ein Raster aus 9 × 8 Pixeln, je zwei Pixelzeilen werden zu einer Textzeile
// (Halbblöcke ▀ ▄ █ mit Vorder- und Hintergrundfarbe). Ergebnis: 9 Spalten breit, 4 Zeilen hoch.

export type Px = string | null
export type Lauf = { text: string; fg?: string; bg?: string }
export type HutName = 'cowboy' | 'party' | 'krone' | 'cap' | 'zauber' | 'kopfhoerer' | 'keiner'
export type MannZustand = 'arbeitet' | 'wartet' | 'ruht' | 'fertig' | 'fehler'

export const HUETE: readonly HutName[] = ['cowboy', 'party', 'krone', 'cap', 'zauber', 'kopfhoerer', 'keiner']

export const BREITE = 9
export const HOEHE = 8
export const FARBE = {
  koerper: '#D97757',
  bein: '#B35A3E',
  auge: '#111111',
  augeZu: '#8F4A33',
  fehler: '#C0392B',
  fehlerBein: '#8E2A20',
}
const MODELL_FARBEN: Record<string, string> = {
  haiku: '#3FB950',
  sonnet: '#4C8DF6',
  opus: '#A371F7',
  fork: '#E3B341',
}
export function modellFarbe(modell: string): string {
  return MODELL_FARBEN[modell] ?? '#8B949E'
}

/** Stabile Zahl aus einem Text (FNV-1a). */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Der Hut hängt nur an der Kennung (agentId bzw. sessionId): gleicher Agent, gleicher Hut. */
export function hutFuer(schluessel: string): HutName {
  return HUETE[hash(schluessel) % HUETE.length]!
}

function leer(): Px[][] {
  return Array.from({ length: HOEHE }, () => Array<Px>(BREITE).fill(null))
}

function setze(g: Px[][], zeile: number, spalten: number[], farbe: Px) {
  const z = g[zeile]
  if (!z) return
  for (const c of spalten) if (c >= 0 && c < BREITE) z[c] = farbe
}
const von = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

function hutZeichnen(g: Px[][], hut: HutName) {
  switch (hut) {
    case 'cowboy':
      setze(g, 0, von(3, 5), '#6B4423')
      setze(g, 1, von(0, 8), '#8B5A2B')
      break
    case 'party':
      setze(g, 0, [4], '#F2D14B')
      setze(g, 1, von(3, 5), '#E056C8')
      break
    case 'krone':
      setze(g, 0, [1, 3, 5, 7], '#F2C94C')
      setze(g, 1, von(1, 7), '#F2C94C')
      break
    case 'cap':
      setze(g, 0, von(2, 6), '#3B6FB6')
      setze(g, 1, von(1, 8), '#3B6FB6')
      break
    case 'zauber':
      setze(g, 0, [4], '#6A3FA0')
      setze(g, 1, von(2, 6), '#6A3FA0')
      setze(g, 1, [4], '#F5D76E')
      break
    case 'kopfhoerer':
      setze(g, 1, von(1, 7), '#3A3F47')
      setze(g, 2, [0, 8], '#2B2F36')
      setze(g, 3, [0, 8], '#2B2F36')
      break
    case 'keiner':
      break
  }
}

export type BildOptionen = {
  hut: HutName
  zustand: MannZustand
  /** Bildzähler der Animation (arbeitet/wartet/ruht). */
  tick: number
  /** Bilder seit dem Ende (nur für „fertig“: die ersten vier sind der Hüpfer). */
  phase?: number
}

type Pose = { beine: 'beide' | 'A' | 'B'; armL: 'unten' | 'oben'; armR: 'unten' | 'oben'; augenZu: boolean; hoch: boolean }

export function poseFuer(o: BildOptionen): Pose {
  const t = o.tick
  switch (o.zustand) {
    case 'arbeitet':
      return { beine: t % 2 === 0 ? 'A' : 'B', armL: t % 2 === 0 ? 'oben' : 'unten', armR: t % 2 === 0 ? 'unten' : 'oben', augenZu: false, hoch: false }
    case 'wartet':
      return { beine: 'beide', armL: 'unten', armR: 'unten', augenZu: t % 8 === 6 || t % 8 === 7, hoch: false }
    case 'ruht':
      return { beine: 'beide', armL: 'unten', armR: 'unten', augenZu: true, hoch: false }
    case 'fertig': {
      const p = o.phase ?? 99
      const huepft = p < 4
      return { beine: 'beide', armL: huepft ? 'oben' : 'unten', armR: huepft ? 'oben' : 'unten', augenZu: false, hoch: huepft && p % 2 === 0 }
    }
    case 'fehler':
      return { beine: 'beide', armL: 'unten', armR: 'unten', augenZu: false, hoch: false }
  }
}

/** Das Pixelraster eines Männchens (Zeilen 0–1 Hut, 2–7 Körper). */
export function raster(o: BildOptionen): Px[][] {
  const pose = poseFuer(o)
  const fehler = o.zustand === 'fehler'
  const koerper = fehler ? FARBE.fehler : FARBE.koerper
  const bein = fehler ? FARBE.fehlerBein : FARBE.bein
  const g = leer()
  hutZeichnen(g, o.hut)
  setze(g, 2, von(1, 7), koerper)
  setze(g, 3, von(1, 7), koerper)
  setze(g, 3, [2, 6], pose.augenZu ? FARBE.augeZu : FARBE.auge)
  setze(g, 4, von(1, 7), koerper)
  setze(g, 5, von(1, 7), koerper)
  const armZeile = (seite: 'unten' | 'oben') => (seite === 'oben' ? 3 : 4)
  setze(g, armZeile(pose.armL), [0], koerper)
  setze(g, armZeile(pose.armR), [8], koerper)
  const unten = pose.beine === 'A' ? [1, 5] : pose.beine === 'B' ? [3, 7] : [1, 3, 5, 7]
  setze(g, 6, [1, 3, 5, 7], bein)
  setze(g, 7, unten, bein)
  if (!pose.hoch) return g
  // Hüpfer: alles eine Pixelzeile höher, unten bleibt der Boden leer.
  return [...g.slice(1), Array<Px>(BREITE).fill(null)]
}

/** Zwei Pixelzeilen zu einer Textzeile aus Halbblöcken. */
export function zeilen(g: Px[][]): Lauf[][] {
  const ergebnis: Lauf[][] = []
  for (let r = 0; r < g.length; r += 2) {
    const oben = g[r] ?? []
    const unten = g[r + 1] ?? []
    const laeufe: Lauf[] = []
    for (let c = 0; c < BREITE; c++) {
      const t = oben[c] ?? null
      const b = unten[c] ?? null
      let lauf: Lauf
      if (!t && !b) lauf = { text: ' ' }
      else if (t && b) lauf = t === b ? { text: '█', fg: t } : { text: '▀', fg: t, bg: b }
      else if (t) lauf = { text: '▀', fg: t }
      else lauf = { text: '▄', fg: b! }
      const letzter = laeufe[laeufe.length - 1]
      if (letzter && letzter.fg === lauf.fg && letzter.bg === lauf.bg) {
        letzter.text += lauf.text
      } else laeufe.push(lauf)
    }
    ergebnis.push(laeufe)
  }
  return ergebnis
}

/** Das Zeichen neben dem Männchen: ⌨ beim Arbeiten (animiert), ? beim Warten, ✓ / ✗ am Ende. */
export function zusatz(o: BildOptionen): string {
  switch (o.zustand) {
    case 'arbeitet':
      return ['⌨ ', '⌨·', '⌨··'][o.tick % 3]!
    case 'wartet':
      return '?'
    case 'ruht':
      return 'z'
    case 'fertig':
      return '✓'
    case 'fehler':
      return '✗'
  }
}

export function zusatzFarbe(zustand: MannZustand): string {
  return zustand === 'fertig' ? '#3FB950' : zustand === 'fehler' ? '#F85149' : zustand === 'wartet' ? '#E3B341' : '#8B949E'
}

export function maennchen(o: BildOptionen): { zeilen: Lauf[][]; zusatz: string } {
  return { zeilen: zeilen(raster(o)), zusatz: zusatz(o) }
}

/** Alle Zeichen einer Zeilenliste als Text (für Tests und Vergleiche). */
export function alsText(z: Lauf[][]): string {
  return z.map(l => l.map(x => x.text).join('')).join('\n')
}
