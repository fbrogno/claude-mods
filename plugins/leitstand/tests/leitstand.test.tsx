import { expect, mock, test } from 'claude-code/testing'

import { baueAnsicht, STUFEN, ansichtHoehe, zeilenBreite } from '../hooks/ansicht'
import type { AnsichtDaten } from '../hooks/ansicht'
import { HUETE, Zellen, crewZellen, farbe, hutFuer, maleMann, pixel, ringZellen } from '../hooks/clawd'
import type { MannZustand } from '../hooks/clawd'
import {
  alteDateiHerz,
  anzeigeNamen,
  ausblendenListe,
  bashZiel,
  basename,
  cacheErsparnis,
  dateiName,
  dezimal,
  dollar,
  gruppiere,
  istSitzungVersteckt,
  projektOrdner,
  titelAusTreffern,
  istVersteckt,
  kostenBasisFuer,
  leerZ,
  limitsJeProfil,
  modelleSumme,
  modellBezeichnung,
  profilKurz,
  pruefeSitzung,
  resetZeit,
  tagKey,
  tagStart,
  tagWechsel,
  leererEigenStand,
  tokens,
  titelBereinigen,
  trefferQuote,
  uhr,
  zaehle,
  zaehlerSumme,
  zaehlLuecke,
  zielAus,
} from '../hooks/logik'
import type { LeitstandAgent, LeitstandSitzung, LeitstandZaehler } from '../types'

// Lokaler Mittag: Tagesbeginn und Uhrzeiten rechnen in der lokalen Zeit.
const JETZT = new Date(2026, 9, 22, 12, 0, 0).getTime()
const MIN = 60_000
const STD = 60 * MIN
const TAG = 24 * STD
const DIR = '/home/test/.claude-leitstand/sitzungen'

const z = (anfragen: number, eingabe: number, cacheLesen: number, cacheSchreiben: number, ausgabe: number): LeitstandZaehler => ({ anfragen, eingabe, cacheLesen, cacheSchreiben, ausgabe })

/** Eine fremde Sitzung (Format 2) mit neutralen Namen. */
const fremde = (id: string, teil: Partial<LeitstandSitzung> = {}): LeitstandSitzung => ({
  v: 2, sessionId: id, profil: '.claude', projekt: id, titel: null, modell: 'opus 5.5', kontextProzent: 40, gestartet: JETZT - 2 * STD, zaehlSeit: JETZT - 2 * STD,
  tag: tagKey(JETZT), gesamt: z(10, 1000, 90_000, 5000, 4000), haupt: z(10, 1000, 90_000, 5000, 4000), modelle: { 'opus 5.5': z(10, 1000, 90_000, 5000, 4000) },
  kosten: 1.5, kostenHeute: 1.5, limits: [], limitsZeit: null, letzteAntwort: JETZT - 5 * MIN, zustand: 'arbeitet', zustandSeit: JETZT - MIN,
  werkzeug: 'Bash', ziel: 'npm test', agents: [], beendet: null, herz: JETZT, ...teil,
})

const agent = (id: string, teil: Partial<LeitstandAgent> = {}): LeitstandAgent => ({
  id, name: 'Aufräumen', typ: 'general-purpose', art: 'agent', modell: 'sonnet 4.5', stand: 'laeuft', werkzeug: 'Edit', ziel: 'build.mjs',
  gestartet: JETZT - 2 * MIN, beendet: null, aktiv: JETZT, z: z(31, 20_000, 1_200_000, 90_000, 18_000), ...teil,
})

const PANE = (spalten: number) =>
  ({
    plugin: 'leitstand',
    component: 'Pane',
    requestId: 'leitstand',
    props: { title: 'Leitstand', isFocused: false, bodyColumns: spalten, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  }) as const

type Nutzungen = { startedAt: number; context: { tokens?: number; window: number; percent?: number }; rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>; cost?: { usd: number } }

/** Welt unter dem Plugin: Dateiablage im Speicher, Uhr, Umgebung, Sitzung. */
function welt(
  on: any,
  opts: { cwd: string; dateien?: Record<string, { inhalt: unknown; mtime?: number }>; usage?: Partial<Nutzungen>; agentenListe?: any[] },
) {
  const speicher = new Map<string, { text: string; mtime: number }>()
  for (const [k, v] of Object.entries(opts.dateien ?? {})) speicher.set(`${DIR}/${k}`, { text: typeof v.inhalt === 'string' ? v.inhalt : JSON.stringify(v.inhalt), mtime: v.mtime ?? JETZT })
  speicher.set('/home/test/.claude-leitstand/ausblenden.txt', { text: 'hobbybot\nspielwelt\nfamilie\n', mtime: JETZT })
  const w = {
    speicher,
    geschrieben: [] as string[],
    entfernt: [] as string[],
    blits: [] as any[],
    jetzt: JETZT,
    id: 'eigene',
    usage: { startedAt: JETZT - STD, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [], ...opts.usage } as Nutzungen,
    /** Transcript-Dateien des Hosts (Pfad → Text), aus denen die Mod den Titel liest. */
    transkripte: new Map<string, string>(),
    greps: 0,
    /** Legt ein Transcript der Sitzung an (oder hängt Zeilen an) und gibt den Pfad zurück. */
    transkript(zeilen: string[], id = 'eigene', cwd = opts.cwd) {
      const pfad = `/home/test/.claude-firma2/projects/${projektOrdner(cwd)}/${id}.jsonl`
      w.transkripte.set(pfad, (w.transkripte.get(pfad) ?? '') + zeilen.join('\n') + '\n')
      return pfad
    },
    agentenListe: opts.agentenListe ?? [],
    uhr: null as any,
    async vor(ms: number) {
      w.jetzt += ms
      await w.uhr.advance(ms)
    },
    datei: (id: string) => JSON.parse(w.speicher.get(`${DIR}/${dateiName(id)}`)!.text),
    hat: (id: string) => w.speicher.has(`${DIR}/${dateiName(id)}`),
  }
  w.uhr = mock.clock(on, { now: JETZT })
  mock.env(on, { HOME: '/home/test', CLAUDE_CONFIG_DIR: '/home/test/.claude-firma2' })
  on('fs.write', (_$: any, e: any) => { speicher.set(e.path, { text: e.text, mtime: w.jetzt }); w.geschrieben.push(e.path); return { value: undefined } })
  on('fs.read', (_$: any, e: any) => ({ value: speicher.get(e.path)?.text ?? '' }))
  on('fs.list', () => ({ value: [...speicher.entries()].filter(([p]) => p.startsWith(DIR + '/')).map(([p, v]) => ({ name: p.split('/').pop(), kind: 'file', size: 1, mtimeMs: v.mtime, isLink: false })) }))
  on('process.run', (_$: any, e: any) => {
    const antwort = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'rm') for (const p of e.argv.slice(2)) { speicher.delete(p); w.entfernt.push(p) }
    if (e.argv[0] === 'grep') {
      // grep -a -o -E '"(customTitle|aiTitle)":"…"' <Transcript>: nur die Titel-Treffer, wie das echte grep
      w.greps++
      const text = w.transkripte.get(e.argv[e.argv.length - 1])
      if (text === undefined) return antwort(2)
      const treffer = text.match(/"(customTitle|aiTitle)":"([^"\\]|\\.)*"/g) ?? []
      return antwort(treffer.length ? 0 : 1, treffer.length ? `${treffer.join('\n')}\n` : '')
    }
    return antwort(0)
  })
  on('session.start', () => ({ cwd: opts.cwd }))
  on('session.end', (_$: any, e: any) => ({ reason: e.reason, sessionId: e.sessionId, resume: e.resume }) as any)
  on('session.id', () => ({ value: w.id }))
  on('session.cwd', () => ({ value: opts.cwd }))
  on('session.root', () => ({ value: opts.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: w.usage }))
  on('command.register', () => ({ value: undefined }) as any)
  on('agent.list', () => ({ value: w.agentenListe }))
  on('ui.panes', () => ({ value: [{ id: 'leitstand', title: 'Leitstand', isShown: true, isFocused: false, isPlaced: true }] }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as any)
  on('ui.blit', (_$: any, e: any) => { w.blits.push(e); return { value: {} } })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return w
}

async function starten($: any, cwd: string) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
}

/** Alle Zeilen eines gezeichneten Baums: Breite in Zellen (Texte nach Zeichen, Raster nach Spalten). */
function messe(n: any): number {
  if (typeof n === 'string') return Array.from(n).length
  if (!n || typeof n !== 'object') return 0
  const kinder: any[] = n.children ?? []
  if (n.type === 'Raster') return n.props.columns
  if (n.type === 'Box') {
    const reihe = (n.props?.flexDirection ?? 'row') === 'row'
    const m = kinder.map(messe)
    const luecke = (n.props?.gap ?? 0) * Math.max(0, m.length - 1)
    return (reihe ? m.reduce((a, b) => a + b, 0) + luecke : Math.max(0, ...m)) + (n.props?.borderStyle ? 2 : 0)
  }
  return kinder.reduce((a, k) => a + messe(k), 0)
}

function zeilenDerWurzel(baum: any): any[] {
  return (baum.children ?? []) as any[]
}

/** Alle sichtbaren Texte (Zeile für Zeile) eines Baums. */
function texte(n: any): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  return (n.children ?? []).map(texte).join('')
}

// ---- Herzschlag ------------------------------------------------------------------------------------

