// Pixel-Männchen und Ring-Diagramm als Zellraster (`Raster`): je Zelle ein Zeichen mit Vorder- und Hintergrundfarbe.
// Ein Männchen ist 11 × 8 Pixel; je zwei Pixelzeilen werden zu einer Textzeile aus Halbblöcken (▀ ▄ █): 11 Spalten × 4 Zeilen.

// ---- Zellraster -------------------------------------------------------------------------------------

/** Farbe „Standard des Terminals" (Bit 24 allein), wie `RasterProps` sie vorsieht. */
export const STANDARD = 0x0100_0000

/** „#RRGGBB" → 0xRRGGBB. */
export function farbe(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) & 0xff_ffff
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 (mit Auffüllung), ohne auf btoa angewiesen zu sein. */
export function base64(bytes: Uint8Array): string {
  let aus = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    aus += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    aus += b === undefined ? '=' : B64[(n >> 6) & 63]!
    aus += c === undefined ? '=' : B64[n & 63]!
  }
  return aus
}

/** Ein Raster aus Zellen; `kodiere()` liefert das Packformat von `RasterProps.cells`. */
export class Zellen {
  readonly cp: Uint32Array
  readonly fg: Uint32Array
  readonly bg: Uint32Array

  constructor(
    readonly spalten: number,
    readonly zeilen: number,
  ) {
    const n = spalten * zeilen
    this.cp = new Uint32Array(n).fill(0x20)
    this.fg = new Uint32Array(n).fill(STANDARD)
    this.bg = new Uint32Array(n).fill(STANDARD)
  }

  setze(x: number, y: number, zeichen: string, fg: number = STANDARD, bg: number = STANDARD) {
    if (x < 0 || y < 0 || x >= this.spalten || y >= this.zeilen) return
    const i = y * this.spalten + x
    this.cp[i] = zeichen.codePointAt(0) ?? 0x20
    this.fg[i] = fg
    this.bg[i] = bg
  }

  /** Text ab (x, y), Zeichen für Zeichen; nichts außerhalb des Rasters. */
  text(x: number, y: number, text: string, fg: number = STANDARD, bg: number = STANDARD) {
    let i = 0
    for (const z of Array.from(text)) this.setze(x + i++, y, z, fg, bg)
  }

  /** Text mittig in einer Spalten-Breite ab x. */
  mitte(x: number, y: number, breite: number, text: string, fg: number = STANDARD) {
    const z = Array.from(text)
    const kurz = z.length > breite ? [...z.slice(0, Math.max(0, breite - 1)), '…'] : z
    this.text(x + Math.floor((breite - kurz.length) / 2), y, kurz.join(''), fg)
  }

  kodiere(): string {
    const n = this.spalten * this.zeilen
    const woerter = new Uint32Array(n * 3)
    for (let i = 0; i < n; i++) {
      woerter[i * 3] = this.cp[i]!
      woerter[i * 3 + 1] = this.fg[i]!
      woerter[i * 3 + 2] = this.bg[i]!
    }
    // Little-Endian-Bytes ohne Abhängigkeit von der Plattform-Reihenfolge.
    const bytes = new Uint8Array(woerter.length * 4)
    for (let i = 0; i < woerter.length; i++) {
      const w = woerter[i]!
      bytes[i * 4] = w & 0xff
      bytes[i * 4 + 1] = (w >>> 8) & 0xff
      bytes[i * 4 + 2] = (w >>> 16) & 0xff
      bytes[i * 4 + 3] = (w >>> 24) & 0xff
    }
    return base64(bytes)
  }
}

// ---- Farben -----------------------------------------------------------------------------------------

export const FARBEN = {
  akzent: '#A78BFA',
  opus: '#C084FC',
  sonnet: '#60A5FA',
  haiku: '#4ADE80',
  fork: '#FACC15',
  warnung: '#F59E0B',
  fehler: '#F87171',
  gut: '#4ADE80',
  grau: '#6B7280',
  koerper: '#D97757',
  auge: '#1A1A1A',
} as const

export function modellFarbe(familie: string): string {
  switch (familie) {
    case 'opus':
      return FARBEN.opus
    case 'sonnet':
      return FARBEN.sonnet
    case 'haiku':
      return FARBEN.haiku
    case 'fork':
      return FARBEN.fork
    default:
      return '#9CA3AF'
  }
}

