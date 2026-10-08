import { expect, test } from 'claude-code/testing'

import { cacheRest, dauer, modellKurz, standAus, summeJeModell, tokens } from '../hooks/register'
import type { AgentZeile } from '../types'

const zeile = (id: string, modell: string, t: number): AgentZeile => ({
  id, beschreibung: id, typ: 'Explore', modell, gestartet: 0, beendet: null, tools: 0, tokens: t, stand: 'fertig',
})

test('Dauer und Tokens lesbar', () => {
  expect(dauer(4_400)).toBe('4s')
  expect(dauer(83_000)).toBe('1:23')
  expect(dauer(3_720_000)).toBe('1h02')
  expect(tokens(950)).toBe('950')
  expect(tokens(4_520)).toBe('4.5k')
  expect(tokens(48_200)).toBe('48k')
  expect(tokens(2_300_000)).toBe('2.3M')
})

test('Modellname wird gekürzt', () => {
  expect(modellKurz('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(modellKurz('claude-opus-5-5')).toBe('opus')
  expect(modellKurz('eigenes-modell')).toBe('eigenes-modell')
})

test('Cache-Restzeit ab der letzten Antwort', () => {
  expect(cacheRest(null, 1_000, 60)).toBeNull()
  expect(cacheRest(0, 50 * 60_000, 60)).toBe(10)
  expect(cacheRest(0, 61 * 60_000, 60)).toBeLessThanOrEqual(0)
})

test('Agent-Status wird übersetzt, laufende bleiben offen', () => {
  expect(standAus('completed')).toBe('fertig')
  expect(standAus('killed')).toBe('abgebrochen')
  expect(standAus('failed')).toBe('fehler')
  expect(standAus('running')).toBeNull()
})

test('Summe je Modell, teuerstes zuerst', () => {
  const s = summeJeModell([zeile('a', 'claude-haiku-4-5', 1000), zeile('b', 'claude-opus-5-5', 9000), zeile('c', 'haiku', 500)])
  expect(s).toEqual([
    { modell: 'opus', tokens: 9000, anzahl: 1 },
    { modell: 'haiku', tokens: 1500, anzahl: 2 },
  ])
})
