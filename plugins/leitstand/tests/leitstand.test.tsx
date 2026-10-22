import { expect, mock, test } from 'claude-code/testing'

import { HUETE, alsText, hutFuer, maennchen, raster } from '../hooks/clawd'
import { ausblendenListe, bashZiel, dateiName, istVersteckt, pruefeSitzung, sichtbar, zielAus } from '../hooks/logik'
import type { LeitstandSitzung } from '../types'

const JETZT = 1_800_000_000_000
const MIN = 60_000
const DIR = '/home/test/.claude-leitstand/sitzungen'

const fremde = (id: string, teil: Partial<LeitstandSitzung> = {}): LeitstandSitzung => ({
  v: 1, sessionId: id, profil: '.claude', projekt: id, modell: 'opus', kontextProzent: 40, letzteAntwort: JETZT - 5 * MIN,
  kosten: 1.5, zustand: 'arbeitet', werkzeug: 'Bash', ziel: 'npm test', seit: JETZT - MIN, agents: [], herz: JETZT, ...teil,
})

const PANE = {
  plugin: 'leitstand',
  component: 'Pane',
  requestId: 'leitstand',
  props: { title: 'Leitstand', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** Welt unter dem Plugin: Dateiablage im Speicher, Uhr, Umgebung, Sitzung. */
function welt(on: any, opts: { cwd: string; dateien?: Record<string, unknown> } ) {
  const dateien = new Map<string, string>(Object.entries(opts.dateien ?? {}).map(([k, v]) => [`${DIR}/${k}`, JSON.stringify(v)]))
  dateien.set('/home/test/.claude-leitstand/ausblenden.txt', 'hobbybot\nspielwelt\nfamilie\n')
  const geschrieben: string[] = []
  const entfernt: string[] = []
  const clock = mock.clock(on, { now: JETZT })
  mock.env(on, { HOME: '/home/test', CLAUDE_CONFIG_DIR: '/home/test/.claude-firma2' })
  on('fs.write', (_$: any, e: any) => { dateien.set(e.path, e.text); geschrieben.push(e.path); return { value: undefined } })
  on('fs.read', (_$: any, e: any) => ({ value: dateien.get(e.path) ?? '' }))
  on('fs.list', () => ({ value: [...dateien.keys()].filter(p => p.startsWith(DIR + '/')).map(p => ({ name: p.split('/').pop(), kind: 'file', size: 1, mtimeMs: JETZT, isLink: false })) }))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'rm') for (const p of e.argv.slice(2)) { dateien.delete(p); entfernt.push(p) }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', () => ({ cwd: opts.cwd }))
  on('session.end', (_$: any, e: any) => ({ reason: e.reason, sessionId: e.sessionId, resume: e.resume }) as any)
  on('session.id', () => ({ value: 'eigene' }))
  on('session.cwd', () => ({ value: opts.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: JETZT, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }) as any)
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'leitstand', title: 'Leitstand', isShown: true, isFocused: false, isPlaced: true }] }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as any)
  return { dateien, geschrieben, entfernt, clock }
}

test('Herzschlag wird geschrieben und beim Sitzungsende gelöscht', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/webshop' } as any)
  await w.clock.advance(2100)
  const pfad = `${DIR}/${dateiName('eigene')}`
  expect(w.dateien.has(pfad)).toBe(true)
  const inhalt = JSON.parse(w.dateien.get(pfad)!)
  expect(inhalt.sessionId).toBe('eigene')
  expect(inhalt.projekt).toBe('webshop')
  expect(inhalt.modell).toBe('opus')
  expect(inhalt.profil).toBe('.claude-firma2')
  expect(inhalt.kontextProzent).toBe(25)
  // Nur bei Änderung: der nächste Takt schreibt (innerhalb von 30 s) nicht erneut.
  const anzahl = w.geschrieben.length
  await w.clock.advance(4100)
  expect(w.geschrieben.length).toBe(anzahl)
  await $.session.end({ reason: 'other', sessionId: 'eigene', resume: {} } as any)
  expect(w.dateien.has(pfad)).toBe(false)
  expect(w.entfernt).toContain(pfad)
})

