import { expect, mock, test } from 'claude-code/testing'

import { FERTIG_MS, TOT_MS, andereText, aufgabeAus, istLebendig, lage } from '../hooks/register'
import type { SitzungsStand } from '../types'

const JETZT = 1_800_000_000_000
const MIN = 60_000

const sitzung = (id: string, teil: Partial<SitzungsStand> = {}): SitzungsStand => ({
  id, ort: id, aufgabe: '', modell: 'claude-opus-5-5', arbeitet: false, seit: JETZT, kontext: 40,
  letzteAntwort: null, agents: [], agentTokens: 0, limits: [], herz: JETZT, ...teil,
})

test('Lage: arbeitet, fertig (≤ 15 min), wartet', () => {
  expect(lage(sitzung('a', { arbeitet: true }), JETZT)).toBe('arbeitet')
  expect(lage(sitzung('b', { seit: JETZT - 3 * MIN }), JETZT)).toBe('fertig')
  expect(lage(sitzung('c', { seit: JETZT - FERTIG_MS - MIN }), JETZT)).toBe('wartet')
})

test('Tote Sitzungen (kein Herzschlag) fallen raus', () => {
  expect(istLebendig(sitzung('a'), JETZT)).toBe(true)
  expect(istLebendig(sitzung('a', { herz: JETZT - TOT_MS - 1 }), JETZT)).toBe(false)
  expect(istLebendig(undefined, JETZT)).toBe(false)
})

test('Band-Text fasst die anderen Sitzungen zusammen', () => {
  expect(andereText([], JETZT)).toBeNull()
  expect(andereText([sitzung('alt', { seit: JETZT - 60 * MIN })], JETZT)).toBeNull()
  const text = andereText([
    sitzung('webshop', { arbeitet: true, agents: [{ modell: 'haiku', beschreibung: 'Suche', gestartet: JETZT, tools: 3 }] }),
    sitzung('backend', { seit: JETZT - 4 * MIN }),
    sitzung('brain', { seit: JETZT - 9 * MIN }),
  ], JETZT)
  expect(text).toBe('1 arbeitet (1 Agents) · 2 fertig: backend vor 4:00 +1')
})

test('Aufgabe = erste Zeile, gekürzt', () => {
  expect(aufgabeAus('  Fix den Login\nmit Details')).toBe('Fix den Login')
  expect(aufgabeAus('x'.repeat(80)).length).toBe(60)
})

test('Band zeigt andere Sitzungen aus dem gemeinsamen Speicher', async ($, on) => {
  const store = new Map<string, unknown>([['radar:andere', sitzung('andere', { ort: 'webshop', arbeitet: true })]])
  mock.clock(on, { now: JETZT })
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', () => ({ cwd: '/work/brain' }))
  on('session.id', () => ({ value: 'eigene' }))
  on('session.cwd', () => ({ value: '/work/brain' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: JETZT, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }) as any)
  on('agent.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/brain' } as any)

  const eigen: any = store.get('radar:eigene')
  expect(eigen.ort).toBe('brain')
  expect(eigen.kontext).toBe(50_000)

  const ui = await $.ui.mount({
    plugin: 'agent-radar', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 110, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as any)
  expect(await ui.find({ type: 'Text', text: '1 arbeitet' })).toBeDefined()
  expect(await ui.find({ key: 'radar-zeigen' })).toBeDefined()
  await ui.unmount()
})

test('Befehl heißt /radar; wird die Registrierung abgelehnt, läuft der Start trotzdem weiter', async ($, on) => {
  const store = new Map<string, unknown>()
  const registriert: string[] = []
  mock.clock(on, { now: JETZT })
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', () => ({ cwd: '/work/app' }))
  on('session.id', () => ({ value: 'eigene' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: JETZT, context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }) as any)
  on('command.register', (_$: any, e: any) => { registriert.push(e.name); return { deny: 'refused: it is a built-in' } as any })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
  expect(registriert).toEqual(['radar'])
  expect(store.has('radar:eigene')).toBe(true)
})
