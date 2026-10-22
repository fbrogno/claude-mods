import type { LeitstandAgent, LeitstandAufruf, LeitstandEigen, LeitstandSitzung, LeitstandZustand } from '../types'

/** Ohne Herzschlag seit so langer Zeit wird eine Sitzung ausgeblendet. */
export const TOT_MS = 3 * 60_000
/** Dateien, die älter sind, räumt der Leser beim Lesen weg. */
export const ALT_MS = 24 * 3_600_000
/** Nach so langer Zeit ohne Antwort gilt der Prompt-Cache als kalt. */
export const CACHE_MS = 60 * 60_000
/** Nach so langer Zeit ohne Arbeit geht „wartet auf dich“ in „ruht“ über. */
export const RUHT_MS = 15 * 60_000
export const ZIEL_MAX = 60

export function kuerzen(text: string, max = ZIEL_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`
}

export function dauer(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function dollar(betrag: number): string {
  return `${betrag < 10 ? betrag.toFixed(2).replace('.', ',') : String(Math.round(betrag))} $`
}

/** Kurzname des Modells: claude-haiku-4-5 → haiku. */
export function modellKurz(modell: string): string {
  const treffer = modell.toLowerCase().match(/opus|sonnet|haiku|fable|mythos/)
  return treffer ? treffer[0] : kuerzen(modell, 12) || '?'
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

// ---- Ziel eines Werkzeugaufrufs: nie Befehlsinhalte, nie Secrets -------------------------------

/** Bei diesen Programmen ist das zweite Wort ein Unterbefehl, kein Argument mit Inhalt. */
const MIT_UNTERBEFEHL = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'git', 'docker', 'kubectl', 'make', 'cargo', 'go', 'gh', 'claude',
  'brew', 'pip', 'pip3', 'tsc', 'pytest', 'jest', 'vitest', 'graphify', 'helm', 'terraform',
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

export function zustandVon(arbeitet: boolean, seit: number, now: number): LeitstandZustand {
  if (arbeitet) return 'arbeitet'
  return now - seit <= RUHT_MS ? 'wartet' : 'ruht'
}

/** Cache: 'warm' bis 60 min nach der letzten Antwort, danach 'kalt'; null ohne bekannte Antwort. */
export function cacheStand(letzte: number | null, now: number): 'warm' | 'kalt' | null {
  if (letzte === null) return null
  return now - letzte < CACHE_MS ? 'warm' : 'kalt'
}

export function sichtbar(s: Pick<LeitstandSitzung, 'herz'>, now: number): boolean {
  return typeof s.herz === 'number' && now - s.herz <= TOT_MS
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

const SORT: Record<LeitstandZustand, number> = { arbeitet: 0, wartet: 1, ruht: 2 }

/** Eigene zuerst, dann nach Zustand, dann Projekt. */
export function sortieren(liste: LeitstandSitzung[], eigeneId: string): LeitstandSitzung[] {
  return [...liste].sort((a, b) => {
    if (a.sessionId === eigeneId) return -1
    if (b.sessionId === eigeneId) return 1
    return SORT[a.zustand] - SORT[b.zustand] || a.projekt.localeCompare(b.projekt)
  })
}

export function summe(liste: LeitstandSitzung[]): { sitzungen: number; arbeiten: number; agentsLaufen: number; kosten: number | null } {
  let kosten: number | null = null
  for (const s of liste) if (typeof s.kosten === 'number') kosten = (kosten ?? 0) + s.kosten
  return {
    sitzungen: liste.length,
    arbeiten: liste.filter(s => s.zustand === 'arbeitet').length,
    agentsLaufen: liste.reduce((n, s) => n + s.agents.filter(a => a.stand === 'laeuft').length, 0),
    kosten,
  }
}

// ---- Eigener Stand → Herzschlag ----------------------------------------------------------------

export function leererEigenStand(): LeitstandEigen {
  return { arbeitet: false, seit: 0, letzteAntwort: null, turnId: null, aufrufe: {}, agents: {} }
}

export function agentsFuerDatei(eigen: LeitstandEigen, now: number): LeitstandAgent[] {
  return Object.values(eigen.agents)
    .filter(a => a.stand === 'laeuft' || (a.beendet !== null && now - a.beendet < 90_000))
    .sort((a, b) => a.gestartet - b.gestartet)
    .slice(-12)
    .map(a => {
      const w = a.stand === 'laeuft' ? aktuell(eigen.aufrufe, a.id) : null
      return { ...a, werkzeug: w ? werkzeugName(w.werkzeug) : null, ziel: w ? w.ziel : '' }
    })
}

// ---- Lesen fremder Dateien: nichts glauben ------------------------------------------------------

const str = (v: unknown, max: number, vorgabe = '') => (typeof v === 'string' ? kuerzen(v, max) : vorgabe)
const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function pruefeAgent(roh: unknown): LeitstandAgent | null {
  if (!roh || typeof roh !== 'object') return null
  const a = roh as Record<string, unknown>
  const stand = a.stand === 'fertig' || a.stand === 'fehler' ? a.stand : 'laeuft'
  const id = str(a.id, 80)
  if (!id) return null
  return {
    id,
    beschreibung: str(a.beschreibung, 60),
    typ: str(a.typ, 30),
    modell: str(a.modell, 14, '?'),
    stand,
    werkzeug: typeof a.werkzeug === 'string' ? str(a.werkzeug, 30) : null,
    ziel: str(a.ziel, ZIEL_MAX),
    gestartet: zahl(a.gestartet) ?? 0,
    beendet: zahl(a.beendet),
    tokens: zahl(a.tokens) ?? 0,
    tools: zahl(a.tools) ?? 0,
  }
}

/** Eine gelesene Herzschlag-Datei prüfen und in eine saubere Form bringen; null bei Unbrauchbarem. */
export function pruefeSitzung(roh: unknown): LeitstandSitzung | null {
  if (!roh || typeof roh !== 'object') return null
  const s = roh as Record<string, unknown>
  const id = str(s.sessionId, 80)
  const herz = zahl(s.herz)
  if (!id || herz === null) return null
  const zustand: LeitstandZustand = s.zustand === 'arbeitet' || s.zustand === 'wartet' ? s.zustand : 'ruht'
  const agents = Array.isArray(s.agents) ? s.agents.slice(0, 20).map(pruefeAgent).filter((a): a is LeitstandAgent => a !== null) : []
  return {
    v: 1,
    sessionId: id,
    profil: typeof s.profil === 'string' ? str(s.profil, 40) : undefined,
    projekt: str(s.projekt, 40, '?'),
    modell: str(s.modell, 14, '?'),
    kontextProzent: zahl(s.kontextProzent),
    letzteAntwort: zahl(s.letzteAntwort),
    kosten: zahl(s.kosten),
    zustand,
    werkzeug: typeof s.werkzeug === 'string' ? str(s.werkzeug, 30) : null,
    ziel: str(s.ziel, ZIEL_MAX),
    seit: zahl(s.seit) ?? herz,
    agents,
    herz,
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
