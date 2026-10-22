import type {
  LeitstandAgent,
  LeitstandAufruf,
  LeitstandEigen,
  LeitstandLimit,
  LeitstandSitzung,
  LeitstandZaehler,
  LeitstandZustand,
} from '../types'

/** Ohne Herzschlag seit so langer Zeit gilt eine Sitzung nicht mehr als aktiv. */
export const TOT_MS = 3 * 60_000
/** Nach so langer Zeit ohne Antwort gilt der Prompt-Cache als kalt (Schätzung). */
export const CACHE_MS = 60 * 60_000
/** Nach so langer Zeit ohne Zug geht „wartet" in „ruht" über. */
export const RUHT_MS = 30 * 60_000
/** Fertige Agents bleiben so lange sichtbar. */
export const FERTIG_ZEIGEN_MS = 10 * 60_000
/** Ein „laufender" Agent ohne jede Regung und ohne Eintrag in der Agent-Liste gilt danach als beendet. */
export const AGENT_STILL_MS = 20 * 60_000
/** Eine Erlaubnis-Frage zählt erst nach so langer Wartezeit als „braucht dich" (kurze Entscheidungen, etwa eines Prüfers im Auto-Modus, blitzen nicht auf). */
export const BRAUCHT_NACH_MS = 4000
/** Zählbeginn gilt als „später" als der Sitzungsbeginn ab dieser Lücke. */
export const ZAEHL_LUECKE_MS = 60_000
export const ZIEL_MAX = 60

// ---- Texte -----------------------------------------------------------------------------------------

export function kuerzen(text: string, max = ZIEL_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`
}

export function basename(pfad: string): string {
  const teile = pfad.split(/[\\/]/).filter(Boolean)
  return teile[teile.length - 1] ?? ''
}

/** Wörter der userConfig `ausblenden`, klein, ohne Leere. */
export function ausblendenListe(roh: unknown): string[] {
  return String(roh ?? '')
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(Boolean)
}

/** Privates: nennt Arbeitsordner (ganzer Pfad) eines der Wörter, schreibt die Sitzung nichts. */
export function istVersteckt(cwd: string, woerter: string[]): boolean {
  const c = cwd.toLowerCase()
  return woerter.some(w => c.includes(w))
}

// ---- Zahlen, deutsch formatiert --------------------------------------------------------------------

/** 1234,5 → „1.234,5" (Tausenderpunkt, Dezimalkomma). */
export function dezimal(n: number, stellen: number): string {
  const [ganz = '0', rest] = Math.abs(n).toFixed(stellen).split('.')
  const mitPunkt = ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${n < 0 ? '-' : ''}${mitPunkt}${rest ? `,${rest}` : ''}`
}

/** Ganzzahl mit Tausenderpunkt: 1234 → „1.234". */
export function ganzzahl(n: number): string {
  return dezimal(Math.round(n), 0)
}

/** Token-Zahlen kurz: 842 · 1,2 k · 212 k · 1,9 M · 38,4 M. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${dezimal(n / 1000, 1)} k`
  if (n < 999_500) return `${Math.round(n / 1000)} k`
  if (n < 999_950_000) return `${dezimal(n / 1_000_000, 1)} M`
  return `${dezimal(n / 1_000_000_000, 2)} Mrd`
}

/** „$ 18,42". */
export function dollar(betrag: number): string {
  return `$ ${dezimal(betrag, 2)}`
}

export function prozent(p: number): string {
  return `${Math.round(p)} %`
}

