import { expect, mock, test } from 'claude-code/testing'

import {
  ABBRUCH_ANZEIGE_MS, deckeln, istWarm, keepwarmText, langDauer, parseDauer, pingKosten, pingZeit, wiederholbar, wiederholungsWartezeit,
} from '../hooks/register'
import type { KeepwarmStand } from '../types'

const JETZT = 1_800_000_000_000
const MIN = 60_000

const warm = { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 40 }
const kalt = { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000 }

test('Dauer parsen: 45m, 2h, 1h30m; alles andere null', () => {
  expect(parseDauer('45m')).toBe(45 * MIN)
  expect(parseDauer('2h')).toBe(120 * MIN)
  expect(parseDauer('1h30m')).toBe(90 * MIN)
  expect(parseDauer('1h 30m')).toBe(90 * MIN)
  expect(parseDauer('90min')).toBe(90 * MIN)
  for (const falsch of ['', 'aus', '0m', '1x', 'h', '-5m', '1.5h']) expect(parseDauer(falsch)).toBeNull()
})

test('Deckel: Überschreitung wird auf das Maximum gesetzt', () => {
  expect(deckeln(2 * 3_600_000, 4)).toEqual({ ms: 2 * 3_600_000, gedeckelt: false })
  expect(deckeln(4 * 3_600_000, 4)).toEqual({ ms: 4 * 3_600_000, gedeckelt: false })
  expect(deckeln(10 * 3_600_000, 4)).toEqual({ ms: 4 * 3_600_000, gedeckelt: true })
})

test('Warm-Erkennung: gelesen > 0 und geschrieben < 10 % des Gelesenen', () => {
  expect(istWarm(warm)).toBe(true)
  expect(istWarm(kalt)).toBe(false)
  const u = (input: number, lesen: number, schreiben: number) => ({ input_tokens: input, cache_read_input_tokens: lesen, cache_creation_input_tokens: schreiben })
  expect(istWarm(u(0, 1000, 100))).toBe(false)
  expect(istWarm(u(0, 1000, 99))).toBe(true)
  // ungecachte Eingabe zählt mit
  expect(istWarm(u(60, 1000, 50))).toBe(false)
  expect(istWarm(u(40, 1000, 50))).toBe(true)
})

test('Takt: Ping bei letzte Antwort + (cache_minuten − 10 min)', () => {
  expect(pingZeit(JETZT, 60)).toBe(JETZT + 50 * MIN)
  // Vorlauf relativ: min(10 min, cache_minuten / 5)
  expect(pingZeit(JETZT, 30)).toBe(JETZT + 24 * MIN)
  expect(pingZeit(JETZT, 5)).toBe(JETZT + 4 * MIN)
})

test('Retry-Grenze: höchstens 3, Backoff 1/2/4 min, nur vor TTL − 1 min und Frist', () => {
  const o = { letzte: JETZT, cacheMinuten: 60, frist: JETZT + 4 * 3_600_000, versuche: 0 }
  const t = JETZT + 50 * MIN
  expect(wiederholungsWartezeit(t, o)).toBe(MIN)
  expect(wiederholungsWartezeit(t, { ...o, versuche: 1 })).toBe(2 * MIN)
  expect(wiederholungsWartezeit(t, { ...o, versuche: 2 })).toBe(4 * MIN)
  expect(wiederholungsWartezeit(t, { ...o, versuche: 3 })).toBeNull()
  // landet nicht mehr vor TTL − 1 min (59 min)
  expect(wiederholungsWartezeit(JETZT + 55 * MIN, { ...o, versuche: 2 })).toBeNull()
  // Frist kommt zuerst
  expect(wiederholungsWartezeit(t, { ...o, frist: t + MIN })).toBeNull()
  expect(wiederholbar(null)).toBe(true)
  expect(wiederholbar(429)).toBe(true)
  expect(wiederholbar(503)).toBe(true)
  expect(wiederholbar(400)).toBe(false)
})

