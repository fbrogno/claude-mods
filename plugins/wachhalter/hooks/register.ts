import type { EngineInterface, Register } from 'claude-code'

/** Wie bisher per Hand: Display, Leerlauf, Platte und System wach halten (caffeinate -dims). */
const FLAGS = '-dims'
const MAX_STUNDEN = 24

// ---- reine Logik (getestet) ---------------------------------------------------------------------

export type Auftrag = { art: 'an'; sekunden: number } | { art: 'aus' } | { art: 'stand' } | { art: 'fehler'; text: string }

/** „1“, „1h“, „1,5 std“, „90m“, „30 min“, „aus“, „“ → Auftrag. Zahl ohne Einheit = Stunden. */
export function auftragAus(args: string): Auftrag {
  const a = args.trim().toLowerCase()
  if (a === '' || a === 'stand' || a === 'status') return { art: 'stand' }
  if (['aus', 'stop', 'stopp', 'ende', 'off'].includes(a)) return { art: 'aus' }
  const m = a.match(/^(\d+(?:[.,]\d+)?)\s*(h|std|stunden?|m|min|minuten?)?$/)
  if (!m) return { art: 'fehler', text: `„${args.trim()}“ verstehe ich nicht. Beispiele: /wach 1 · /wach 30m · /wach aus` }
  const zahl = Number(m[1]!.replace(',', '.'))
  const minuten = m[2] && m[2].startsWith('m') ? zahl : zahl * 60
  const sekunden = Math.round(minuten * 60)
  if (sekunden < 60) return { art: 'fehler', text: 'Mindestens 1 Minute.' }
  if (sekunden > MAX_STUNDEN * 3600) return { art: 'fehler', text: `Höchstens ${MAX_STUNDEN} Stunden.` }
  return { art: 'an', sekunden }
}

export function dauerText(sekunden: number): string {
  const min = Math.round(sekunden / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

// ---- Engine ---------------------------------------------------------------------------------------

async function sh($: EngineInterface, befehl: string) {
  return $.process.run(['/bin/sh', '-c', befehl], { timeoutMs: 5000 })
}

/** Endzeit als Uhrzeit des Macs (date rechnet in der lokalen Zeitzone). */
async function uhrzeitIn($: EngineInterface, sekunden: number): Promise<string> {
  const r = await sh($, `date -v+${Math.round(sekunden)}S +%H:%M`)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

/** Läuft caffeinate noch? Dann: verbleibende Sekunden laut gemerkter Endzeit (oder -1, wenn unbekannt). */
async function restSekunden($: EngineInterface): Promise<number | null> {
  const laeuft = (await sh($, 'pgrep -x caffeinate >/dev/null && echo ja || echo nein')).stdout.trim() === 'ja'
  if (!laeuft) return null
  const bis = await $.store.get('bis')
  if (typeof bis !== 'number') return -1
  return Math.max(0, Math.round((bis - (await $.clock.now())) / 1000))
}

async function statusZeigen($: EngineInterface) {
  const rest = await restSekunden($)
  if (rest === null || rest === 0) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(rest > 0 ? `☕ wach noch ${dauerText(rest)}` : '☕ wach')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'wach',
      description: 'Mac wach halten (caffeinate), ohne Tokens: /wach 1 · /wach 30m · /wach aus · /wach',
      argumentHint: '[Stunden | 30m | aus]',
      immediate: true,
    })
    await statusZeigen($)
    $.clock.every(60_000, () => statusZeigen($))
    return r
  })

  on('command.run', { command: 'wach' }, async ($, e) => {
    const auftrag = auftragAus(e.args)
    if (auftrag.art === 'fehler') return { text: auftrag.text }

    if (auftrag.art === 'aus') {
      await sh($, 'pkill -x caffeinate; true')
      await $.store.delete('bis')
      $.ui.status(undefined)
      return { text: 'Wachhalten beendet — der Mac darf wieder schlafen.' }
    }

    if (auftrag.art === 'stand') {
      const rest = await restSekunden($)
      if (rest === null) return { text: 'Wachhalten ist aus. Starten: /wach 1 (Stunde) oder /wach 30m' }
      if (rest < 0) return { text: 'caffeinate läuft (Dauer unbekannt). Beenden: /wach aus' }
      return { text: `Wach noch ${dauerText(rest)} (bis ${await uhrzeitIn($, rest)}). Beenden: /wach aus` }
    }

    const start = await sh($, `pkill -x caffeinate; nohup caffeinate ${FLAGS} -t ${auftrag.sekunden} >/dev/null 2>&1 & sleep 0.3; pgrep -x caffeinate >/dev/null && echo ok`)
    if (start.stdout.trim() !== 'ok') return { text: 'caffeinate ließ sich nicht starten.' }
    await $.store.set('bis', (await $.clock.now()) + auftrag.sekunden * 1000)
    await statusZeigen($)
    return { text: `Mac bleibt ${dauerText(auftrag.sekunden)} wach (bis ${await uhrzeitIn($, auftrag.sekunden)}). Beenden: /wach aus` }
  })
}