test('Herzschlag (Format 2): gemessene Kosten und Limits, kein Befehlsinhalt', async ($, on) => {
  const reset = JETZT + 2 * STD
  const w = welt(on, { cwd: '/work/webshop', usage: { cost: { usd: 3.5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 54, resetsAt: new Date(reset).toISOString() }] } })
  on('tool.call', () => ({ result: {} }))
  await starten($, '/work/webshop')
  await w.vor(2100)
  const d = w.datei('eigene')
  expect(d).toMatchObject({ v: 2, sessionId: 'eigene', projekt: 'webshop', modell: 'opus 5.5', profil: '.claude-firma2', kontextProzent: 25, kosten: 3.5, kostenHeute: 3.5, beendet: null, zustand: 'wartet', tag: tagKey(JETZT) })
  expect(d.limits).toEqual([{ art: 'five_hour', prozent: 54, reset }])
  // Datenschutz: Befehle erscheinen höchstens als Programm plus Unterbefehl, nie mit Argumenten, Variablen oder Tokens.
  await $.tool.call({ tool: 'Bash', command: 'API_KEY=abc123 npm test -- --token=geheim' })
  await w.vor(2100)
  const roh = w.speicher.get(`${DIR}/${dateiName('eigene')}`)!.text
  expect(roh).not.toContain('geheim')
  expect(roh).not.toContain('abc123')
  expect(roh).not.toContain('API_KEY')
  // Nur bei Änderung: der nächste Takt schreibt (innerhalb von 30 s) nicht erneut.
  const anzahl = w.geschrieben.length
  await w.vor(4100)
  expect(w.geschrieben.length).toBe(anzahl)
})

test('Kürzung von Bash-Zielen: nie Befehlsinhalt, nie Secrets', () => {
  expect(bashZiel('npm test -- --grep geheim')).toBe('npm test')
  expect(bashZiel('API_KEY=abc123 curl -H "Authorization: Bearer xyz" https://x.de')).toBe('curl')
  expect(bashZiel('cd /tmp && git status --short')).toBe('git status')
  expect(bashZiel('node /pfad/dienst.mjs --token=abc')).toBe('node dienst.mjs')
  expect(bashZiel('echo $SECRET | base64')).toBe('echo')
  expect(bashZiel('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  expect(zielAus('Read', { file_path: '/a/b/dienst.mjs' })).toBe('dienst.mjs')
  expect(zielAus('WebFetch', { url: 'https://api.example.com/x?token=abc' })).toBe('api.example.com')
  expect(zielAus('Bash', { command: 'git commit -m "geheimer text"' })).toBe('git commit')
  expect(basename('/a/b/c.txt')).toBe('c.txt')
})

test('Ausblenden-Liste: private Sitzung schreibt gar keine Datei', async ($, on) => {
  const w = welt(on, { cwd: '/Users/x/Spielwelt-PRIVAT/mod' })
  await starten($, '/Users/x/Spielwelt-PRIVAT/mod')
  await w.vor(6000)
  expect(w.geschrieben).toEqual([])
  expect(istVersteckt('/a/HOBBYBOT-x', ausblendenListe('hobbybot,tagebuch'))).toBe(true)
  expect(istVersteckt('/a/webshop', ausblendenListe('hobbybot,tagebuch'))).toBe(false)
  expect(ausblendenListe(' A , ,b ')).toEqual(['a', 'b'])
})

// ---- Zählung aus turn.step ---------------------------------------------------------------------------------

test('Zählung aus turn.step: Hauptschleife und Subagent, je Modell; ohne Antwort nichts', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag1' }))
  const antworten: Array<{ usage: any }> = []
  on('turn.step', async function* (_$: any, e: any) {
    const a = antworten.shift()!
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: a.usage ? 'end_turn' : null, usage: a.usage }
  } as any)
  await starten($, '/work/webshop')
  await $.agent.spawn({ prompt: 'suche', description: 'Dateien sichten', subagentType: 'Explore' } as any)
  const schritt = async (teil: { agentId?: string; model: string }, usage: any) => {
    antworten.push({ usage })
    const s = $.turn.step({ turnId: 't1', index: 0, messageCount: 3, ...teil } as any)
    let n = await s.next()
    while (!n.done) n = await s.next() // den Strom bis zum Ende lesen; sein Rückgabewert ist die Antwort
    return n.value
  }
  const nutzung = (model: string, i: number, o: number, cl: number, cc: number) => ({ model, input_tokens: i, output_tokens: o, cache_read_input_tokens: cl, cache_creation_input_tokens: cc })
  const r1 = await schritt({ model: 'claude-opus-5-5' }, nutzung('claude-opus-5-5', 100, 50, 1000, 200))
  expect(r1.usage!.input_tokens).toBe(100) // der Hook ändert die Antwort nicht
  await schritt({ model: 'claude-opus-5-5' }, nutzung('claude-opus-5-5', 10, 5, 2000, 0))
  await schritt({ agentId: 'ag1', model: 'claude-haiku-4-5' }, nutzung('claude-haiku-4-5', 40, 20, 500, 100))
  await schritt({ model: 'claude-opus-5-5' }, null) // keine Antwort: zählt nicht
  await w.vor(2100)
  const d = w.datei('eigene')
  expect(d.gesamt).toEqual(z(3, 150, 3500, 300, 75))
  expect(d.haupt).toEqual(z(2, 110, 3000, 200, 55))
  expect(d.modelle['opus 5.5']).toEqual(z(2, 110, 3000, 200, 55))
  expect(d.modelle['haiku 4.5']).toEqual(z(1, 40, 500, 100, 20))
  expect(d.agents[0]).toMatchObject({ id: 'ag1', modell: 'haiku 4.5', name: 'Dateien sichten', stand: 'laeuft', z: z(1, 40, 500, 100, 20) })
  expect(d.zaehlSeit).toBe(JETZT)
  expect(d.limitsZeit).toBeNull() // keine Limits gemeldet
})

test('Cache-Trefferquote und geschätzte Ersparnis (Formel)', () => {
  const x = z(5, 100, 900, 100, 50)
  expect(Math.abs(trefferQuote(x)! - (900 / 1100) * 100)).toBeLessThan(1e-9)
  // Ersparnis ≈ 0,9 · gelesen / (neu + gelesen + 1,25 · geschrieben)
  expect(Math.abs(cacheErsparnis(x)! - ((0.9 * 900) / (100 + 900 + 1.25 * 100)) * 100)).toBeLessThan(1e-9)
  expect(cacheErsparnis(z(1, 100, 0, 0, 0))).toBe(0)
  expect(trefferQuote(leerZ())).toBeNull()
  expect(cacheErsparnis(leerZ())).toBeNull()
  expect(trefferQuote(z(1, 0, 100, 0, 0))).toBe(100)
  const summe = zaehle(zaehle(leerZ(), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })
  expect(summe).toEqual(z(2, 2, 6, 8, 4))
})

// ---- Heute, beendete Sitzungen, Aufräumen ---------------------------------------------------------------

test('Beendete Sitzung zählt in „heute" und steht gedimmt unter „heute beendet/ruhend"; Dateien von gestern werden beim Lesen gelöscht', async ($, on) => {
  const w = welt(on, {
    cwd: '/work/brain',
    dateien: {
      'a.json': { inhalt: fremde('a', { projekt: 'webshop', kostenHeute: 1.5 }) },
      'b.json': { inhalt: fremde('b', { projekt: 'backend', kostenHeute: 2.5, beendet: JETZT - 30 * MIN, herz: JETZT - 31 * MIN }) },
      'alt.json': { inhalt: fremde('alt', { projekt: 'altlast', kostenHeute: 9 }), mtime: JETZT - TAG },
    },
  })
  await starten($, '/work/brain')
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\$ 4,00/ })).toBeDefined() // 1,50 + 2,50 (+ eigene 0)
  expect(await ui.find({ key: 'a' })).toBeDefined() // laufende Sitzung steht in der Liste
  expect(await ui.find({ type: 'Text', text: /heute beendet\/ruhend/ })).toBeDefined()
  const beendet = await ui.find({ key: 'b' }) // jede Sitzung der Kostenaufteilung steht auch in der Liste (gedimmt, mit ○)
  expect(beendet).toBeDefined()
  expect((beendet as any).text).toMatch(/○ beendet 11:30/)
  expect(await ui.find({ type: 'Text', text: /backend/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /altlast/ })).toBeUndefined()
  expect(w.entfernt).toContain(`${DIR}/alt.json`)
  await ui.unmount()
  // Sitzungsende: Datei bleibt, mit Endzeit
  await $.session.end({ reason: 'other', sessionId: 'eigene', resume: {} } as any)
  expect(w.hat('eigene')).toBe(true)
  expect(w.datei('eigene').beendet).toBe(w.jetzt)
  expect(w.entfernt).not.toContain(`${DIR}/${dateiName('eigene')}`)
})

test('Dateien aus Mod 0.1 (ohne Format 2) werden ignoriert, nie gerechnet und ab 10 min Herzschlag-Alter gelöscht', async ($, on) => {
  const v1 = (id: string, herz: number) => ({ v: 1, sessionId: id, projekt: `altmod-${id}`, modell: 'opus', kontextProzent: 10, letzteAntwort: null, kosten: 99, zustand: 'wartet', werkzeug: null, ziel: '', seit: herz, agents: [], herz })
  const w = welt(on, {
    cwd: '/work/brain',
    dateien: {
      'frisch.json': { inhalt: v1('frisch', JETZT - 2 * MIN) },
      'alt.json': { inhalt: v1('alt', JETZT - 11 * MIN) },
      'a.json': { inhalt: fremde('a', { projekt: 'webshop' }) },
    },
  })
  await starten($, '/work/brain')
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ key: 'a' })).toBeDefined()
  expect(await ui.find({ key: 'frisch' })).toBeUndefined() // nie angezeigt
  expect(await ui.find({ key: 'alt' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ohne Zähler/ })).toBeUndefined() // kein „+1 ohne Zähler" mehr
  expect(await ui.find({ type: 'Text', text: /\$ 99/ })).toBeUndefined() // nie gerechnet
  expect(w.entfernt).toContain(`${DIR}/alt.json`) // über 10 min: weg
  expect(w.entfernt).not.toContain(`${DIR}/frisch.json`) // frischer Herzschlag: bleibt liegen (die alte Mod schreibt noch)
  await ui.unmount()
  // wird die frische Datei später alt, räumt der nächste Lesevorgang auf
  await w.vor(10 * MIN)
  const ui2 = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui2.unmount()
  expect(w.entfernt).toContain(`${DIR}/frisch.json`)
  expect(pruefeSitzung(v1('x', JETZT))).toBeNull()
  expect(alteDateiHerz(v1('x', 5))).toBe(5)
  expect(alteDateiHerz(fremde('x'))).toBeNull()
})

