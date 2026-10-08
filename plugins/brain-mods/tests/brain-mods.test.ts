// brain-mods — Ende-zu-Ende-Tests mit dem Testkit von Claude Code (`claude plugin test`): keine Sitzung,
// kein Netzwerk; alles, was Claude Code beantworten würde, beantworten Stubs.
import { expect, mock, test } from 'claude-code/testing'

const JETZT = 1_800_000_000_000
const MIN = 60_000
const EIGENE_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const ANDERE_ID = 'bbbbbbbb-5555-6666-7777-888888888888'

type Opts = {
  store?: Record<string, unknown>
  antwort?: string
  prozent?: number
  standJson?: string
}

// Registriert alle Stubs, die der session.start-Hook und die übrigen Hooks brauchen. Gibt Sammelbehälter zurück.
function stubs(on: any, opts: Opts = {}) {
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const fragen: string[] = []
  const toasts: string[] = []
  const prozesse: string[][] = []
  mock.clock(on, { now: JETZT })
  mock.env(on, { HOME: '/home/test' })
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: EIGENE_ID }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.repo', () => ({ value: { root: '/work', remote: null, internal: false } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.usage', () => ({ value: { context: { tokens: (opts.prozent ?? 42) * 2000, window: 200000, percent: opts.prozent ?? 42 }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }))
  on('classic.PostCompact', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($: any, e: any) => {
    prozesse.push(e.argv)
    return { value: { exitCode: 0, stdout: opts.standJson ?? '{"stand":{"wartend":2,"konflikte":1,"pruefbeduerftig":0,"vorschlaege":1,"ingest":"02.10.","frisch":0},"hinweis":{"zeit":"x","seiten":["09_wiki/themen/alpha.md","09_wiki/beta.md"]}}', stderr: '' } }
  })
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const frage = e.questions[0].question
      fragen.push(frage)
      return { result: { answers: { [frage]: opts.antwort ?? 'Abbrechen' } } }
    }
    return { result: 'ok' }
  })
  return { store, fragen, toasts, prozesse }
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

function andereSitzung(herzVorMin: number, dateien: Record<string, number>) {
  return { id: ANDERE_ID, cwd: '/work', repo: '/work', herz: JETZT - herzVorMin * MIN, dateien }
}

test('Kollision: Abbrechen verweigert den Schreibzugriff', async ($, on) => {
  const s = stubs(on, { antwort: 'Abbrechen', store: { ['sitzung:' + ANDERE_ID]: andereSitzung(0, { '/work/a.txt': JETZT - 4 * MIN }) } })
  await $.session.start(START)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: 'a.txt', old_string: 'x', new_string: 'y' })
  expect(s.fragen.length).toBe(1)
  expect(s.fragen[0]).toContain('Sitzung bbbbbbbb')
  expect(s.fragen[0]).toContain('vor 4 min')
  expect(String(r.deny)).toContain('Abgebrochen')
})

test('Kollision: Fortfahren lässt durch und setzt den Anspruch', async ($, on) => {
  const s = stubs(on, { antwort: 'Fortfahren', store: { ['sitzung:' + ANDERE_ID]: andereSitzung(1, { '/work/a.txt': JETZT - 2 * MIN }) } })
  await $.session.start(START)
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/work/a.txt', content: 'y' })
  expect(r).toEqual({ result: 'ok' })
  const eigen: any = s.store.get('sitzung:' + EIGENE_ID)
  expect(eigen.dateien['/work/a.txt']).toBe(JETZT)
  // Zweiter Zugriff auf dieselbe Datei: schon bestätigt, keine zweite Frage
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.txt', old_string: 'y', new_string: 'z' })
  expect(s.fragen.length).toBe(1)
})

test('Tote Sitzung (kein Herzschlag seit > 3 min) löst keinen Dialog aus', async ($, on) => {
  const s = stubs(on, { store: { ['sitzung:' + ANDERE_ID]: andereSitzung(5, { '/work/a.txt': JETZT - 6 * MIN }) } })
  await $.session.start(START)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/work/a.txt', old_string: 'x', new_string: 'y' })
  expect(r).toEqual({ result: 'ok' })
  expect(s.fragen.length).toBe(0)
})

test('git stash im selben Repo wie eine andere Sitzung fragt nach', async ($, on) => {
  const s = stubs(on, { antwort: 'Abbrechen', store: { ['sitzung:' + ANDERE_ID]: andereSitzung(0, { '/work/src/b.js': JETZT - 10 * MIN }) } })
  await $.session.start(START)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git stash && git pull' })
  expect(s.fragen.length).toBe(1)
  expect(s.fragen[0]).toContain('git stash')
  expect(String(r.deny)).toContain('Abgebrochen')
  const harmlos: any = await $.tool.call({ tool: 'Bash', command: 'git stash list' })
  expect(harmlos).toEqual({ result: 'ok' })
})

test('/kontext zeigt Füllung und ab 80 % den Hinweis', async ($, on) => {
  const s = stubs(on, { prozent: 85 })
  await $.session.start(START)
  const antwort: any = await $.command.run({ command: 'kontext', args: '' })
  expect(antwort.text).toContain('Kontext 85 %')
  expect(antwort.text).toContain('Kontext fast voll')
  expect(s.toasts).toEqual(['Kontext fast voll — Stand sichern?'])
})

test('Band zeigt Kontext, Brain-Stand, Hinweis-Seiten und die Knöpfe', async ($, on) => {
  const s = stubs(on)
  await $.session.start(START)
  expect(s.prozesse[0]).toEqual(['node', '/home/test/brain/.tools/brain-stand.mjs', '--json', '--sid=' + EIGENE_ID])
  const ui = await $.ui.mount({
    plugin: 'brain-mods', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 110, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as any)
  expect(await ui.find({ type: 'Text', text: 'Kontext 42 % · 84k / 200k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Brain: 2 wartend' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '· 1 Konflikt(e)!' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Hinweis zur letzten Frage: alpha · beta' })).toBeDefined()
  expect(await ui.find({ key: 'stand-sichern' })).toBeDefined()
  expect(await ui.find({ key: 'gehirn-oeffnen' })).toBeDefined()
  await ui.press({ key: 'gehirn-oeffnen' })
  expect(s.prozesse.some((argv) => argv.join(' ') === 'node /home/test/brain/.tools/brain.mjs zeig')).toBe(true)
  await ui.unmount()
})

test('Nach Kompaktierung und /clear misst das Band sofort neu', async ($, on) => {
  const opts: Opts = { prozent: 88 }
  stubs(on, opts)
  await $.session.start(START)
  const band = () => $.ui.mount({
    plugin: 'brain-mods', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 110, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as any)
  let ui = await band()
  expect(await ui.find({ type: 'Text', text: 'Kontext 88 % · 176k / 200k' })).toBeDefined()
  await ui.unmount()
  opts.prozent = 12
  await ($ as any).classic.PostCompact({ trigger: 'manual' })
  ui = await band()
  expect(await ui.find({ type: 'Text', text: 'Kontext 12 % · 24k / 200k' })).toBeDefined()
  await ui.unmount()
  opts.prozent = 3
  await ($ as any).classic.SessionStart({ source: 'clear' })
  ui = await band()
  expect(await ui.find({ type: 'Text', text: 'Kontext 3 % · 6k / 200k' })).toBeDefined()
  await ui.unmount()
})