// ---- Männchen -----------------------------------------------------------------------------------------

export type Px = string | null
export type HutName = 'cowboy' | 'party' | 'krone' | 'cap' | 'zauberer' | 'muetze' | 'kopfhoerer'
export type MannZustand = 'arbeitet' | 'wartet' | 'braucht' | 'ruht' | 'fertig' | 'fehler'

export const HUETE: readonly HutName[] = ['cowboy', 'party', 'krone', 'cap', 'zauberer', 'muetze', 'kopfhoerer']
/** Die Krone gehört der Hauptsitzung; Agents tragen einen der anderen sechs. */
const AGENT_HUETE: readonly HutName[] = HUETE.filter(h => h !== 'krone')

export const BREITE = 11
/** Zellen-Zeilen eines Männchens (8 Pixelzeilen). */
export const HOEHE = 4

const HUT_KARTEN: Record<HutName, { farben: Record<string, string>; zeilen: [string, string, string] }> = {
  cowboy: { farben: { H: '#8B5A2B', D: '#5C3A1A' }, zeilen: ['....HHH....', '...HDDDH...', 'HHHHHHHHHHH'] },
  party: { farben: { P: '#F472B6', Y: '#FDE047' }, zeilen: ['.....Y.....', '....PYP....', '...PPPPP...'] },
  krone: { farben: { G: '#FACC15' }, zeilen: ['...G.G.G...', '...GGGGG...', '...........'] },
  cap: { farben: { C: '#3B82F6' }, zeilen: ['...CCCC....', '..CCCCCCC..', '..CCCCCCCCC'] },
  zauberer: { farben: { W: '#7C3AED', S: '#FDE047' }, zeilen: ['.....W.....', '....WSW....', '..WWWWWWW..'] },
  muetze: { farben: { R: '#EF4444', w: '#F5F5F5' }, zeilen: ['....RRR....', '..RRRRRRR..', '..RwRwRwR..'] },
  kopfhoerer: { farben: { K: '#9CA3AF' }, zeilen: ['...KKKKK...', '..K.....K..', '..K.....K..'] },
}

/** Der Körper (5 Pixelzeilen unter den 3 Hutzeilen): B Körper, E Auge. */
const KOERPER = ['..BBBBBBB..', '..BEBBBEB..', 'BBBBBBBBBBB', '..BBBBBBB..', '..B.B.B.B..']
const BEINE_B = '.B.B...B.B.'

/** Stabile Zahl aus einem Text (FNV-1a). */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Der Hut hängt nur an der Kennung (agentId bzw. sessionId): gleicher Agent, gleicher Hut. Die Hauptsitzung trägt immer die Krone. */
export function hutFuer(schluessel: string, haupt = false): HutName {
  if (haupt) return 'krone'
  return AGENT_HUETE[hash(schluessel) % AGENT_HUETE.length]!
}

export type MannOptionen = {
  hut: HutName
  zustand: MannZustand
  /** Bildzähler der Animation (4 Bilder je Sekunde). */
  tick: number
  /** Bilder seit dem Ende (für „fertig": die ersten beiden sind der Hüpfer). */
  phase?: number
}

type Pose = { beine: 'A' | 'B'; armL: boolean; armR: boolean; augen: 'auf' | 'zu' | 'strich'; hoch: boolean }

/** Blinzeln: alle 12 Bilder (3 s) ein Bild lang. */
export const BLINZEL_PERIODE = 12

export function poseFuer(o: MannOptionen): Pose {
  const t = o.tick
  switch (o.zustand) {
    case 'arbeitet':
      return { beine: t % 2 === 0 ? 'A' : 'B', armL: t % 2 === 0, armR: t % 2 !== 0, augen: 'auf', hoch: false }
    case 'wartet':
      return { beine: 'A', armL: false, armR: false, augen: t % BLINZEL_PERIODE === BLINZEL_PERIODE - 1 ? 'zu' : 'auf', hoch: false }
    case 'braucht':
      return { beine: 'A', armL: false, armR: false, augen: t % BLINZEL_PERIODE === BLINZEL_PERIODE - 1 ? 'zu' : 'auf', hoch: t % 4 < 2 }
    case 'ruht':
      return { beine: 'A', armL: false, armR: false, augen: 'strich', hoch: false }
    case 'fertig': {
      const p = o.phase ?? 99
      return { beine: 'A', armL: p < 2, armR: p < 2, augen: 'auf', hoch: p < 2 }
    }
    case 'fehler':
      return { beine: 'A', armL: false, armR: false, augen: 'auf', hoch: false }
  }
}