export function dauer(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `0:${String(s).padStart(2, '0')}`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** Dauer grob für „wartet 3 m": 45 s → „<1 m", 3 min → „3 m", 2 h 5 min → „2 h". */
export function vorZeit(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1 m'
  if (m < 60) return `${m} m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} T`
}

// ---- Zeit (lokale Zeit) --------------------------------------------------------------------------------

const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const zwei = (n: number) => String(n).padStart(2, '0')

/** Lokaler Tag als „JJJJ-MM-TT". */
export function tagKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`
}

/** Beginn des lokalen Tages (0:00) in ms. */
export function tagStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** „11:42" (lokal). */
export function uhr(ms: number): string {
  const d = new Date(ms)
  return `${zwei(d.getHours())}:${zwei(d.getMinutes())}`
}

/** Heute „14:00", sonst „Mo 09:00". */
export function resetZeit(ms: number, jetzt: number): string {
  if (tagKey(ms) === tagKey(jetzt)) return uhr(ms)
  return `${WOCHENTAGE[new Date(ms).getDay()]} ${uhr(ms)}`
}

// ---- Modelle ---------------------------------------------------------------------------------------------

export type Familie = 'opus' | 'sonnet' | 'haiku' | 'fork' | 'sonst'

/** Bezeichnung aus der Modell-ID: claude-opus-5-5 → „opus 5.5", claude-haiku-4-5-20251001 → „haiku 4.5". */
export function modellBezeichnung(modell: string): string {
  const m = modell.toLowerCase()
  const neu = m.match(/(opus|sonnet|haiku|fable|mythos)[-_ ](\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/)
  if (neu) return `${neu[1]} ${neu[2]}${neu[3] ? `.${neu[3]}` : ''}`
  const alt = m.match(/claude[-_](\d{1,2})(?:[-_.](\d{1,2}))?[-_](opus|sonnet|haiku)/)
  if (alt) return `${alt[3]} ${alt[1]}${alt[2] ? `.${alt[2]}` : ''}`
  const nur = m.match(/opus|sonnet|haiku|fable|mythos/)
  return nur ? nur[0] : kuerzen(modell, 14) || '?'
}

export function modellFamilie(bezeichnung: string): Familie {
  const t = bezeichnung.toLowerCase()
  if (t.startsWith('opus')) return 'opus'
  if (t.startsWith('sonnet')) return 'sonnet'
  if (t.startsWith('haiku')) return 'haiku'
  if (t === 'fork') return 'fork'
  return 'sonst'
}

// ---- Zähler ------------------------------------------------------------------------------------------------

export function leerZ(): LeitstandZaehler {
  return { anfragen: 0, eingabe: 0, cacheLesen: 0, cacheSchreiben: 0, ausgabe: 0 }
}

export function plusZ(a: LeitstandZaehler, b: LeitstandZaehler): LeitstandZaehler {
  return {
    anfragen: a.anfragen + b.anfragen,
    eingabe: a.eingabe + b.eingabe,
    cacheLesen: a.cacheLesen + b.cacheLesen,
    cacheSchreiben: a.cacheSchreiben + b.cacheSchreiben,
    ausgabe: a.ausgabe + b.ausgabe,
  }
}

export type Nutzung = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const nat = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Eine echte Anfrage dazuzählen (die vier Zahlen, wie die API sie meldet). */
export function zaehle(z: LeitstandZaehler, u: Nutzung): LeitstandZaehler {
  return {
    anfragen: z.anfragen + 1,
    eingabe: z.eingabe + nat(u.input_tokens),
    cacheLesen: z.cacheLesen + nat(u.cache_read_input_tokens),
    cacheSchreiben: z.cacheSchreiben + nat(u.cache_creation_input_tokens),
    ausgabe: z.ausgabe + nat(u.output_tokens),
  }
}

/** Alle Eingabe-Token der Anfragen: ohne Cache, aus dem Cache gelesen und in den Cache geschrieben. */
export function eingabeGesamt(z: LeitstandZaehler): number {
  return z.eingabe + z.cacheLesen + z.cacheSchreiben
}

/** Cache-Trefferquote in Prozent (gemessen): gelesen / alle Eingabe-Token; null ohne Eingabe. */
export function trefferQuote(z: LeitstandZaehler): number | null {
  const alle = eingabeGesamt(z)
  return alle > 0 ? (z.cacheLesen / alle) * 100 : null
}

/**
 * Geschätzte Ersparnis durch den Cache, als Anteil der Eingabekosten in Prozent (immer mit „≈" anzeigen).
 * Listenpreis-Verhältnisse der API: Lesen aus dem Cache kostet 0,1 × des normalen Eingabepreises (spart also 0,9 ×),
 * Schreiben in den Cache 1,25 ×. Bezugsgröße ist die Eingabe zum vollen Preis, Cache-Schreiben mit Aufschlag.
 * Es sind keine Preise eingebaut, nur diese Verhältnisse; echte Kosten je Modell sind nicht gemessen.
 */
export function cacheErsparnis(z: LeitstandZaehler): number | null {
  const nenner = z.eingabe + z.cacheLesen + 1.25 * z.cacheSchreiben
  if (nenner <= 0) return null
  return Math.max(0, Math.min(100, ((0.9 * z.cacheLesen) / nenner) * 100))
}

/** Hat die Mod erst nach Sitzungsbeginn (bzw. Tagesbeginn) zu zählen angefangen? Dann ab wann (ms), sonst null. */
export function zaehlLuecke(gestartet: number | null, zaehlSeit: number | null, jetzt: number): number | null {
  if (zaehlSeit === null) return null
  const beginn = Math.max(gestartet ?? zaehlSeit, tagStart(jetzt))
  return zaehlSeit - beginn > ZAEHL_LUECKE_MS ? zaehlSeit : null
}

/** Tageswechsel: alle Zähler fangen bei 0 an (die Dateien zählen „heute"). Die Kostenbasis zieht beim nächsten Messen nach. */
export function tagWechsel(eigen: LeitstandEigen, tag: string): LeitstandEigen {
  if (eigen.tag === tag) return eigen
  return {
    ...eigen,
    tag,
    zaehlSeit: null,
    gesamt: leerZ(),
    modelle: {},
    haupt: leerZ(),
    agents: Object.fromEntries(Object.entries(eigen.agents).map(([id, a]) => [id, { ...a, z: leerZ() }])),
    kostenBasis: null,
  }
}

/**
 * Kosten dieses Tages: Stand der Sitzung (/cost) minus Stand zu Tagesbeginn.
 * Begann die Sitzung heute, ist die Basis 0; sonst ist es der erste Messwert des Tages
 * (die Mod sieht den Teil davor nicht und rechnet ihn nicht ein).
 */
export function kostenBasisFuer(
  basis: { tag: string; usd: number } | null,
  tag: string,
  gestartet: number | null,
  jetzt: number,
  usd: number,
): { tag: string; usd: number } {
  // Sank der Stand (neues Kostenbuch, etwa nach /clear), zählt alles seit dem Neuanfang als heute.
  if (basis && basis.tag === tag) return basis.usd <= usd ? basis : { tag, usd: 0 }
  const heuteGestartet = gestartet !== null && gestartet >= tagStart(jetzt)
  return { tag, usd: heuteGestartet ? 0 : usd }
}

// ---- Ziel eines Werkzeugaufrufs: nie Befehlsinhalte, nie Secrets -------------------------------

/** Bei diesen Programmen ist das zweite Wort ein Unterbefehl, kein Argument mit Inhalt. */
const MIT_UNTERBEFEHL = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'git', 'docker', 'kubectl', 'make', 'cargo', 'go', 'gh', 'claude',
  'claude2', 'brew', 'pip', 'pip3', 'tsc', 'pytest', 'jest', 'vitest', 'graphify', 'helm', 'terraform', 'uv',
])
const MIT_DATEI = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'tsx', 'ts-node', 'ruby', 'php'])

/** Bash: nur das erste Wort plus (bei bekannten Programmen) Unterbefehl bzw. Skriptname. */
export function bashZiel(befehl: string): string {
  const segmente = befehl.split(/&&|\|\||;|\n|\|/).map(s => s.trim()).filter(Boolean)
  const segment = segmente.find(s => !/^cd(\s|$)/.test(s)) ?? segmente[0] ?? ''
  const woerter = segment.split(/\s+/).filter(Boolean)
  // Umgebungsvariablen vor dem Befehl (FOO=bar cmd) nie anzeigen.
  while (woerter.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(woerter[0]!)) woerter.shift()
  const erstes = basename(woerter[0] ?? '')
  if (!erstes || /=/.test(erstes)) return ''
  const zweites = woerter[1] ?? ''
  if (MIT_UNTERBEFEHL.has(erstes) && /^[a-z][a-z0-9:_-]{0,19}$/i.test(zweites)) return kuerzen(`${erstes} ${zweites}`)
  if (MIT_DATEI.has(erstes) && zweites && !zweites.startsWith('-') && !/[=?&"'`$]/.test(zweites)) {
    return kuerzen(`${erstes} ${basename(zweites)}`)
  }
  return kuerzen(erstes)
}