test('Kosten eines Pings aus usage und Preisliste', () => {
  // Opus 5.5: lesen 0,2 $/Mio → 300k = 0,06 $; dazu Schreiben/Eingabe/Ausgabe im Cent-Bruchteil
  const k = pingKosten(warm, 'claude-opus-5-5')
  expect(k).toBeGreaterThan(0.06)
  expect(k).toBeLessThan(0.07)
  expect(pingKosten(kalt, 'claude-opus-5-5')).toBeGreaterThan(2.3)
})

test('Band-Text: aktiv, wartend, abgebrochen', () => {
  const k: KeepwarmStand = { frist: JETZT + 80 * MIN, aktiv: true, wartet: false, wiederholung: 0, pings: 2, kosten: 0.62, grund: null, beendetAm: null }
  expect(langDauer(80 * MIN)).toBe('1 h 20 min')
  expect(keepwarmText(k, JETZT + 18 * MIN, JETZT, 60)).toBe('Keepwarm: noch 1 h 2 min · Ping in 32 min · 2 Pings ≈ 0,62 $')
  expect(keepwarmText({ ...k, wartet: true }, JETZT, JETZT, 60)).toContain('wartet auf die nächste Antwort')
  expect(keepwarmText({ ...k, wiederholung: 2 }, JETZT, JETZT, 60)).toContain('Wiederholung 2 von 3')
  const aus = { ...k, aktiv: false, grund: 'Frist erreicht', beendetAm: JETZT }
  expect(keepwarmText(aus, JETZT + MIN, JETZT, 60)).toBe('Keepwarm beendet: Frist erreicht · 2 Pings ≈ 0,62 $')
  expect(keepwarmText(aus, JETZT + ABBRUCH_ANZEIGE_MS + 1, JETZT, 60)).toBeNull()
  expect(keepwarmText(null, JETZT, JETZT, 60)).toBeNull()
})

// ---- Ablauf mit Attrappen -------------------------------------------------------------------------

type Antwort = any
const MSGS = [{ role: 'user', text: 'hi', toolUses: [], handle: 'h1' }] as any