test('Fortsetzung am selben Tag: Zähler der Datei werden wieder aufgenommen', async ($, on) => {
  const w = welt(on, {
    cwd: '/work/webshop',
    dateien: { [dateiName('eigene')]: { inhalt: fremde('eigene', { gesamt: z(7, 700, 7000, 70, 7), haupt: z(7, 700, 7000, 70, 7), zaehlSeit: JETZT - STD, beendet: JETZT - 10 * MIN, herz: JETZT - 10 * MIN }) } },
  })
  await starten($, '/work/webshop')
  await w.vor(2100)
  const d = w.datei('eigene')
  expect(d.gesamt).toEqual(z(7, 700, 7000, 70, 7))
  expect(d.zaehlSeit).toBe(JETZT - STD)
  expect(d.beendet).toBeNull() // läuft wieder
})

test('Nach /clear: die alte Datei bleibt (beendet), die neue Sitzung zählt von vorn, Kosten erst ab dem ersten Messwert', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop', usage: { cost: { usd: 20 } } })
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }
  } as any)
  await starten($, '/work/webshop')
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any)
  let n = await s.next()
  while (!n.done) n = await s.next()
  await w.vor(2100)
  expect(w.datei('eigene')).toMatchObject({ kostenHeute: 20, beendet: null })
  expect(w.datei('eigene').gesamt.anfragen).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 'eigene', resume: {} } as any)
  expect(w.datei('eigene').beendet).not.toBeNull()
  w.id = 'neu' // neue Sitzungs-ID; das Kostenbuch läuft weiter (20 $)
  await w.vor(2100)
  expect(w.datei('neu')).toMatchObject({ kosten: 20, kostenHeute: 0, beendet: null })
  expect(w.datei('neu').gesamt.anfragen).toBe(0)
  w.usage.cost = { usd: 21 }
  await w.vor(2100)
  expect(w.datei('neu')).toMatchObject({ kostenHeute: 1 })
  expect(w.datei('eigene').kostenHeute).toBe(20) // nichts doppelt gezählt: 20 + 1
})

// ---- Tageskosten und Tageswechsel -----------------------------------------------------------------------

test('Kosten heute: Sitzung vom Vortag zählt nur, was seit dem ersten Messwert dazukam', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop', usage: { startedAt: JETZT - 30 * STD, cost: { usd: 20 } } })
  await starten($, '/work/webshop')
  await w.vor(2100)
  expect(w.datei('eigene')).toMatchObject({ kosten: 20, kostenHeute: 0 })
  w.usage.cost = { usd: 21.5 }
  await w.vor(2100)
  expect(w.datei('eigene')).toMatchObject({ kosten: 21.5, kostenHeute: 1.5 })
  // reine Funktionen
  expect(kostenBasisFuer(null, '2026-10-22', JETZT, JETZT, 5)).toEqual({ tag: '2026-10-22', usd: 0 })
  expect(kostenBasisFuer(null, '2026-10-22', JETZT - 30 * STD, JETZT, 5)).toEqual({ tag: '2026-10-22', usd: 5 })
  expect(kostenBasisFuer({ tag: '2026-10-22', usd: 5 }, '2026-10-22', JETZT - 30 * STD, JETZT, 4)).toEqual({ tag: '2026-10-22', usd: 0 }) // neues Kostenbuch
})

test('Tageswechsel setzt die Zähler zurück', () => {
  const e = { ...leererEigenStand(), tag: '2026-10-21', zaehlSeit: 5, gesamt: z(3, 1, 1, 1, 1), haupt: z(3, 1, 1, 1, 1), modelle: { 'opus 5.5': z(3, 1, 1, 1, 1) }, kostenBasis: { tag: '2026-10-21', usd: 2 }, agents: { a: agent('a') } }
  const n = tagWechsel(e, '2026-10-22')
  expect(n.gesamt).toEqual(leerZ())
  expect(n.modelle).toEqual({})
  expect(n.zaehlSeit).toBeNull()
  expect(n.kostenBasis).toBeNull()
  expect(n.agents.a!.z).toEqual(leerZ())
  expect(tagWechsel(n, '2026-10-22')).toBe(n)
  expect(tagStart(JETZT)).toBe(new Date(2026, 9, 22, 0, 0, 0).getTime())
})

// ---- Limits ------------------------------------------------------------------------------------------------------

test('Limits: kontoweit der jüngste Stand je Profil aus ALLEN Dateien (auch ruhende und beendete); Stand HH:MM erst nach 15 min; 5 h / 7 T', async ($, on) => {
  const limits = (a: number, b: number) => [{ art: 'five_hour', prozent: a, reset: JETZT + 2 * STD }, { art: 'seven_day', prozent: b, reset: JETZT + 3 * TAG }]
  const w = welt(on, {
    cwd: '/work/webshop',
    dateien: {
      // ältere Messung einer laufenden Sitzung, jüngere einer beendeten: die jüngere gilt
      'a.json': { inhalt: fremde('a', { limits: limits(10, 20), limitsZeit: JETZT - 40 * MIN }) },
      'b.json': { inhalt: fremde('b', { limits: limits(54, 22), limitsZeit: JETZT - 30 * MIN, beendet: JETZT - 20 * MIN, herz: JETZT - 20 * MIN }) },
    },
  })
  await starten($, '/work/webshop')
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeDefined()
  const zeilen = ((await ui.findAll({ type: 'Text', text: /5 h/ })) as any[]).map(t => t.text as string).join('\n')
  expect(zeilen).toContain('54 %') // Wert der beendeten, jüngeren Sitzung
  expect(zeilen).not.toContain('10 %')
  expect(zeilen).toContain('Reset 14:00')
  expect(zeilen).toContain('Stand 11:30') // älter als 15 min: gedimmt dahinter
  expect(await ui.find({ type: 'Text', text: /7 T/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`Reset ${resetZeit(JETZT + 3 * TAG, JETZT)}`) })).toBeDefined()
  expect(resetZeit(JETZT + 3 * TAG, JETZT)).toMatch(/^So \d\d:\d\d$/) // 22.10. + 3 Tage = Sonntag (Zeitumstellung: 11:00 statt 12:00)
  await ui.unmount()
  expect(resetZeit(JETZT + 2 * STD, JETZT)).toBe('14:00')
  expect(uhr(JETZT)).toBe('12:00')
})

test('Limits: frischer Stand (unter 15 min) ohne „Stand"; abgelaufenes Fenster bleibt sichtbar als „Reset vorbei"; zwei Profile je eine Zeile mit Kennzeichen', () => {
  const frisch = fremde('a', { limits: [{ art: 'five_hour', prozent: 54, reset: JETZT + 2 * STD }], limitsZeit: JETZT - 5 * MIN })
  const einzel = (s: LeitstandSitzung[]) => baueAnsicht(ansichtDaten({ sitzungen: [fremde('eigene'), ...s] })).zeilen.map(zeilenText).join('\n')
  expect(einzel([frisch])).toContain('Reset 14:00')
  expect(einzel([frisch])).not.toContain('Stand')
  const vorbei = fremde('a', { limits: [{ art: 'five_hour', prozent: 87, reset: JETZT - 10 * MIN }], limitsZeit: JETZT - 3 * STD })
  const t = einzel([vorbei])
  expect(t).toContain('87 %')
  expect(t).toContain('Reset vorbei')
  expect(t).toContain('Stand 09:00')
  // zwei Profile: je eine Zeile mit kurzem Kennzeichen (std, zweit); der jüngste Stand je Profil
  const p1 = fremde('p1', { profil: '.claude', limits: [{ art: 'five_hour', prozent: 28, reset: JETZT + 2 * STD }, { art: 'seven_day', prozent: 87, reset: JETZT + 2 * TAG }], limitsZeit: JETZT - 50 * MIN })
  const p1neu = fremde('p1neu', { profil: '.claude', limits: [{ art: 'five_hour', prozent: 33, reset: JETZT + 2 * STD }, { art: 'seven_day', prozent: 88, reset: JETZT + 2 * TAG }], limitsZeit: JETZT - MIN })
  const p2 = fremde('p2', { profil: '.claude-zweit', limits: [{ art: 'five_hour', prozent: 40, reset: JETZT + 90 * MIN }, { art: 'seven_day', prozent: 65, reset: JETZT + 3 * TAG }], limitsZeit: JETZT - 35 * MIN })
  const a = baueAnsicht(ansichtDaten({ sitzungen: [fremde('eigene'), p1, p1neu, p2] }))
  const zeilen = a.zeilen.map(zeilenText)
  const iL = zeilen.findIndex(l => l.includes('LIMITS'))
  const profilZeilen = zeilen.slice(iL + 1, iL + 3)
  expect(profilZeilen[0]).toMatch(/^ std +5 h .* 33 %.*7 T .* 88 %/)
  expect(profilZeilen[0]).not.toContain('Stand') // frisch
  expect(profilZeilen[1]).toMatch(/^ zweit +5 h .* 40 %.*7 T .* 65 %.*Stand 11:25/)
  expect(zeilen[iL + 3]).toContain('SITZUNGEN') // genau eine Zeile je Profil
  expect(profilKurz('.claude')).toBe('std')
  expect(profilKurz('.claude-firma2')).toBe('firma2')
  for (const zl of a.zeilen) expect(zeilenBreite(zl)).toBeLessThanOrEqual(84)
})