test('Ausblenden-Liste: private Sitzung schreibt gar keine Datei', async ($, on) => {
  const w = welt(on, { cwd: '/Users/x/Spielwelt-PRIVAT/mod' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/Users/x/Spielwelt-PRIVAT/mod' } as any)
  await w.clock.advance(6000)
  expect(w.geschrieben).toEqual([])
  expect(istVersteckt('/a/HOBBYBOT-x', ausblendenListe('hobbybot,tagebuch'))).toBe(true)
  expect(istVersteckt('/a/webshop', ausblendenListe('hobbybot,tagebuch'))).toBe(false)
  expect(ausblendenListe(' A , ,b ')).toEqual(['a', 'b'])
})

test('Pane zeigt 0, 1 und 3 Sitzungen auf jeder Fläche', async ($, on) => {
  // 0: eigene Sitzung privat, keine Dateien
  const leer = welt(on, { cwd: '/work/familie' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/familie' } as any)
  await leer.clock.advance(2100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Noch keine Sitzung/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Pane zeigt eigene Sitzung (1) und mit zwei fremden (3), veraltete nicht', async ($, on) => {
  const w = welt(on, {
    cwd: '/work/brain',
    dateien: {
      'a.json': fremde('a', { projekt: 'webshop' }),
      'b.json': fremde('b', { projekt: 'backend', zustand: 'wartet', werkzeug: null, ziel: '' }),
      'tot.json': fremde('tot', { projekt: 'altlast', herz: JETZT - 4 * MIN }),
    },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/brain' } as any)
  await w.clock.advance(2100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /brain/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /webshop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /backend/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 Sitzungen/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /altlast/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('Veraltete Einträge (kein Herzschlag seit über 3 min) werden ausgeblendet', () => {
  expect(sichtbar({ herz: JETZT - 2 * MIN }, JETZT)).toBe(true)
  expect(sichtbar({ herz: JETZT - 3 * MIN - 1 }, JETZT)).toBe(false)
  expect(pruefeSitzung({ sessionId: 'x' })).toBeNull()
  expect(pruefeSitzung('quatsch')).toBeNull()
  const s = pruefeSitzung({ sessionId: 'x', herz: JETZT, projekt: 'p'.repeat(200), agents: [{ id: 'q', stand: 'komisch' }] })!
  expect(s.projekt.length).toBeLessThanOrEqual(40)
  expect(s.agents[0]!.stand).toBe('laeuft')
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
})

test('Männchen: Hut je Agent stabil, Hüte verschieden, Zustandswechsel ändern das Bild', () => {
  expect(hutFuer('agent-1')).toBe(hutFuer('agent-1'))
  const huete = new Set(Array.from({ length: 80 }, (_, i) => hutFuer(`agent-${i}`)))
  expect(huete.size).toBe(HUETE.length)
  const o = { hut: 'keiner', tick: 0 } as const
  const arbeitet0 = alsText(maennchen({ ...o, zustand: 'arbeitet' }).zeilen)
  const arbeitet1 = alsText(maennchen({ ...o, zustand: 'arbeitet', tick: 1 }).zeilen)
  expect(arbeitet0).not.toBe(arbeitet1) // Beine/Arme wechseln
  const m = maennchen({ ...o, zustand: 'arbeitet' })
  expect(m.zeilen.length).toBe(4)
  expect(m.zeilen.every(z => z.reduce((n, l) => n + l.text.length, 0) === 9)).toBe(true)
  // Hut ändert die oberste Zeile
  expect(alsText(maennchen({ hut: 'krone', zustand: 'ruht', tick: 0 }).zeilen)).not.toBe(alsText(maennchen({ hut: 'keiner', zustand: 'ruht', tick: 0 }).zeilen))
  // wartet: blinzelt (Augen zu bei tick 6), zeigt ?
  const offen = raster({ hut: 'keiner', zustand: 'wartet', tick: 0 })
  const zu = raster({ hut: 'keiner', zustand: 'wartet', tick: 6 })
  expect(offen[3]![2]).not.toBe(zu[3]![2])
  expect(maennchen({ ...o, zustand: 'wartet' }).zusatz).toBe('?')
  // fertig: Hüpfer in den ersten Bildern, danach ruhig + ✓
  expect(raster({ ...o, zustand: 'fertig', phase: 0 })).not.toEqual(raster({ ...o, zustand: 'fertig', phase: 10 }))
  expect(raster({ ...o, zustand: 'fertig', phase: 10 })).toEqual(raster({ ...o, zustand: 'fertig', phase: 20 }))
  expect(maennchen({ ...o, zustand: 'fertig', phase: 10 }).zusatz).toBe('✓')
  // Fehler: rot getönt + ✗
  const fehler = maennchen({ ...o, zustand: 'fehler' })
  expect(fehler.zusatz).toBe('✗')
  expect(fehler.zeilen.flat().some(l => l.fg === '#C0392B' || l.bg === '#C0392B')).toBe(true)
  expect(maennchen({ ...o, zustand: 'arbeitet' }).zeilen.flat().some(l => l.fg === '#D97757' || l.bg === '#D97757')).toBe(true)
})

test('Subagent erscheint im Herzschlag, mit Modell, und Befehlsinhalte bleiben draußen', async ($, on) => {
  const w = welt(on, { cwd: '/work/webshop' })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag1' }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/webshop' } as any)
  await $.agent.spawn({ prompt: 'suche', description: 'Dateien sichten', subagentType: 'Explore' } as any)
  await w.clock.advance(2100)
  const datei = () => JSON.parse(w.dateien.get(`${DIR}/${dateiName('eigene')}`)!)
  expect(datei().agents[0]).toMatchObject({ id: 'ag1', modell: 'haiku', beschreibung: 'Dateien sichten', stand: 'laeuft' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- --token=geheim' })
  await w.clock.advance(2100)
  expect(JSON.stringify(datei())).not.toContain('geheim')
})
