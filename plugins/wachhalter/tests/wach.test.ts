import { expect, mock, test } from 'claude-code/testing'

import { auftragAus, dauerText } from '../hooks/register'

test('Eingaben werden verstanden', () => {
  expect(auftragAus('')).toEqual({ art: 'stand' })
  expect(auftragAus('aus')).toEqual({ art: 'aus' })
  expect(auftragAus('1')).toEqual({ art: 'an', sekunden: 3600 })
  expect(auftragAus('1,5 std')).toEqual({ art: 'an', sekunden: 5400 })
  expect(auftragAus('2h')).toEqual({ art: 'an', sekunden: 7200 })
  expect(auftragAus('30m')).toEqual({ art: 'an', sekunden: 1800 })
  expect(auftragAus('90 min')).toEqual({ art: 'an', sekunden: 5400 })
  expect(auftragAus('morgen').art).toBe('fehler')
  expect(auftragAus('30 sekunden').art).toBe('fehler')
  expect(auftragAus('48').art).toBe('fehler')
})

test('Dauer lesbar', () => {
  expect(dauerText(1800)).toBe('30 min')
  expect(dauerText(3600)).toBe('1 h')
  expect(dauerText(5400)).toBe('1 h 30 min')
})

test('/wach 1 startet caffeinate -dims für eine Stunde, /wach aus beendet es', async ($, on) => {
  const befehle: string[] = []
  const store = new Map<string, unknown>()
  mock.clock(on, { now: 1_800_000_000_000 })
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('session.start', () => ({ cwd: '/work' }))
  on('process.run', (_$: any, e: any) => {
    const cmd = e.argv[2] as string
    befehle.push(cmd)
    const stdout = cmd.startsWith('date') ? '15:42\n' : cmd.includes('&& echo ok') ? 'ok\n' : cmd.includes('echo ja') ? 'nein\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  const an: any = await $.command.run({ command: 'wach', args: '1' } as any)
  expect(befehle.some(b => b.includes('nohup caffeinate -dims -t 3600'))).toBe(true)
  expect(an.text).toContain('1 h wach (bis 15:42)')
  expect(store.get('bis')).toBe(1_800_000_000_000 + 3_600_000)
  const aus: any = await $.command.run({ command: 'wach', args: 'aus' } as any)
  expect(befehle.some(b => b.startsWith('pkill -x caffeinate; true'))).toBe(true)
  expect(aus.text).toContain('beendet')
  expect(store.has('bis')).toBe(false)
})