function stubs(on: any, opts: { fork: Antwort[]; letzteVorMin?: number; haengt?: boolean }) {
  const store = new Map<string, unknown>()
  store.set('antwort:eigene', JETZT - (opts.letzteVorMin ?? 0) * MIN)
  const toasts: string[] = []
  const forks: string[] = []
  const hang: { freigeben: (v: Antwort) => void } = { freigeben: () => undefined }
  const uhr = mock.clock(on, { now: JETZT })
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', () => ({ cwd: '/work/app' }))
  on('session.id', () => ({ value: 'eigene' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: MSGS }))
  on('session.usage', () => ({ value: { startedAt: JETZT, context: { tokens: 300_000, window: 1_000_000 }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }) as any)
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('session.end', () => ({ sessionId: 'eigene' }) as any)
  on('session.compact', () => ({ messages: MSGS }) as any)
  on('turn.complete', () => ({ text: 'ok' }) as any)
  on('model.fork', (_$: any, e: any) => {
    forks.push(e.prompt)
    if (opts.haengt) return new Promise(res => { hang.freigeben = (v: Antwort) => res({ value: v }) })
    const a = opts.fork.shift()
    if (a === undefined) throw new Error('kein Fork erwartet')
    return { value: a }
  })
  return { store, toasts, forks, uhr, hang }
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any
const ok = (usage: Antwort) => ({ isAnswered: true, text: 'warm', usage })
const fehler = (status: number | null) => ({ isAnswered: false, reason: 'api-error', status, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
const befehl = ($: any, args: string) => $.command.run({ command: 'keepwarm', args })

test('Warmer Ping nach 50 min Leerlauf: ANTWORT im Store wird auf jetzt gesetzt, Takt läuft weiter', async ($, on) => {
  const s = stubs(on, { fork: [ok(warm), ok(warm)] })
  await $.session.start(START)
  const r: any = await befehl($, '3h')
  expect(String(r.text)).toContain('Keepwarm: noch 3 h')
  expect(String(r.text)).toContain('Ping in 50 min')
  await s.uhr.advance(50 * MIN + 1000)
  expect(s.forks).toEqual(['Antworte nur mit dem Wort: warm'])
  expect(s.store.get('antwort:eigene')).toBe(JETZT + 50 * MIN)
  const status: any = await befehl($, '')
  expect(String(status.text)).toContain('1 Ping ≈')
  expect(String(status.text)).toContain('Ping in 50 min')
  await s.uhr.advance(50 * MIN)
  expect(s.forks.length).toBe(2)
  expect(s.toasts).toEqual([])
})

test('Kalter Ping beendet mit Grund und Toast', async ($, on) => {
  const s = stubs(on, { fork: [ok(kalt)] })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(51 * MIN)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('nicht warm')
  const status: any = await befehl($, '')
  expect(String(status.text)).toContain('Keepwarm beendet')
  await s.uhr.advance(120 * MIN)
  expect(s.forks.length).toBe(1)
})

test('api-error 503: bis zu 3 Wiederholungen, dann Abbruch', async ($, on) => {
  const s = stubs(on, { fork: [fehler(503), fehler(503), fehler(429), fehler(null)] })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(50 * MIN + 1000)
  expect(s.forks.length).toBe(1)
  await s.uhr.advance(MIN)
  await s.uhr.advance(2 * MIN)
  expect(s.forks.length).toBe(3)
  await s.uhr.advance(4 * MIN) // 57:00 < 59:00, dritte und letzte Wiederholung
  expect(s.forks.length).toBe(4)
  await s.uhr.advance(30 * MIN)
  expect(s.forks.length).toBe(4)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('API-Fehler')
  expect(s.toasts[0]).toContain('3 Wiederholungen')
})

test('api-error 400 wird nicht wiederholt', async ($, on) => {
  const s = stubs(on, { fork: [fehler(400)] })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(51 * MIN)
  await s.uhr.advance(10 * MIN)
  expect(s.forks.length).toBe(1)
  expect(s.toasts[0]).toContain('API-Fehler 400')
})

test('nothing-to-fork: kein Abbruch, Warten auf die nächste Antwort', async ($, on) => {
  const s = stubs(on, { fork: [{ isAnswered: false, reason: 'nothing-to-fork' }] })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(51 * MIN)
  expect(s.toasts).toEqual([])
  const status: any = await befehl($, '')
  expect(String(status.text)).toContain('wartet auf die nächste Antwort')
})

test('Veralteter Ping: Antwort während des Pings verwirft das Ergebnis', async ($, on) => {
  const s = stubs(on, { fork: [], haengt: true })
  await $.session.start(START)
  await befehl($, '3h')
  const lauf = s.uhr.advance(51 * MIN)
  await warteAuf(() => s.forks.length === 1)
  // echte Antwort kommt, während der Ping noch unterwegs ist
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', usage: { ...warm, model: 'claude-opus-5-5' } } as any)
  s.hang.freigeben(ok(kalt)) // würde als „kalt“ abbrechen, wird aber verworfen
  await lauf
  await new Promise(r => setTimeout(r, 20))
  const status: any = await befehl($, '')
  expect(String(status.text)).toContain('Keepwarm: noch')
  expect(s.toasts).toEqual([])
})

test('Frist wird gedeckelt und gemeldet; zu kurze Frist startet nicht; aus beendet', async ($, on) => {
  stubs(on, { fork: [] })
  await $.session.start(START)
  const r: any = await befehl($, '10h')
  expect(String(r.text)).toContain('gedeckelt')
  expect(String(r.text)).toContain('noch 4 h')
  const kurz: any = await befehl($, '30m')
  expect(String(kurz.text)).toContain('nicht gestartet')
  await befehl($, '2h')
  const aus: any = await befehl($, 'aus')
  expect(String(aus.text)).toBe('Keepwarm aus.')
  const status: any = await befehl($, '')
  expect(String(status.text)).toContain('Keepwarm aus')
  const falsch: any = await befehl($, 'bla')
  expect(String(falsch.text)).toContain('Dauer wie')
})

test('/clear beendet Keepwarm', async ($, on) => {
  const s = stubs(on, { fork: [] })
  await $.session.start(START)
  await befehl($, '3h')
  await ($ as any).classic.SessionStart({ source: 'clear' })
  expect(s.toasts[0]).toContain('/clear')
  await s.uhr.advance(120 * MIN)
  expect(s.forks.length).toBe(0)
})

async function warteAuf(bedingung: () => boolean) {
  for (let i = 0; i < 500 && !bedingung(); i++) await new Promise(r => setTimeout(r, 10))
  expect(bedingung()).toBe(true)
}

const abbruch = { reason: 'aborted', answer: '', durationMs: 5, isAborted: true, turnId: 't2' } as any

test('Abgebrochener Turn ohne usage setzt keinen Zeitstempel (Cache wurde nicht berührt)', async ($, on) => {
  const s = stubs(on, { fork: [ok(warm)] })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(40 * MIN)
  await $.turn.complete(abbruch)
  expect(s.store.get('antwort:eigene')).toBe(JETZT) // unverändert
  await s.uhr.advance(10 * MIN) // Ping bleibt bei T0 + 50 min
  expect(s.forks.length).toBe(1)
  expect(s.store.get('antwort:eigene')).toBe(JETZT + 50 * MIN)
})

test('Abgebrochener Turn nach Cache-Ablauf beendet Keepwarm statt später kalt zu pingen', async ($, on) => {
  const s = stubs(on, { fork: [], letzteVorMin: 20 })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(45 * MIN) // 65 min nach der letzten Antwort, Ping wäre bei 50 min gewesen
  s.toasts.length = 0
  await $.turn.complete(abbruch)
  expect(s.forks.length).toBeLessThanOrEqual(1)
  const status: any = await befehl($, '')
  expect(String(status.text)).toContain('beendet')
})

test('wartet + Frist verstrichen: Takt beendet mit „Frist erreicht“', async ($, on) => {
  const s = stubs(on, { fork: [{ isAnswered: false, reason: 'nothing-to-fork' }] })
  await $.session.start(START)
  await befehl($, '3h')
  await s.uhr.advance(51 * MIN)
  expect(s.toasts).toEqual([])
  await s.uhr.advance(3 * 3_600_000)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('Frist erreicht')
})

test('Läuft ein Turn, wird nicht gepingt; nach der Antwort läuft der Takt neu', async ($, on) => {
  const s = stubs(on, { fork: [ok(warm)] })
  await $.session.start(START)
  await befehl($, '3h')
  await $.prompt.submit({ text: 'mach weiter', asUser: true } as any)
  await s.uhr.advance(52 * MIN)
  expect(s.forks.length).toBe(0)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't3', usage: { ...warm, model: 'claude-opus-5-5' } } as any)
  await s.uhr.advance(51 * MIN)
  expect(s.forks.length).toBe(1)
})

test('/clear realistisch: erst session.end, dann SessionStart clear, ein Toast mit Grund', async ($, on) => {
  const s = stubs(on, { fork: [] })
  await $.session.start(START)
  await befehl($, '3h')
  await $.session.end({ reason: 'clear' } as any)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('/clear')
  await ($ as any).classic.SessionStart({ source: 'clear' })
  expect(s.toasts.length).toBe(1)
  await s.uhr.advance(120 * MIN)
  expect(s.forks.length).toBe(0)
})

test('aus + neu während ein Ping unterwegs ist: kein Doppelping, warmer Ping zählt als Cache-Berührung', async ($, on) => {
  const s = stubs(on, { fork: [], haengt: true })
  await $.session.start(START)
  await befehl($, '3h')
  const lauf = s.uhr.advance(50 * MIN + 1000)
  await warteAuf(() => s.forks.length === 1)
  await befehl($, 'aus')
  await befehl($, '2h')
  s.hang.freigeben(ok(warm))
  await lauf
  await new Promise(r => setTimeout(r, 20))
  await s.uhr.advance(5 * MIN)
  expect(s.forks.length).toBe(1)
  expect(Number(s.store.get('antwort:eigene'))).toBeGreaterThan(JETZT)
})

test('Kompaktierung beendet Keepwarm', async ($, on) => {
  const s = stubs(on, { fork: [] })
  await $.session.start(START)
  await befehl($, '3h')
  await ($ as any).session.compact({ trigger: 'manual', messages: MSGS })
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('kompaktiert')
  await s.uhr.advance(120 * MIN)
  expect(s.forks.length).toBe(0)
})