test('Ohne Limits-Daten gibt es den Abschnitt LIMITS nicht', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  await starten($, '/work/webshop')
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeUndefined()
  await ui.unmount()
})

// ---- Zählbeginn ----------------------------------------------------------------------------------------------------

test('Zählbeginn: „gezählt ab", wenn die Mod erst nach dem Sitzungsstart zu zählen anfing', async ($, on) => {
  const w = welt(on, {
    cwd: '/work/webshop',
    dateien: {
      'spaet.json': { inhalt: fremde('spaet', { gestartet: JETZT - 3 * STD, zaehlSeit: JETZT - STD }) },
    },
  })
  await starten($, '/work/webshop')
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /gezählt ab 11:00/ })).toBeDefined()
  await ui.unmount()
  // ohne Lücke (unter einer Minute) keine Notiz
  expect(zaehlLuecke(JETZT - STD, JETZT - STD + 30_000, JETZT)).toBeNull()
  expect(zaehlLuecke(JETZT - STD, JETZT - STD + 2 * MIN, JETZT)).toBe(JETZT - STD + 2 * MIN)
  // eine Sitzung vom Vortag: gemessen wird ab Tagesbeginn
  expect(zaehlLuecke(JETZT - 30 * STD, tagStart(JETZT) + 30_000, JETZT)).toBeNull()
  expect(zaehlLuecke(JETZT, null, JETZT)).toBeNull()
})

// ---- Zustände --------------------------------------------------------------------------------------------------------

test('Zustände der Hauptsitzung: arbeitet, wartet, abgebrochen, Fehler, ruht', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  await starten($, '/work/webshop')
  const zustand = async () => { await w.vor(2100); return w.datei('eigene').zustand }
  expect(await zustand()).toBe('wartet')
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(await zustand()).toBe('arbeitet')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await zustand()).toBe('wartet')
  await $.turn.start({ text: 'x', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(await zustand()).toBe('abgebrochen')
  await $.turn.start({ text: 'x', turnId: 't3' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't3', reason: 'error' })
  expect(await zustand()).toBe('fehler')
  await w.vor(31 * MIN)
  expect(await zustand()).toBe('ruht')
})

test('„braucht dich": Erlaubnis-Frage der Hauptsitzung, nach kurzer Schonfrist, endet mit dem Zug', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  let verdikt: 'ask' | 'allow' = 'ask'
  on('tool.check', () => ({ decision: verdikt }) as any)
  await starten($, '/work/webshop')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', approver: 'person' } as any)
  await w.vor(2100)
  expect(w.datei('eigene').zustand).toBe('arbeitet') // noch in der Schonfrist (kurze Entscheidungen zählen nicht)
  await w.vor(3000)
  expect(w.datei('eigene').zustand).toBe('braucht')
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.vor(2100)
  expect(w.datei('eigene').zustand).toBe('wartet')
  // ein Subagent oder „allow" löst nichts aus
  await $.turn.start({ text: 'x', turnId: 't2' })
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u2', agentId: 'ag9', approver: 'person' } as any)
  verdikt = 'allow'
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u3', approver: 'person' } as any)
  await w.vor(8000)
  expect(w.datei('eigene').zustand).toBe('arbeitet')
})

// ---- Subagents -------------------------------------------------------------------------------------------------------

test('Subagents: Start, Werkzeug und Ziel, Ende über die Agent-Liste, fertige noch 10 min sichtbar', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag1' }))
  let frei = () => {}
  on('tool.call', () => new Promise<any>(fertig => { frei = () => fertig({ result: {} }) }))
  await starten($, '/work/webshop')
  await $.agent.spawn({ prompt: 'p', description: 'Dateien sichten', subagentType: 'Explore' } as any)
  w.agentenListe = [{ id: 'ag1', description: 'Dateien sichten', type: 'Explore', status: 'running' }]
  const aufruf = $.tool.call({ tool: 'Grep', pattern: 'TODO', agentId: 'ag1' } as any)
  await w.vor(2100)
  const lauf = w.datei('eigene').agents[0]
  expect(lauf).toMatchObject({ id: 'ag1', stand: 'laeuft', werkzeug: 'Grep', ziel: 'TODO', modell: 'haiku 4.5' })
  frei()
  await aufruf
  // der Host nennt ihn nicht mehr: fertig, noch 10 min in der Datei
  w.agentenListe = []
  await w.vor(2100)
  expect(w.datei('eigene').agents[0]).toMatchObject({ id: 'ag1', stand: 'fertig' })
  await w.vor(11 * MIN)
  expect(w.datei('eigene').agents).toEqual([])
})

test('Agent, den der Host nie nannte (Workflow), bleibt bis zu seinem Ende und endet sonst nach 20 min Stille', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  on('agent.spawn', () => ({ model: 'claude-sonnet-4-5', agentId: 'wf1' }))
  await starten($, '/work/webshop')
  await $.agent.spawn({ prompt: 'p', description: 'Schritt 1', subagentType: 'general-purpose', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
  await w.vor(10 * MIN)
  expect(w.datei('eigene').agents[0]).toMatchObject({ id: 'wf1', art: 'workflow', stand: 'laeuft' })
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'tw', agentId: 'wf1', reason: 'answer' } as any)
  await w.vor(2100)
  expect(w.datei('eigene').agents[0]).toMatchObject({ id: 'wf1', stand: 'fertig' })
})

// ---- Anzeige ---------------------------------------------------------------------------------------------------------

/** Der Text einer Zeile des Datenmodells (Blöcke: ihre linken Zeilen). */
const zeilenText = (zl: ReturnType<typeof baueAnsicht>['zeilen'][number]): string =>
  zl.art === 'text' || zl.art === 'knopf' ? zl.segs.map(s => s.t).join('') : zl.art === 'block' ? zl.links.map(l => l.map(s => s.t).join('')).join('\n') : ''

function ansichtDaten(teil: Partial<AnsichtDaten> = {}): AnsichtDaten {
  const e = fremde('eigene', {
    projekt: 'webshop', gesamt: z(142, 1_900_000, 38_400_000, 2_100_000, 212_000), haupt: z(88, 1_100_000, 27_100_000, 1_000_000, 140_000),
    modelle: { 'opus 5.5': z(88, 1_100_000, 27_100_000, 1_000_000, 140_000), 'sonnet 4.5': z(41, 700_000, 10_200_000, 800_000, 61_000), 'haiku 4.5': z(13, 100_000, 1_100_000, 300_000, 11_000) },
    kosten: 18.42, kostenHeute: 12.3, limits: [{ art: 'five_hour', prozent: 54, reset: JETZT + 2 * STD }, { art: 'seven_day', prozent: 22, reset: JETZT + 3 * TAG }], limitsZeit: JETZT,
    agents: [agent('a1'), agent('a2', { name: 'Suche', modell: 'haiku 4.5', werkzeug: 'Grep', ziel: 'TODO' }), agent('a3', { stand: 'fertig', beendet: JETZT - MIN }), agent('a4', { art: 'fork', stand: 'fehler', beendet: JETZT - 2 * MIN })],
  })
  const andere = [
    fremde('b', { projekt: 'backend', zustand: 'wartet', zustandSeit: JETZT - 3 * MIN, kostenHeute: 4.02 }),
    fremde('c', { projekt: 'dokumente', modell: 'sonnet 4.5', zustand: 'braucht', kostenHeute: 2.1 }),
    fremde('d', { projekt: 'notizen', beendet: JETZT - 30 * MIN, herz: JETZT - 30 * MIN, kostenHeute: 1.2 }),
  ]
  return { jetzt: JETZT, breite: 84, hoehe: null, eigeneId: 'eigene', sitzungen: [e, ...andere], auswahl: null, aktion: null, eingabe: null, stoppBitte: null, meldung: '', raster: true, bildMs: 250, ...teil }
}

test('Layout: keine Zeile breiter als bodyColumns (24 bis 140 Spalten, mit und ohne Raster, mit Auswahl)', () => {
  for (const breite of [24, 30, 40, 55, 56, 57, 60, 62, 80, 84, 120, 140]) {
    for (const raster of [true, false]) {
      for (const auswahl of [null, 'b', 'eigene']) {
        const a = baueAnsicht(ansichtDaten({ breite, raster, auswahl }))
        expect(a.zeilen.length).toBeGreaterThan(5)
        for (const zeile of a.zeilen) expect(zeilenBreite(zeile)).toBeLessThanOrEqual(breite)
      }
    }
  }
})

test('Layout: ab 56 Spalten volles Layout (4 Kacheln in einer Reihe, Ring, Crew-Figuren), darunter kompakt (2 × 2, kein Ring)', () => {
  const voll = baueAnsicht(ansichtDaten({ breite: 62 }))
  const kompakt = baueAnsicht(ansichtDaten({ breite: 55 }))
  const ringe = (a: ReturnType<typeof baueAnsicht>) => a.zeilen.filter(z => z.art === 'block' && z.key === 'ring').length
  expect(ringe(voll)).toBe(1) // Ring
  expect(ringe(kompakt)).toBe(0)
  expect(voll.crew.length).toBeGreaterThan(0)
  expect(kompakt.crew).toEqual([])
  const kachelReihen = (a: ReturnType<typeof baueAnsicht>) => a.zeilen.filter(z => z.art === 'text' && /^╭─+╮╭─+╮/.test(z.segs.map(s => s.t).join(''))).length
  expect(kachelReihen(voll)).toBe(1)
  expect(kachelReihen(kompakt)).toBe(2)
})