/** Kurzname des Werkzeugs: mcp__server__name → name. */
export function werkzeugName(tool: string): string {
  if (tool.startsWith('mcp__')) return tool.split('__').pop() || tool
  return tool
}

export function zielAus(tool: string, eingabe: Record<string, unknown>): string {
  const text = (k: string) => (typeof eingabe[k] === 'string' ? (eingabe[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return bashZiel(text('command'))
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return kuerzen(basename(text('file_path') || text('notebook_path')))
    case 'Grep':
    case 'Glob':
      return kuerzen(text('pattern'), 30)
    case 'Agent':
    case 'Task':
      return kuerzen(text('description'), 40)
    case 'WebFetch': {
      const m = text('url').match(/^https?:\/\/([^/?#:]+)/i)
      return m ? kuerzen(m[1]!) : ''
    }
    case 'WebSearch':
      return 'Websuche'
    case 'Workflow':
      return kuerzen(text('name') || 'Skript', 30)
    default:
      return ''
  }
}

// ---- Zustand und Anzeige --------------------------------------------------------------------------

/** Der Zustand der Hauptsitzung aus dem eigenen Stand. */
export function zustandVon(eigen: LeitstandEigen, jetzt: number): LeitstandZustand {
  if (eigen.braucht && jetzt - eigen.braucht.seit >= BRAUCHT_NACH_MS) return 'braucht'
  if (eigen.arbeitet) return 'arbeitet'
  return ruhtDanach(eigen.ende, eigen.seit, jetzt)
}

/** Seit wann der Zustand aus `zustandVon` gilt. */
export function zustandSeitVon(eigen: LeitstandEigen, jetzt: number): number {
  return eigen.braucht && jetzt - eigen.braucht.seit >= BRAUCHT_NACH_MS ? eigen.braucht.seit : eigen.seit
}

/** „wartet", „abgebrochen" und „Fehler" gehen nach 30 min ohne Zug in „ruht" über. */
export function ruhtDanach(z: LeitstandZustand, seit: number, jetzt: number): LeitstandZustand {
  if ((z === 'wartet' || z === 'abgebrochen' || z === 'fehler') && jetzt - seit > RUHT_MS) return 'ruht'
  return z
}

/** Zustand einer gelesenen Sitzung zum Zeitpunkt `jetzt` (ein alter Herzschlag kann „ruht" daraus machen). */
export function zustandJetzt(s: Pick<LeitstandSitzung, 'zustand' | 'zustandSeit'>, jetzt: number): LeitstandZustand {
  return ruhtDanach(s.zustand, s.zustandSeit, jetzt)
}

/** Cache (Schätzung): „warm" bis 60 min nach der letzten Antwort, danach „kalt"; null ohne bekannte Antwort. */
export function cacheStand(letzte: number | null, jetzt: number): 'warm' | 'kalt' | null {
  if (letzte === null) return null
  return jetzt - letzte < CACHE_MS ? 'warm' : 'kalt'
}

/** Aktiv = Herzschlag frisch und nicht beendet. */
export function istAktiv(s: Pick<LeitstandSitzung, 'herz' | 'beendet'>, jetzt: number): boolean {
  return s.beendet === null && typeof s.herz === 'number' && jetzt - s.herz <= TOT_MS
}

/** Aktuellstes laufendes Werkzeug (je Agent oder für die Hauptsitzung, wenn agentId fehlt). */
export function aktuell(aufrufe: Record<string, LeitstandAufruf>, agentId?: string): LeitstandAufruf | null {
  let best: LeitstandAufruf | null = null
  for (const a of Object.values(aufrufe)) {
    if ((a.agentId ?? undefined) !== agentId) continue
    if (!best || a.start >= best.start) best = a
  }
  return best
}

const SORT: Record<LeitstandZustand, number> = { braucht: 0, arbeitet: 1, wartet: 2, abgebrochen: 2, fehler: 2, ruht: 3 }

/** Eigene zuerst, dann nach Zustand, dann Projekt. */
export function sortieren(liste: LeitstandSitzung[], eigeneId: string, jetzt: number): LeitstandSitzung[] {
  return [...liste].sort((a, b) => {
    if (a.sessionId === eigeneId) return -1
    if (b.sessionId === eigeneId) return 1
    return SORT[zustandJetzt(a, jetzt)] - SORT[zustandJetzt(b, jetzt)] || a.projekt.localeCompare(b.projekt)
  })
}

// ---- Agents ----------------------------------------------------------------------------------------------------

/** Neuer Agent-Eintrag (noch ohne gezählte Anfrage). */
export function neuerAgent(id: string, teil: Partial<LeitstandAgent>, jetzt: number): LeitstandAgent {
  return {
    id,
    name: '',
    typ: '',
    art: 'agent',
    modell: '',
    stand: 'laeuft',
    werkzeug: null,
    ziel: '',
    gestartet: jetzt,
    beendet: null,
    aktiv: jetzt,
    z: leerZ(),
    ...teil,
  }
}

/** Agents für die Datei: laufende, wartende und fertige der letzten 10 min; die jüngsten 16. */
export function agentsFuerDatei(eigen: LeitstandEigen, jetzt: number): LeitstandAgent[] {
  return Object.values(eigen.agents)
    .filter(a => a.stand === 'laeuft' || a.stand === 'wartet' || (a.beendet !== null && jetzt - a.beendet < FERTIG_ZEIGEN_MS))
    .sort((a, b) => a.gestartet - b.gestartet)
    .slice(-16)
    .map(a => {
      const w = a.stand === 'laeuft' ? aktuell(eigen.aufrufe, a.id) : null
      return { ...a, werkzeug: w ? werkzeugName(w.werkzeug) : null, ziel: w ? w.ziel : '' }
    })
}

const STAND_REIHE: Record<LeitstandAgent['stand'], number> = { laeuft: 0, wartet: 1, fertig: 2, fehler: 2 }

/** Welche Agents einer gelesenen Sitzung noch anzuzeigen sind (laufende immer, fertige 10 min): laufende zuerst, dann die zuletzt beendeten. */
export function sichtbareAgents(s: LeitstandSitzung, jetzt: number): LeitstandAgent[] {
  return s.agents
    .filter(a => a.stand === 'laeuft' || a.stand === 'wartet' || (a.beendet !== null && jetzt - a.beendet < FERTIG_ZEIGEN_MS))
    .sort((a, b) => STAND_REIHE[a.stand] - STAND_REIHE[b.stand] || (STAND_REIHE[a.stand] === 2 ? (b.beendet ?? 0) - (a.beendet ?? 0) : a.gestartet - b.gestartet))
}

// ---- Eigener Stand → Herzschlag ----------------------------------------------------------------

export function leererEigenStand(): LeitstandEigen {
  return {
    geladen: false,
    tag: '',
    zaehlSeit: null,
    gesamt: leerZ(),
    modelle: {},
    haupt: leerZ(),
    arbeitet: false,
    ende: 'wartet',
    seit: 0,
    letzteAntwort: null,
    turnId: null,
    braucht: null,
    letzterSchritt: null,
    aufrufe: {},
    gesehen: {},
    agents: {},
    kostenBasis: null,
    nachClear: false,
  }
}

// ---- Lesen fremder Dateien: nichts glauben ------------------------------------------------------

const str = (v: unknown, max: number, vorgabe = '') => (typeof v === 'string' ? kuerzen(v, max) : vorgabe)
const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function pruefeZ(roh: unknown): LeitstandZaehler {
  if (!roh || typeof roh !== 'object') return leerZ()
  const z = roh as Record<string, unknown>
  return {
    anfragen: nat(z.anfragen),
    eingabe: nat(z.eingabe),
    cacheLesen: nat(z.cacheLesen),
    cacheSchreiben: nat(z.cacheSchreiben),
    ausgabe: nat(z.ausgabe),
  }
}

export function pruefeAgent(roh: unknown): LeitstandAgent | null {
  if (!roh || typeof roh !== 'object') return null
  const a = roh as Record<string, unknown>
  const id = str(a.id, 80)
  if (!id) return null
  const stand = a.stand === 'fertig' || a.stand === 'fehler' || a.stand === 'wartet' ? a.stand : 'laeuft'
  const art = a.art === 'fork' || a.art === 'workflow' || a.art === 'teammate' ? a.art : 'agent'
  return {
    id,
    name: str(a.name, 60),
    typ: str(a.typ, 30),
    art,
    modell: str(a.modell, 16),
    stand,
    werkzeug: typeof a.werkzeug === 'string' ? str(a.werkzeug, 30) : null,
    ziel: str(a.ziel, ZIEL_MAX),
    gestartet: zahl(a.gestartet) ?? 0,
    beendet: zahl(a.beendet),
    aktiv: zahl(a.aktiv) ?? zahl(a.gestartet) ?? 0,
    z: pruefeZ(a.z),
  }
}

export function pruefeLimits(roh: unknown): LeitstandLimit[] {
  if (!Array.isArray(roh)) return []
  const aus: LeitstandLimit[] = []
  for (const l of roh.slice(0, 6)) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    const p = zahl(o.prozent)
    if (p === null || typeof o.art !== 'string') continue
    aus.push({ art: str(o.art, 24), prozent: Math.max(0, p), reset: zahl(o.reset) })
  }
  return aus
}

const ZUSTAENDE: readonly LeitstandZustand[] = ['arbeitet', 'wartet', 'braucht', 'abgebrochen', 'fehler', 'ruht']

/**
 * Eine gelesene Herzschlag-Datei prüfen und in eine saubere Form bringen; null bei Unbrauchbarem.
 * Dateien der Mod 0.1 (ohne Zähler) werden als `alt` angenommen: sie zeigen sich in der Liste, zählen aber nicht in „heute".
 */
export function pruefeSitzung(roh: unknown): LeitstandSitzung | null {
  if (!roh || typeof roh !== 'object') return null
  const s = roh as Record<string, unknown>
  const id = str(s.sessionId, 80)
  const herz = zahl(s.herz)
  if (!id || herz === null) return null
  const agents = Array.isArray(s.agents) ? s.agents.slice(0, 20).map(pruefeAgent).filter((a): a is LeitstandAgent => a !== null) : []
  const modelle: Record<string, LeitstandZaehler> = {}
  if (s.modelle && typeof s.modelle === 'object') {
    for (const [k, v] of Object.entries(s.modelle as Record<string, unknown>).slice(0, 12)) modelle[kuerzen(k, 16)] = pruefeZ(v)
  }
  const neu = s.v === 2
  const zustandRoh = typeof s.zustand === 'string' && (ZUSTAENDE as readonly string[]).includes(s.zustand) ? (s.zustand as LeitstandZustand) : 'wartet'
  return {
    v: 2,
    sessionId: id,
    profil: str(s.profil, 40, '.claude'),
    projekt: str(s.projekt, 40, '?'),
    modell: str(s.modell, 16, '?'),
    kontextProzent: zahl(s.kontextProzent),
    gestartet: zahl(s.gestartet),
    zaehlSeit: neu ? zahl(s.zaehlSeit) : null,
    tag: str(s.tag, 10),
    gesamt: neu ? pruefeZ(s.gesamt) : leerZ(),
    haupt: neu ? pruefeZ(s.haupt) : leerZ(),
    modelle: neu ? modelle : {},
    kosten: zahl(s.kosten),
    kostenHeute: neu ? zahl(s.kostenHeute) : null,
    limits: pruefeLimits(s.limits),
    limitsZeit: zahl(s.limitsZeit),
    letzteAntwort: zahl(s.letzteAntwort),
    zustand: zustandRoh,
    zustandSeit: zahl(s.zustandSeit) ?? zahl(s.seit) ?? herz,
    werkzeug: typeof s.werkzeug === 'string' ? str(s.werkzeug, 30) : null,
    ziel: str(s.ziel, ZIEL_MAX),
    agents,
    beendet: zahl(s.beendet),
    herz,
    ...(neu ? {} : { alt: true as const }),
  }
}

/** Dateiname aus der Sitzungs-ID (nur sichere Zeichen). */
export function dateiName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.json`
}

/** Herzschlag nur schreiben, wenn sich etwas geändert hat oder der letzte Schlag älter als `maxAlterMs` ist. */
export function brauchtSchreiben(zuletzt: { json: string; zeit: number } | null, json: string, now: number, maxAlterMs = 30_000): boolean {
  return !zuletzt || zuletzt.json !== json || now - zuletzt.zeit >= maxAlterMs
}

// ---- Auswertung über Sitzungen ---------------------------------------------------------------------

export type Summen = {
  /** Aktive Sitzungen (Herzschlag frisch, nicht beendet). */
  aktiv: number
  agentsLaufen: number
  /** Heutige Kosten (gemessen); null, wenn keine Sitzung einen Messwert hat. */
  kostenHeute: number | null
  /** Sitzungen im Umfang, deren Datei keine Zähler kennt (Mod 0.1). */
  ohneZaehler: number
}

export function summen(liste: LeitstandSitzung[], jetzt: number): Summen {
  let kosten: number | null = null
  let ohne = 0
  let aktiv = 0
  let laufen = 0
  for (const s of liste) {
    if (s.alt) ohne++
    else if (s.kostenHeute !== null) kosten = (kosten ?? 0) + s.kostenHeute
    if (istAktiv(s, jetzt)) {
      aktiv++
      laufen += s.agents.filter(a => a.stand === 'laeuft').length
    }
  }
  return { aktiv, agentsLaufen: laufen, kostenHeute: kosten, ohneZaehler: ohne }
}

/** Summe der Zähler über Sitzungen (ohne Mod-0.1-Dateien). */
export function zaehlerSumme(liste: LeitstandSitzung[]): LeitstandZaehler {
  return liste.filter(s => !s.alt).reduce((z, s) => plusZ(z, s.gesamt), leerZ())
}

/** Summe je Modell über Sitzungen. */
export function modelleSumme(liste: LeitstandSitzung[]): Array<{ modell: string; z: LeitstandZaehler }> {
  const m = new Map<string, LeitstandZaehler>()
  for (const s of liste) {
    if (s.alt) continue
    for (const [k, z] of Object.entries(s.modelle)) m.set(k, plusZ(m.get(k) ?? leerZ(), z))
  }
  return [...m.entries()]
    .map(([modell, z]) => ({ modell, z }))
    .sort((a, b) => eingabeGesamt(b.z) + b.z.ausgabe - (eingabeGesamt(a.z) + a.z.ausgabe))
}

/** Späterer Zählbeginn im Umfang: der spätere der Zählanfänge der betroffenen Sitzungen, sonst null. */
export function zaehlBeginnNotiz(liste: LeitstandSitzung[], jetzt: number): number | null {
  let spaet: number | null = null
  for (const s of liste) {
    if (s.alt) continue
    const l = zaehlLuecke(s.gestartet, s.zaehlSeit, jetzt)
    if (l !== null && (spaet === null || l > spaet)) spaet = l
  }
  return spaet
}

/** Rate-Limits: je Profil der jüngste Messwert unter den Sitzungen; abgelaufene Fenster (Reset vorbei) fallen weg. */
export function limitsJeProfil(liste: LeitstandSitzung[], jetzt: number): Array<{ profil: string; limits: LeitstandLimit[]; zeit: number }> {
  const best = new Map<string, LeitstandSitzung>()
  for (const s of liste) {
    if (s.limits.length === 0 || s.limitsZeit === null) continue
    const alt = best.get(s.profil)
    if (!alt || (alt.limitsZeit ?? 0) < s.limitsZeit) best.set(s.profil, s)
  }
  return [...best.values()]
    .map(s => ({
      profil: s.profil,
      zeit: s.limitsZeit ?? 0,
      limits: s.limits.filter(l => l.reset === null || l.reset > jetzt),
    }))
    .filter(p => p.limits.length > 0)
    .sort((a, b) => a.profil.localeCompare(b.profil))
}

/** Beschriftung eines Limit-Fensters: „5 h", „7 T", sonst die Art. */
export function limitName(art: string): string {
  if (art === 'five_hour') return '5 h'
  if (art === 'seven_day') return '7 T'
  if (art === 'spend_limit') return 'Limit'
  return kuerzen(art.replace(/_/g, ' '), 8)
}
