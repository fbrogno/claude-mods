import type { AgentSpawnInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { dollar, neuaufbau, preise, schaetzeKontext, vonPerson } from '../hooks/register'

const JETZT = 1_800_000_000_000
const MIN = 60_000

type Opts = { kontext?: number; antwortVorMin?: number | null; wahl?: string }

function stubs(on: any, opts: Opts = {}) {
  const store = new Map<string, unknown>()
  if (opts.antwortVorMin !== null && opts.antwortVorMin !== undefined) store.set('antwort:eigene', JETZT - opts.antwortVorMin * MIN)
  const fragen: string[] = []
  const gefuellt: string[] = []
  const gesendet: string[] = []
  mock.clock(on, { now: JETZT })
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', () => ({ cwd: '/work/app' }))
  on('session.id', () => ({ value: 'eigene' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: JETZT, context: { tokens: opts.kontext ?? 600_000, window: 1_000_000 }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }) as any)
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('prompt.fill', (_$: any, e: any) => { gefuellt.push(e.text); return { value: { isFilled: true } } })
  on('prompt.submit', (_$: any, e: any) => { gesendet.push(e.text); return { text: e.text } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const frage = e.questions[0].question
      fragen.push(frage)
      return { result: { answers: { [frage]: opts.wahl ?? 'Hier weiter' } } }
    }
    return { result: 'ok' }
  })
  return { store, fragen, gefuellt, gesendet }
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any

test('Preise und Neuaufbau-Kosten', () => {
  expect(preise('claude-opus-5-5')).toEqual({ lesen: 0.2, schreiben: 8 })
  expect(preise('claude-sonnet-5-5').schreiben).toBe(4)
  expect(preise('claude-fable-5-1').lesen).toBe(0.25)
  expect(neuaufbau(600_000, 'claude-opus-5-5')).toEqual({ dollar: 4.8, schritte: 40 })
  expect(dollar(4.8)).toBe('4,80')
  expect(dollar(23.4)).toBe('23')
  expect(schaetzeKontext(360_000)).toBe(170_000)
})

test('Nur Prompts der Person werden geprüft', () => {
  expect(vonPerson({ kind: 'composer' })).toBe(true)
  expect(vonPerson({ kind: 'bridge' })).toBe(true)
  expect(vonPerson({ kind: 'task-notification' })).toBe(false)
  expect(vonPerson({ kind: 'plugin', name: 'x' })).toBe(false)
  expect(vonPerson({ kind: 'plugin', name: 'x', asUser: true })).toBe(true)
})

test('Kalter Cache + großer Kontext: „Frische Sitzung“ hält den Prompt zurück und legt ihn nach /clear wieder hin', async ($, on) => {
  const s = stubs(on, { kontext: 600_000, antwortVorMin: 90, wahl: 'Frische Sitzung (/clear)' })
  await $.session.start(START)
  const r: any = await $.prompt.submit({ text: 'Mach mit dem Export weiter', asUser: true } as any)
  expect(s.fragen.length).toBe(1)
  expect(s.fragen[0]).toContain('Kontext 600k')
  expect(s.fragen[0]).toContain('4,80 $')
  expect(String(r.drop)).toContain('Tippe /clear')
  expect(s.gesendet).toEqual([])
  await ($ as any).classic.SessionStart({ source: 'clear' })
  expect(s.gefuellt).toEqual(['Mach mit dem Export weiter'])
})

test('„Hier weiter“ sendet normal', async ($, on) => {
  const s = stubs(on, { kontext: 600_000, antwortVorMin: 90, wahl: 'Hier weiter' })
  await $.session.start(START)
  const r: any = await $.prompt.submit({ text: 'weiter', asUser: true } as any)
  expect(r.drop).toBeUndefined()
  expect(s.gesendet).toEqual(['weiter'])
})

test('Warmer Cache oder kleiner Kontext: keine Rückfrage', async ($, on) => {
  const s = stubs(on, { kontext: 600_000, antwortVorMin: 20 })
  await $.session.start(START)
  await $.prompt.submit({ text: 'weiter', asUser: true } as any)
  expect(s.fragen.length).toBe(0)
})

test('Kleiner Kontext trotz kaltem Cache: keine Rückfrage', async ($, on) => {
  const s = stubs(on, { kontext: 90_000, antwortVorMin: 300 })
  await $.session.start(START)
  await $.prompt.submit({ text: 'weiter', asUser: true } as any)
  expect(s.fragen.length).toBe(0)
  expect(s.gesendet).toEqual(['weiter'])
})

test('Frisch fortgesetzte Sitzung ohne bekannte Antwortzeit gilt als kalt', async ($, on) => {
  const s = stubs(on, { kontext: 400_000, antwortVorMin: null, wahl: 'Hier weiter' })
  await $.session.start(START)
  await $.prompt.submit({ text: 'weiter', asUser: true } as any)
  expect(s.fragen.length).toBe(1)
})

const aufruf = (teil: Partial<AgentSpawnInput>): AgentSpawnInput => ({
  tool_use_id: 'toolu_test',
  prompt: 'x',
  description: 'Aufgabe',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...teil,
})

test('Modellwahl-Pflicht: general-purpose ohne Modell wird abgelehnt, mit Modell, Fork und Plugin-Agent laufen', async ($, on) => {
  const gestartet: Array<string | undefined> = []
  on('agent.spawn', (_$: any, e: any) => {
    gestartet.push(e.model)
    return { model: e.model ?? 'claude-opus-5-5', agentId: `a${gestartet.length}` }
  })
  const ohne: any = await $.agent.spawn(aufruf({}))
  expect(String(ohne.deny)).toContain('Bitte `model` setzen')
  await $.agent.spawn(aufruf({ model: 'sonnet' }))
  await $.agent.spawn(aufruf({ fork: true }))
  await $.agent.spawn(aufruf({ subagentType: 'pr-review-toolkit:code-reviewer' }))
  expect(gestartet).toEqual(['sonnet', undefined, undefined])
})