test('Höhe: bei wenig Platz wird verdichtet statt Abschnitte zu streichen: LIMITS und MODELLE bleiben (Ursache des Mangels in 0.2)', () => {
  const texteVon = (a: ReturnType<typeof baueAnsicht>) => a.zeilen.map(zeilenText).join('\n')
  const alles = baueAnsicht(ansichtDaten({ hoehe: null }))
  expect(alles.stufe).toBe(0)
  const voll = ansichtHoehe(alles)
  for (const abschnitt of ['LEITSTAND', 'LIMITS', 'SITZUNGEN', 'CREW', 'MODELLE', 'Kosten heute']) expect(texteVon(alles)).toContain(abschnitt)
  // ein Pane in der Höhe des Screenshots (33 Zeilen) und weit darunter: jeder Abschnitt ist da
  let vorige = 0
  for (const hoehe of [voll - 1, voll - 8, 33, 28]) {
    const a = baueAnsicht(ansichtDaten({ hoehe }))
    expect(a.stufe).toBeGreaterThanOrEqual(vorige)
    vorige = a.stufe
    for (const abschnitt of ['LEITSTAND', 'LIMITS', 'SITZUNGEN', 'CREW', 'MODELLE', 'Kosten heute', 'Anfragen']) expect(texteVon(a)).toContain(abschnitt)
    if (hoehe >= 28) expect(ansichtHoehe(a)).toBeLessThanOrEqual(hoehe)
  }
  // 33 Zeilen reichen, ohne die Figuren der arbeitenden Sitzung zu opfern
  expect(baueAnsicht(ansichtDaten({ hoehe: 33 })).crew.length).toBeGreaterThan(0)
  // schmal und ohne Raster: ebenfalls vollständig
  const schmal = baueAnsicht(ansichtDaten({ breite: 50, raster: false, hoehe: 30 }))
  for (const abschnitt of ['LIMITS', 'MODELLE', 'SITZUNGEN', 'CREW']) expect(texteVon(schmal)).toContain(abschnitt)
  expect(STUFEN.length).toBeGreaterThan(5)
})

test('Kacheln und Modelle: Summe über die gewählte Sitzung (Standard: alle)', () => {
  const alleText = (teil: Partial<AnsichtDaten>) =>
    baueAnsicht(ansichtDaten(teil)).zeilen.map(zeilenText).join('\n')
  const alle = alleText({})
  expect(alle).toContain('alle Sitzungen')
  expect(alle).toMatch(/\b172\b/) // 142 + 10 + 10 + 10 Anfragen
  const eine = alleText({ auswahl: 'eigene' })
  expect(eine).toMatch(/\b142\b/)
  expect(eine).toContain('CREW · webshop')
  const b = alleText({ auswahl: 'b' })
  expect(b).toContain('CREW · backend')
  expect(b).toContain('keine Subagents')
  expect(b).toMatch(/\b10\b/)
})

test('Ehrlichkeit: ohne gezählte Anfrage stehen „–" statt erfundener Zahlen; geschätzt immer mit ≈', () => {
  const leer = fremde('eigene', { gesamt: leerZ(), haupt: leerZ(), modelle: {}, kostenHeute: null, kosten: null, zaehlSeit: null })
  const text = baueAnsicht(ansichtDaten({ sitzungen: [leer] })).zeilen.map(zeilenText).join('\n')
  expect(text).toContain('noch keine Anfragen gezählt')
  expect(text).toContain('Cache spart: noch keine Messung')
  expect(text).not.toMatch(/\$ \d/)
  const voll = baueAnsicht(ansichtDaten()).zeilen.map(zeilenText).join('\n')
  expect(voll).toMatch(/Cache spart ≈ \d+ %/)
  expect(voll).toContain('Cache≈') // Spaltenkopf der geschätzten Cache-Wärme
})

test('Pane auf Terminal und Desktop: Kopf, Kacheln, Sitzungen; Auswahl per Knopf; 40, 60 und 80 Spalten ohne Überbreite', async ($, on) => {
  const w = welt(on, {
    cwd: '/work/brain',
    dateien: {
      'a.json': { inhalt: fremde('a', { projekt: 'webshop', agents: [agent('a1')] }) },
      'b.json': { inhalt: fremde('b', { projekt: 'backend', zustand: 'wartet', werkzeug: null, ziel: '' }) },
    },
  })
  await starten($, '/work/brain')
  await w.vor(2100)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const spalten of [40, 60, 80]) {
      const ui = await $.ui.mount({ ...PANE(spalten), surface })
      expect(await ui.find({ type: 'Text', text: /LEITSTAND/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /SITZUNGEN/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 akt/ })).toBeDefined() // (ab 41 Spalten „2 aktiv", darunter „2 akt.") nur aktive Sitzungen mit Inhalt; die leere eigene steht in „+1 leere Sitzung"
      expect(await ui.find({ type: 'Text', text: /\+1 leere Sitzung \(inkl\. diese\)/ })).toBeDefined()
      const baum: any = await ui.drawn()
      for (const zeile of zeilenDerWurzel(baum)) expect(messe(zeile)).toBeLessThanOrEqual(spalten)
      await ui.unmount()
    }
  }
  // Ein Klick auf eine Sitzungszeile wählt sie: Crew, Kacheln und Modelle folgen; „Alle" zeigt die Übersicht
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /── CREW ─/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CREW · / })).toBeUndefined()
  await ui.press({ key: 'b' })
  expect(await ui.find({ type: 'Text', text: /CREW · backend/ })).toBeDefined()
  await ui.press({ key: 'b' }) // zweiter Klick nimmt zurück
  expect(await ui.find({ type: 'Text', text: /CREW · / })).toBeUndefined()
  await ui.press({ key: 'a' })
  await ui.press({ key: 'alle' })
  expect(await ui.find({ type: 'Text', text: /CREW · / })).toBeUndefined()
  // Agent anklicken: Knöpfe Nachricht und Stopp erscheinen
  await ui.press({ key: 'a' })
  await ui.press({ key: 'g:a1' })
  expect(await ui.find({ type: 'Button', key: 'n-a1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 's-a1' })).toBeDefined()
  await ui.unmount()
})

test('Leerzustand: ohne Sitzung (eigene ist privat) bleibt die Ansicht sauber', async ($, on) => {
  const w = welt(on, { cwd: '/work/familie' })
  await starten($, '/work/familie')
  await w.vor(2100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE(60), surface })
    expect(await ui.find({ type: 'Text', text: /Noch keine Sitzung/ })).toBeDefined()
    await ui.unmount()
  }
})

// ---- Raster, Männchen, Animation ---------------------------------------------------------------------------------------

test('Animation: nur die Crew-Streifen werden per blit gemalt, nur bei Änderung, nur solange das Pane offen ist', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop', dateien: { 'a.json': { inhalt: fremde('a', { projekt: 'webshop', agents: [] }) } } })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag1' }))
  await starten($, '/work/webshop')
  await $.agent.spawn({ prompt: 'p', description: 'Suche', subagentType: 'Explore' } as any)
  w.agentenListe = [{ id: 'ag1', description: 'Suche', type: 'Explore', status: 'running' }]
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  // Übersicht: je aktiver Sitzung mit Inhalt ein eigener Streifen (hier die eigene mit Agent und die Datei „a")
  expect(await ui.find({ type: 'Raster', key: 'crew:eigene' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'crew:a' })).toBeDefined()
  w.blits.length = 0
  await w.vor(1000) // vier Bilder
  expect(w.blits.length).toBeGreaterThanOrEqual(3) // ein laufender Agent: Beine und Arme wechseln
  expect(w.blits[0]).toMatchObject({ requestId: 'leitstand', key: 'crew:eigene' })
  const aufgebaut = Uint8Array.from(atob(w.blits[0].cells), c => c.charCodeAt(0))
  expect(aufgebaut.length).toBe(w.blits[0].columns * w.blits[0].rows * 12)
  // Die ganze Zeichnung geschieht ohne Render-Durchlauf: der Baum hat nur die Raster (Ring, zwei Crew-Streifen)
  expect((await ui.findAll({ type: 'Raster' })).length).toBe(3)
  await ui.unmount()
})

test('Animation ruht, wenn nichts läuft (kein Bild gleicht dem vorigen)', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop', dateien: { 'a.json': { inhalt: fremde('a', { zustand: 'ruht', zustandSeit: JETZT - 2 * STD }) } } })
  await starten($, '/work/webshop')
  await w.vor(2100)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await w.vor(1000)
  w.blits.length = 0
  await w.vor(2000) // ohne Blinzeln-Bild (alle 3 s) bleibt es still
  expect(w.blits.length).toBeLessThanOrEqual(1)
  await ui.unmount()
})