/** Das Pixelraster eines Männchens: 8 Zeilen à 11 Spalten (3 Hut, 5 Körper). */
export function pixel(o: MannOptionen): Px[][] {
  const pose = poseFuer(o)
  const koerper = o.zustand === 'fehler' ? FARBEN.fehler : FARBEN.koerper
  const karte = HUT_KARTEN[o.hut]
  const zeilen: string[] = [...karte.zeilen, ...KOERPER]
  const g: Px[][] = zeilen.map((z, y) =>
    Array.from(z).map(c => {
      if (c === '.') return null
      if (y >= 3) return c === 'B' ? koerper : FARBEN.auge
      return karte.farben[c] ?? null
    }),
  )
  const setze = (y: number, xs: number[], f: Px) => {
    for (const x of xs) if (g[y]) g[y]![x] = f
  }
  // Beine
  const beine = pose.beine === 'A' ? '..B.B.B.B..' : BEINE_B
  g[7] = Array.from(beine).map(c => (c === 'B' ? koerper : null))
  // Arme: unten in Körperzeile 2 (Pixelzeile 5), hoch in Körperzeile 1 (Pixelzeile 4)
  if (pose.armL) {
    setze(5, [0, 1], null)
    setze(4, [0, 1], koerper)
  }
  if (pose.armR) {
    setze(5, [9, 10], null)
    setze(4, [9, 10], koerper)
  }
  // Augen
  if (pose.augen === 'zu') setze(4, [3, 7], koerper)
  if (pose.augen === 'strich') {
    setze(4, [3, 7], koerper)
    setze(5, [3, 7], FARBEN.auge)
  }
  if (!pose.hoch) return g
  // Hüpfer: alles eine Pixelzeile höher; die oberste Hutzeile fällt weg, unten bleibt der Boden leer.
  return [...g.slice(1), Array<Px>(BREITE).fill(null)]
}

/** Die vier Textzeilen aus je zwei Pixelzeilen; Hintergrund = Terminal (transparent). */
export function maleMann(z: Zellen, x0: number, y0: number, o: MannOptionen) {
  const g = pixel(o)
  for (let r = 0; r < HOEHE; r++) {
    const oben = g[r * 2] ?? []
    const unten = g[r * 2 + 1] ?? []
    for (let c = 0; c < BREITE; c++) {
      const t = oben[c] ?? null
      const b = unten[c] ?? null
      if (!t && !b) continue
      if (t && b) {
        if (t === b) z.setze(x0 + c, y0 + r, '█', farbe(t))
        else z.setze(x0 + c, y0 + r, '▀', farbe(t), farbe(b))
      } else if (t) z.setze(x0 + c, y0 + r, '▀', farbe(t))
      else z.setze(x0 + c, y0 + r, '▄', farbe(b!))
    }
  }
  // Zeichen oben rechts (dort ist in jedem Hut Platz).
  const [zeichen, fg] = zeichenFuer(o)
  if (zeichen) z.setze(x0 + BREITE - 1, y0, zeichen, farbe(fg))
}

/** Das Zeichen neben dem Männchen: Tastatur blinkt beim Arbeiten, ? beim Warten, ! bei Erlaubnis, ✓/✗ am Ende, z beim Ruhen. */
export function zeichenFuer(o: MannOptionen): [string, string] {
  switch (o.zustand) {
    case 'arbeitet':
      return [o.tick % 2 === 0 ? '⌨' : '·', FARBEN.sonnet]
    case 'wartet':
      return ['?', FARBEN.akzent]
    case 'braucht':
      return ['!', FARBEN.warnung]
    case 'ruht':
      return ['z', FARBEN.grau]
    case 'fertig':
      return ['✓', FARBEN.gut]
    case 'fehler':
      return ['✗', FARBEN.fehler]
  }
}

// ---- Crew-Streifen ---------------------------------------------------------------------------------------