test('Männchen: Hut stabil je Kennung, Krone nur für die Hauptsitzung, Zustandsbilder unterscheiden sich', () => {
  expect(hutFuer('agent-1')).toBe(hutFuer('agent-1'))
  expect(hutFuer('x', true)).toBe('krone')
  const huete = new Set(Array.from({ length: 200 }, (_, i) => hutFuer(`agent-${i}`)))
  expect(huete.size).toBe(HUETE.length - 1)
  expect(huete.has('krone')).toBe(false)
  const o = { hut: 'cap', tick: 0 } as const
  const bild = (zustand: MannZustand, tick = 0, phase?: number) => JSON.stringify(pixel({ ...o, zustand, tick, phase }))
  const g = pixel({ ...o, zustand: 'wartet' })
  expect(g.length).toBe(8)
  expect(g.every(r => r.length === 11)).toBe(true)
  expect(bild('arbeitet', 0)).not.toBe(bild('arbeitet', 1)) // Beine und Arme wechseln
  expect(bild('wartet', 0)).not.toBe(bild('wartet', 11)) // blinzelt alle 12 Bilder (3 s)
  expect(bild('wartet', 0)).toBe(bild('wartet', 5))
  expect(bild('fertig', 0, 0)).not.toBe(bild('fertig', 0, 10)) // einmal hüpfen, dann ruhig
  expect(bild('fertig', 0, 10)).toBe(bild('fertig', 7, 30))
  expect(bild('ruht')).not.toBe(bild('wartet'))
  expect(bild('braucht', 0)).not.toBe(bild('braucht', 2)) // leichtes Hüpfen
  const rot = pixel({ ...o, zustand: 'fehler' }).flat().filter(Boolean)
  expect(rot).toContain('#F87171')
  expect(pixel({ ...o, zustand: 'wartet' }).flat()).toContain('#D97757')
  // Augen sind dunkel, Körper #D97757
  expect(pixel({ ...o, zustand: 'wartet' })[4]![3]).toBe('#1A1A1A')
})

test('Raster: Packformat (u32-Tripel, Base64), Crew-Streifen und Ring', () => {
  const r = new Zellen(2, 1)
  r.setze(0, 0, '█', 0xff8800, 0x01000000)
  r.setze(1, 0, '⠿')
  const bytes = Uint8Array.from(atob(r.kodiere()), c => c.charCodeAt(0))
  expect(bytes.length).toBe(24)
  const w = new DataView(bytes.buffer)
  expect([w.getUint32(0, true), w.getUint32(4, true), w.getUint32(8, true)]).toEqual([0x2588, 0xff8800, 0x01000000])
  expect(w.getUint32(12, true)).toBe(0x283f)
  const crew = crewZellen([{ hutKey: 's', haupt: true, zustand: 'arbeitet', modell: 'opus 5.5', familie: 'opus', name: 'Haupt', beendet: null }], 40, 0, JETZT, 250)
  expect(crew.spalten).toBe(40)
  expect(crew.zeilen).toBe(6)
  const ring = ringZellen(0.95, '95 %', '#4ADE80', '#6B7280')
  expect(ring.spalten).toBe(10)
  expect(ring.zeilen).toBe(5)
  const mitte = Array.from({ length: 10 }, (_, x) => String.fromCodePoint(ring.cp[2 * 10 + x]!)).join('')
  expect(mitte).toContain('95')
})

// ---- Titel der Sitzung (0.3) -----------------------------------------------------------------------------------------

test('Titel: kommt aus dem Transcript der Sitzung (customTitle vor aiTitle, jeweils der letzte), wird auf 40 Zeichen gekürzt; gelesen wird nur der Titel', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  await starten($, '/work/webshop')
  await w.vor(2100)
  expect(w.datei('eigene').titel).toBeNull() // noch kein Transcript: die Ansicht fällt auf „<Ordner> · seit HH:MM" zurück
  const pfad = w.transkript(['{"type":"user","message":{"content":"geheimer Prompt"}}', '{"type":"ai-title","aiTitle":"Erster Titel","sessionId":"eigene"}'])
  await w.vor(21_000) // alle 20 s wird nachgesehen
  expect(w.datei('eigene').titel).toBe('Erster Titel')
  w.transkript(['{"type":"ai-title","aiTitle":"Katalog-Export\\n prüfen und alle Preise dazu vergleichen, bitte"}'])
  await w.vor(21_000)
  const t = w.datei('eigene').titel as string
  expect(t.length).toBeLessThanOrEqual(40)
  expect(t.startsWith('Katalog-Export prüfen und alle Preise')).toBe(true)
  // ein selbst vergebener Titel (/rename) geht vor, auch wenn danach ein neuer aiTitle folgt
  w.transkript(['{"type":"custom-title","customTitle":"Mein \\"Name\\""}', '{"type":"ai-title","aiTitle":"Noch ein KI-Titel"}'])
  await w.vor(21_000)
  expect(w.datei('eigene').titel).toBe('Mein "Name"')
  // die Datei der Mod enthält den Titel, aber nie Prompts oder Antworten
  const roh = w.speicher.get(`${DIR}/${dateiName('eigene')}`)!.text
  expect(roh).not.toContain('geheimer Prompt')
  expect(pfad).toContain(projektOrdner('/work/webshop'))
  // nicht öfter als alle 20 s nachsehen
  const anzahl = w.greps
  await w.vor(10_000)
  expect(w.greps).toBe(anzahl)
  expect(titelBereinigen('   ')).toBeNull()
  expect(titelBereinigen(undefined)).toBeNull()
  expect(titelBereinigen('x'.repeat(100))!.length).toBe(40)
  expect(projektOrdner('/Users/x/.claude/projects')).toBe('-Users-x--claude-projects')
  expect(titelAusTreffern('"aiTitle":"A"\n"aiTitle":"B"\n')).toBe('B')
  expect(titelAusTreffern('"aiTitle":"A"\n"customTitle":"C"\n"aiTitle":"B"\n')).toBe('C')
  expect(titelAusTreffern('Quatsch\n"aiTitle":kaputt\n')).toBeNull()
})

test('Titel und Ausblenden: nennt der Titel ein Ausblenden-Wort, schreibt die Sitzung nichts mehr und ihre frühere Datei verschwindet', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  await starten($, '/work/webshop')
  await w.vor(2100)
  expect(w.hat('eigene')).toBe(true)
  w.transkript(['{"type":"ai-title","aiTitle":"Hobbybot Planung"}'])
  await w.vor(21_000)
  expect(w.hat('eigene')).toBe(false)
  expect(w.entfernt).toContain(`${DIR}/${dateiName('eigene')}`)
  const geschrieben = w.geschrieben.length
  await w.vor(60_000)
  expect(w.geschrieben.length).toBe(geschrieben) // und bleibt still
  expect(istSitzungVersteckt('/work/webshop', 'Spielwelt bauen', ['spielwelt'])).toBe(true)
  expect(istSitzungVersteckt('/work/webshop', 'Katalog', ['spielwelt'])).toBe(false)
  expect(istSitzungVersteckt('/work/webshop', null, ['spielwelt'])).toBe(false)
})

test('Titel: ein privater Arbeitsordner liest gar kein Transcript', async ($, on) => {
  const w = welt(on, { cwd: '/work/familie' })
  w.transkript(['{"type":"ai-title","aiTitle":"Etwas"}'], 'eigene', '/work/familie')
  await starten($, '/work/familie')
  await w.vor(30_000)
  expect(w.greps).toBe(0)
  expect(w.geschrieben).toEqual([])
})

test('Namen: Titel, sonst „<Ordner> · seit HH:MM"; Kurz-ID nur, wo zwei Sitzungen sonst gleich hießen', () => {
  const a = fremde('abcd1111', { projekt: 'source', gestartet: JETZT - 60 * MIN })
  const b = fremde('efgh2222', { projekt: 'source', gestartet: JETZT - 60 * MIN })
  const c = fremde('ijkl3333', { projekt: 'source', gestartet: JETZT - 30 * MIN })
  const t = fremde('mnop4444', { projekt: 'source', titel: 'Katalog-Export prüfen' })
  const lang = fremde('qrst5555', { projekt: 'source', titel: 'x'.repeat(60) })
  const n = anzeigeNamen([a, b, c, t, lang], JETZT)
  expect(n.get('abcd1111')).toBe('source · seit 11:00 ·abcd')
  expect(n.get('efgh2222')).toBe('source · seit 11:00 ·efgh')
  expect(n.get('ijkl3333')).toBe('source · seit 11:30') // eindeutig: keine Kennung
  expect(n.get('mnop4444')).toBe('Katalog-Export prüfen')
  expect(Array.from(n.get('qrst5555')!).length).toBeLessThanOrEqual(40)
  // zwei Sitzungen mit gleichem Titel bekommen die Kennung ebenfalls
  const g1 = fremde('1111aaaa', { titel: 'Gleich' })
  const g2 = fremde('2222bbbb', { titel: 'Gleich' })
  expect([...anzeigeNamen([g1, g2], JETZT).values()]).toEqual(['Gleich ·1111', 'Gleich ·2222'])
  // eine Sitzung von gestern zeigt den Wochentag
  const gestern = fremde('zzzz', { projekt: 'source', gestartet: JETZT - 30 * STD })
  expect(anzeigeNamen([gestern], JETZT).get('zzzz')).toMatch(/^source · seit [A-Z][a-z] \d\d:\d\d$/)
})

// ---- Gruppen der Sitzungsliste (0.3) ----------------------------------------------------------------------------------

/** Die Lage aus dem Screenshot: drei leere frische Sitzungen, eine ruhende mit Kosten, eine arbeitende, eine im anderen Profil. */
function lageScreenshot(): LeitstandSitzung[] {
  const leer = (id: string) => fremde(id, { projekt: 'source', gesamt: leerZ(), haupt: leerZ(), modelle: {}, kosten: 0, kostenHeute: 0, kontextProzent: null, letzteAntwort: null, zustand: 'wartet', werkzeug: null, ziel: '', zaehlSeit: null, gestartet: JETZT - 5 * MIN })
  return [
    leer('eigene'),
    leer('leer1'),
    leer('leer2'),
    fremde('ruhend', { projekt: 'backend', gesamt: z(1, 4000, 29_000, 2000, 700), haupt: z(1, 4000, 29_000, 2000, 700), modelle: { 'opus 5.5': z(1, 4000, 29_000, 2000, 700) }, kosten: 0.19, kostenHeute: 0.19, zustand: 'ruht', zustandSeit: JETZT - 50 * MIN, beendet: JETZT - 25 * MIN, herz: JETZT - 25 * MIN, limits: [{ art: 'five_hour', prozent: 28, reset: JETZT + 2 * STD }, { art: 'seven_day', prozent: 87, reset: JETZT + 2 * TAG }], limitsZeit: JETZT - 50 * MIN }),
    fremde('arbeitend', { projekt: 'webshop', titel: 'Katalog-Export prüfen', kostenHeute: 3.4, agents: [agent('x1', { name: 'Aufräumen', werkzeug: 'Bash', ziel: 'npm test' }), agent('x2', { name: 'Suche', stand: 'fertig', beendet: JETZT - MIN }), agent('x3', { name: 'Prüfen', stand: 'fehler', beendet: JETZT - 2 * MIN })] }),
    fremde('zweit', { profil: '.claude-zweit', projekt: 'dokumente', zustand: 'wartet', kostenHeute: 1.2 }),
  ]
}

test('Gruppen: aktiv mit Inhalt einzeln, leere als EINE Zeile, heute Beendete gedimmt darunter; „N aktiv" zählt nur die erste Gruppe', () => {
  const gr = gruppiere(lageScreenshot(), 'eigene', JETZT)
  expect(gr.aktiv.map(s => s.sessionId).sort()).toEqual(['arbeitend', 'zweit'])
  expect(gr.leer.map(s => s.sessionId).sort()).toEqual(['eigene', 'leer1', 'leer2'])
  expect(gr.beendet.map(s => s.sessionId)).toEqual(['ruhend'])
  const text = baueAnsicht(ansichtDaten({ sitzungen: lageScreenshot() })).zeilen.map(zeilenText)
  const joined = text.join('\n')
  expect(joined).toContain('2 aktiv · 1 Agent') // Kopfzeile
  expect(text.filter(l => /\+3 leere Sitzungen \(inkl\. diese\)/.test(l)).length).toBe(1) // eine Zeile statt dreier
  expect(joined).not.toMatch(/source · seit/) // die leeren stehen nicht einzeln da
  const trenn = text.findIndex(l => /heute beendet\/ruhend/.test(l))
  expect(trenn).toBeGreaterThan(text.findIndex(l => /\+3 leere/.test(l)))
  expect(text[trenn + 1]).toMatch(/backend · seit \d\d:\d\d +○ beendet 11:35 +\$ 0,19/) // mit Kosten > 0 in der Liste: auch der Kostenposten ist dort zu finden
  // leere Sitzungen ohne Kosten, die beendet sind, erscheinen auch nur in der Zählzeile
  const beendetLeer = fremde('bl', { gesamt: leerZ(), kostenHeute: 0, beendet: JETZT - 5 * MIN, herz: JETZT - 5 * MIN })
  expect(gruppiere([beendetLeer], 'x', JETZT).leer.length).toBe(1)
  // arbeitet oder braucht dich: auch ohne Anfrage und Agents nicht leer
  const braucht = fremde('br', { gesamt: leerZ(), kostenHeute: 0, zustand: 'braucht', zustandSeit: JETZT - MIN })
  expect(gruppiere([braucht], 'x', JETZT).aktiv.length).toBe(1)
  // jede Sitzung der Kostenaufteilung steht auch in der Liste
  const kosten = lageScreenshot().filter(s => (s.kostenHeute ?? 0) > 0).map(s => s.sessionId)
  const inListe = [...gr.aktiv, ...gr.beendet].map(s => s.sessionId)
  for (const id of kosten) expect(inListe).toContain(id)
})

test('Gruppen: vor der ersten Anfrage stehen Kontext und Cache als „neu" (gedimmt), nicht als „–"', () => {
  const frisch = fremde('frisch', { projekt: 'webshop', gesamt: leerZ(), haupt: leerZ(), modelle: {}, kostenHeute: 0, kontextProzent: null, letzteAntwort: null, zustand: 'arbeitet' })
  const text = baueAnsicht(ansichtDaten({ sitzungen: [fremde('eigene'), frisch] })).zeilen.find(zl => zl.art === 'knopf' && zl.key === 'frisch')!
  expect(zeilenText(text)).toMatch(/neu\s+opus\s+● ?neu|neu\s+opus\s+neu/)
  const segs = (text as any).segs as Array<{ t: string; dim?: boolean }>
  expect(segs.filter(sg => sg.t === 'neu').every(sg => sg.dim === true)).toBe(true)
  expect(segs.filter(sg => sg.t === 'neu').length).toBe(2)
  // nach der ersten Anfrage ohne Messwert bleibt es beim „–"
  const mitAnfrage = fremde('m', { kontextProzent: null, letzteAntwort: null })
  const t2 = baueAnsicht(ansichtDaten({ sitzungen: [fremde('eigene'), mitAnfrage] })).zeilen.find(zl => zl.art === 'knopf' && zl.key === 'm')!
  expect(zeilenText(t2)).not.toContain('neu')
})

// ---- Konsistenz der Mengen (0.3) --------------------------------------------------------------------------------------

test('Konsistenz: Kacheln, Cache, Kosten und Modelle beziehen sich auf dieselbe Menge (Alle = alle heutigen Sitzungen inkl. beendeter)', () => {
  const sitz = ansichtDaten().sitzungen // enthält die beendete Sitzung „d"
  for (const auswahl of [null, 'eigene', 'd', 'b']) {
    const umfang = auswahl ? sitz.filter(s => s.sessionId === auswahl) : sitz
    const zs = zaehlerSumme(umfang)
    const ms = modelleSumme(umfang)
    // Daten: die Summe über die Modelle ist die Summe der Kacheln
    expect(ms.reduce((n, m) => n + m.z.anfragen, 0)).toBe(zs.anfragen)
    expect(ms.reduce((n, m) => n + m.z.eingabe, 0)).toBe(zs.eingabe)
    expect(ms.reduce((n, m) => n + m.z.cacheLesen, 0)).toBe(zs.cacheLesen)
    expect(ms.reduce((n, m) => n + m.z.cacheSchreiben, 0)).toBe(zs.cacheSchreiben)
    expect(ms.reduce((n, m) => n + m.z.ausgabe, 0)).toBe(zs.ausgabe)
    // Anzeige: Kachel „Anfragen", Zeilen „… Anfr." der Modelle und Kostenkarte nennen dasselbe
    const zeilen = baueAnsicht(ansichtDaten({ auswahl })).zeilen.map(zeilenText).join('\n').split('\n')
    const kachel = zeilen.find(l => /^│\s*[\d.]+\s*││/.test(l))!.match(/^│\s*([\d.]+)\s*│/)![1]!
    expect(kachel).toBe(String(zs.anfragen).replace(/\B(?=(\d{3})+(?!\d))/g, '.'))
    const i = zeilen.findIndex(l => l.includes('MODELLE'))
    const modellZeilen = zeilen.slice(i + 1).filter(l => /Anfr\./.test(l) && /●/.test(l))
    const summe = modellZeilen.reduce((n, l) => n + Number(l.match(/([\d.]+) Anfr\./)![1]!.replace(/\./g, '')), 0)
    expect(summe).toBe(zs.anfragen)
    expect(modellZeilen.length).toBe(ms.length) // kein Modell fehlt
    const kosten = umfang.reduce((n, s) => n + (s.kostenHeute ?? 0), 0)
    expect(zeilen.join('\n')).toContain(`gemessen · ${auswahl ? '' : 'alle Sitzungen'}`)
    expect(zeilen.some(l => l.includes(dollar(kosten)))).toBe(true)
  }
})

// ---- Crew (0.3) -------------------------------------------------------------------------------------------------------

/** Text des Rasters (nur Zeichen, ohne Farbe) als Zeilen. */
function rasterText(r: Zellen): string[] {
  return Array.from({ length: r.zeilen }, (_, y) => Array.from({ length: r.spalten }, (_, x) => String.fromCodePoint(r.cp[y * r.spalten + x]!)).join(''))
}

test('Crew-Übersicht (Alle): je aktiver Sitzung mit Inhalt ein Block mit Namen links und Figuren daneben, laufende Agents als Zeilen darunter', () => {
  const eigene = ansichtDaten().sitzungen[0]!
  const sitz = [{ ...eigene, titel: 'Katalog-Export prüfen' }, ...ansichtDaten().sitzungen.slice(1)]
  const a = baueAnsicht(ansichtDaten({ sitzungen: sitz }))
  const bloecke = a.zeilen.filter((zl): zl is Extract<typeof zl, { art: 'block' }> => zl.art === 'block' && zl.key.startsWith('crew:'))
  expect(bloecke.map(b => b.key)).toEqual(['crew:eigene', 'crew:c', 'crew:b']) // Reihenfolge der Liste (braucht dich vor wartet); „d" ist beendet, die Figuren fehlen dort
  expect(a.crew.map(c => c.key)).toEqual(['crew:eigene', 'crew:c', 'crew:b'])
  const mein = bloecke[0]!
  expect(mein.raster.zeilen).toBe(6)
  expect(mein.links.map(l => l.map(sg => sg.t).join('')).join('\n')).toContain('Katalog-Export prüfen') // Sitzungsname links
  const figuren = a.crew[0]!.figuren
  expect(figuren.length).toBe(5) // Haupt + 4 Agents
  expect(figuren[0]).toMatchObject({ haupt: true, name: 'Haupt' })
  const bild = rasterText(mein.raster)
  expect(bild[4]).toContain('opus 5.5') // unter jeder Figur Modell-Kurzname …
  expect(bild[5]).toContain('Haupt') // … und höchstens 10 Zeichen Name
  expect(bild[5]).toContain('Aufräumen')
  // laufende Agents: eine Zeile mit Werkzeug, Ziel, Laufzeit, Anfragen, Tokens; fertige und fehlgeschlagene nur als Figur
  const zeilen = a.zeilen.map(zeilenText)
  const iA = zeilen.findIndex(l => l.includes('Edit') && l.includes('build.mjs'))
  expect(iA).toBeGreaterThan(-1)
  expect(zeilen[iA]).toMatch(/Edit +build\.mjs +2:00 +31 Anfr\. +↑1,3 M ↓18 k/)
  expect(zeilen.some(l => /Grep +TODO/.test(l))).toBe(true)
  expect(a.zeilen.filter(zl => zl.art === 'knopf' && zl.key.startsWith('g:')).map(zl => (zl as any).key).sort()).toEqual(['g:a1', 'g:a2'])
  expect(zeilen.join('\n')).not.toContain('fertig') // keine Zeile für den fertigen Agent
  // Namen stehen in der Werkzeugzeile nicht noch einmal (sie stehen unter den Figuren)
  expect(zeilen[iA]).not.toContain('Aufräumen')
  for (const zl of a.zeilen) expect(zeilenBreite(zl)).toBeLessThanOrEqual(84)
})