export type Figur = {
  /** Schlüssel für den Hut (agentId bzw. sessionId). */
  hutKey: string
  haupt: boolean
  zustand: MannZustand
  /** Bezeichnung des Modells („opus 5.5") und seine Familie für die Farbe. */
  modell: string
  familie: string
  name: string
  /** Ende (ms) für den einmaligen Hüpfer bei „fertig". */
  beendet: number | null
}

export const FIGUR_ABSTAND = 12
/** Textzeilen je Figur: 4 Bild, Modell, Name. */
export const FIGUR_ZEILEN = HOEHE + 2

/** Wie viele Figuren nebeneinander in `spalten` Spalten passen. */
export function jeBand(spalten: number): number {
  return Math.max(1, Math.floor((spalten + (FIGUR_ABSTAND - BREITE)) / FIGUR_ABSTAND))
}

export function crewHoehe(anzahl: number, spalten: number): number {
  const baender = Math.ceil(anzahl / jeBand(spalten))
  return baender * FIGUR_ZEILEN + (baender - 1)
}

/** Alle Figuren in ein Raster zeichnen (ein Raster, ein `blit` je Bild). */
export function crewZellen(figuren: Figur[], spalten: number, tick: number, jetzt: number, bildMs: number): Zellen {
  const n = jeBand(spalten)
  const z = new Zellen(spalten, crewHoehe(figuren.length, spalten))
  figuren.forEach((f, i) => {
    const x0 = (i % n) * FIGUR_ABSTAND
    const y0 = Math.floor(i / n) * (FIGUR_ZEILEN + 1)
    const phase = f.beendet === null ? undefined : Math.floor((jetzt - f.beendet) / bildMs)
    maleMann(z, x0, y0, { hut: hutFuer(f.hutKey, f.haupt), zustand: f.zustand, tick, phase })
    z.mitte(x0, y0 + HOEHE, BREITE, f.modell, farbe(modellFarbe(f.familie)))
    z.mitte(x0, y0 + HOEHE + 1, BREITE, f.name, STANDARD)
  })
  return z
}

// ---- Ring (Braille) -----------------------------------------------------------------------------------------

const BRAILLE_BIT: Array<[number, number, number]> = [
  [0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08], [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80],
]

export const RING_SPALTEN = 10
export const RING_ZEILEN = 5

/**
 * Ein Ring aus Braille-Punkten, im Uhrzeigersinn ab oben zu `anteil` (0 bis 1) farbig, der Rest gedimmt.
 * Die Mitte bleibt frei für `mitte` (z. B. „95 %"). Eine Zelle trägt nur eine Farbe: an der Grenze entscheidet die Mehrheit ihrer Punkte.
 */
export function ringZellen(anteil: number | null, mitte: string, fuell: string, rest: string): Zellen {
  const z = new Zellen(RING_SPALTEN, RING_ZEILEN)
  const bw = RING_SPALTEN * 2
  const bh = RING_ZEILEN * 4
  const cx = bw / 2
  const cy = bh / 2
  const aussen = Math.min(bw, bh) / 2 - 0.4
  const innen = aussen - 2.2
  const a = anteil === null ? 0 : Math.max(0, Math.min(1, anteil))
  for (let zy = 0; zy < RING_ZEILEN; zy++) {
    for (let zx = 0; zx < RING_SPALTEN; zx++) {
      let bits = 0
      let gefuellt = 0
      let punkte = 0
      for (const [dx, dy, bit] of BRAILLE_BIT) {
        const px = zx * 2 + dx + 0.5
        const py = zy * 4 + dy + 0.5
        const r = Math.hypot(px - cx, py - cy)
        if (r < innen || r > aussen) continue
        bits |= bit
        punkte++
        let w = Math.atan2(px - cx, -(py - cy)) // 0 oben, im Uhrzeigersinn wachsend
        if (w < 0) w += Math.PI * 2
        if (w / (Math.PI * 2) < a) gefuellt++
      }
      if (bits === 0) continue
      z.setze(zx, zy, String.fromCodePoint(0x2800 + bits), farbe(gefuellt * 2 >= punkte && gefuellt > 0 ? fuell : rest))
    }
  }
  const zeile = Math.floor(RING_ZEILEN / 2)
  z.mitte(2, zeile, RING_SPALTEN - 4, mitte, anteil === null ? farbe(rest) : farbe(fuell))
  return z
}