test('Crew-Übersicht: ab dem fünften Agent keine Figuren mehr, dafür „+N"; schmal ohne Figuren mit Namen in den Zeilen', () => {
  const viele = Array.from({ length: 8 }, (_, i) => agent(`v${i}`, { name: `Agent${i}`, werkzeug: 'Read', ziel: `datei${i}.ts` }))
  const sitz = [fremde('eigene', { agents: viele }), fremde('b')]
  const a = baueAnsicht(ansichtDaten({ sitzungen: sitz }))
  expect(a.crew[0]!.figuren.length).toBe(5) // Haupt + 4
  expect(a.zeilen.map(zeilenText).join('\n')).toContain('+ 4 weitere Agents') // 8 − 4
  // schmal (ohne Figuren): der Name steht in der Zeile, weil keine Figur ihn trägt
  const schmal = baueAnsicht(ansichtDaten({ sitzungen: sitz, breite: 50, raster: false }))
  expect(schmal.crew).toEqual([])
  const text = schmal.zeilen.map(zeilenText).join('\n')
  expect(text).toContain('Agent0')
  for (const zl of schmal.zeilen) expect(zeilenBreite(zl)).toBeLessThanOrEqual(50)
})

test('Crew-Detail einer Sitzung: Name und Modell unter der Figur, die Liste nur mit Werkzeug, Ziel, Zeiten und Tokens', () => {
  const a = baueAnsicht(ansichtDaten({ auswahl: 'eigene' }))
  const figuren = a.zeilen.find(zl => zl.art === 'raster') as Extract<ReturnType<typeof baueAnsicht>['zeilen'][number], { art: 'raster' }>
  const bild = rasterText(figuren.raster).join('\n')
  expect(bild).toContain('Aufräumen')
  expect(bild).toContain('sonnet 4.5')
  const listen = a.zeilen.filter(zl => zl.art === 'knopf' && (zl.key.startsWith('g:') || zl.key.startsWith('h:'))).map(zeilenText)
  expect(listen.length).toBe(5) // Haupt + 4 Agents
  for (const l of listen) {
    expect(l).not.toContain('Aufräumen')
    expect(l).not.toContain('Suche')
    expect(l).not.toMatch(/sonnet|haiku|opus/)
  }
  expect(listen.some(l => /Edit +build\.mjs/.test(l))).toBe(true)
  expect(a.zeilen.map(zeilenText).join('\n')).toContain('CREW · webshop')
})

// ---- Männchen: Hut sitzt auf dem Kopf (0.3) ------------------------------------------------------------------------------

test('Hüte: die unterste Hutzeile sitzt direkt auf dem Kopf, in derselben Zellzeile; die Krone ist `...........` / `...G.G.G...` / `...GGGGG...`', () => {
  const zustaende: MannZustand[] = ['arbeitet', 'wartet', 'braucht', 'ruht', 'fertig', 'fehler']
  for (const hut of HUETE) {
    for (const zustand of zustaende) {
      for (const tick of [0, 1, 2, 3, 11]) {
        const g = pixel({ hut, zustand, tick, phase: tick })
        // Pixelzeile 2 (Hut unten) und 3 (Kopf oben) bilden zusammen die Zellzeile 1
        const hutUnten = g[2]!
        const kopfOben = g[3]!
        expect(hutUnten.some(Boolean)).toBe(true) // nie leer: der Hut schwebt nicht
        expect(hutUnten.some((p, x) => p !== null && kopfOben[x] !== null)).toBe(true) // mindestens ein Hutpixel liegt unmittelbar über einem Kopfpixel
        expect(g.length).toBe(8)
      }
    }
  }
  const krone = pixel({ hut: 'krone', zustand: 'wartet', tick: 0 })
  const zeile = (y: number) => krone[y]!.map(p => (p === null ? '.' : p === '#FACC15' ? 'G' : '?')).join('')
  expect([zeile(0), zeile(1), zeile(2)]).toEqual(['...........', '...G.G.G...', '...GGGGG...'])
  // Eine Zelle zeigt oben den Hut, unten den Körper (Vorder- und Hintergrundfarbe): kein Spalt dazwischen
  const raster = new Zellen(11, 4)
  maleMann(raster, 0, 0, { hut: 'krone', zustand: 'wartet', tick: 0 })
  const i = 1 * 11 + 4
  expect(String.fromCodePoint(raster.cp[i]!)).toBe('▀')
  expect(raster.fg[i]).toBe(farbe('#FACC15'))
  expect(raster.bg[i]).toBe(farbe('#D97757'))
  // Zellzeile 0 hat bei der Krone nur die Spitzen
  expect(String.fromCodePoint(raster.cp[0 * 11 + 3]!)).toBe('▄')
})

// ---- Limits: Stand der Messung (0.3) ---------------------------------------------------------------------------------

test('Limits-Stand in der Datei: erstmals der Beginn der Sitzung, danach der Zeitpunkt der Änderung', async ($, on) => {
  const reset = new Date(JETZT + 2 * STD).toISOString()
  const w = welt(on, { cwd: '/work/webshop', usage: { startedAt: JETZT - 3 * STD, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: reset }] } })
  await starten($, '/work/webshop')
  await w.vor(2100)
  expect(w.datei('eigene').limitsZeit).toBe(JETZT - 3 * STD) // erstmals gesehen: nicht „jetzt" (der Wert kann älter sein)
  await w.vor(10 * MIN)
  expect(w.datei('eigene').limitsZeit).toBe(JETZT - 3 * STD) // unverändert: der Stand wird nicht frisch geredet
  w.usage.rateLimits = [{ kind: 'five_hour', percentUsed: 31, resetsAt: reset }]
  await w.vor(2100)
  const stand = w.datei('eigene').limitsZeit as number
  expect(stand).toBeGreaterThan(JETZT + 10 * MIN)
  expect(stand).toBeLessThanOrEqual(w.jetzt)
  // fehlen die Werte kurz, bleibt der letzte Stand in der Datei
  w.usage.rateLimits = []
  await w.vor(2100)
  expect(w.datei('eigene').limits).toEqual([{ art: 'five_hour', prozent: 31, reset: JETZT + 2 * STD }])
  expect(w.datei('eigene').limitsZeit).toBe(stand)
})

// ---- Formatierung und Bezeichnungen -------------------------------------------------------------------------------------

test('Zahlen deutsch: 1,9 M · 212 k · $ 18,42', () => {
  expect(tokens(842)).toBe('842')
  expect(tokens(1234)).toBe('1,2 k')
  expect(tokens(212_345)).toBe('212 k')
  expect(tokens(1_900_000)).toBe('1,9 M')
  expect(tokens(38_400_000)).toBe('38,4 M')
  expect(dollar(18.42)).toBe('$ 18,42')
  expect(dollar(1234.5)).toBe('$ 1.234,50')
  expect(dezimal(0.5, 1)).toBe('0,5')
})

test('Modell-Bezeichnungen aus der ID', () => {
  expect(modellBezeichnung('claude-opus-5-5')).toBe('opus 5.5')
  expect(modellBezeichnung('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(modellBezeichnung('claude-sonnet-4-5-20250929')).toBe('sonnet 4.5')
  expect(modellBezeichnung('claude-3-5-sonnet-20241022')).toBe('sonnet 3.5')
  expect(modellBezeichnung('mein-modell')).toBe('mein-modell')
})

test('Lesen fremder Dateien: nichts glauben', () => {
  expect(pruefeSitzung({ sessionId: 'x' })).toBeNull()
  expect(pruefeSitzung('quatsch')).toBeNull()
  const s = pruefeSitzung({ v: 2, sessionId: 'x', herz: JETZT, projekt: 'p'.repeat(200), gesamt: { anfragen: -5, eingabe: 'viel', cacheLesen: 3 }, agents: [{ id: 'q', stand: 'komisch', z: 7 }], limits: [{ art: 'five_hour', prozent: 'x' }, { art: 'seven_day', prozent: 5, reset: null }] })!
  expect(s.projekt.length).toBeLessThanOrEqual(40)
  expect(s.agents[0]!.stand).toBe('laeuft')
  expect(s.gesamt).toEqual(z(0, 0, 3, 0, 0))
  expect(s.limits).toEqual([{ art: 'seven_day', prozent: 5, reset: null }])
  expect(dateiName('../../etc/passwd')).toBe('______etc_passwd.json')
})
