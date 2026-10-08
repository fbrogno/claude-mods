import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentStand, AgentZeile } from '../types'

const agents = atom({ plugin: 'agent-radar', key: 'agents' } as const, [])
/** Zeitpunkt der letzten Antwort im Hauptgespräch — ab da läuft der Prompt-Cache ab. */
const letzteAntwort = atom({ plugin: 'agent-radar', key: 'letzteAntwort' } as const, null)
/** Uhr für die Anzeige; der Takt schreibt sie, damit Band und Bereich neu zeichnen. */
const jetzt = atom({ plugin: 'agent-radar', key: 'jetzt' } as const, 0)

const BEREICH = 'agent-radar'
const TAKT_MS = 15_000

// ---- reine Logik (getestet) ---------------------------------------------------------------------

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

/** Kurzname des Modells: claude-haiku-4-5-… → haiku. */
export function modellKurz(modell: string): string {
  const treffer = modell.toLowerCase().match(/opus|sonnet|haiku|fable/)
  return treffer ? treffer[0] : modell
}

/** Restminuten des Prompt-Caches; null, solange es noch keine Antwort gab. */
export function cacheRest(letzte: number | null, jetztMs: number, minuten: number): number | null {
  if (letzte === null) return null
  return Math.ceil((letzte + minuten * 60_000 - jetztMs) / 60_000)
}

export function standAus(status: string): AgentStand | null {
  if (status === 'completed' || status === 'idle') return 'fertig'
  if (status === 'killed') return 'abgebrochen'
  if (status === 'failed') return 'fehler'
  return null
}

/** Tokens je Modell über alle Agents dieser Sitzung. */
export function summeJeModell(liste: AgentZeile[]): Array<{ modell: string; tokens: number; anzahl: number }> {
  const summe = new Map<string, { tokens: number; anzahl: number }>()
  for (const a of liste) {
    const k = modellKurz(a.modell)
    const alt = summe.get(k) ?? { tokens: 0, anzahl: 0 }
    summe.set(k, { tokens: alt.tokens + a.tokens, anzahl: alt.anzahl + 1 })
  }
  return [...summe].map(([modell, v]) => ({ modell, ...v })).sort((a, b) => b.tokens - a.tokens)
}

// ---- Engine ---------------------------------------------------------------------------------------

async function aendern($: EngineInterface, id: string, fn: (a: AgentZeile) => AgentZeile) {
  await update($, agents, liste => liste.map(a => (a.id === id ? fn(a) : a)))
}

/** Hintergrund-Agents, die ohne eigenes turn.complete enden (gestoppt, abgestürzt), nachziehen. */
async function abgleichen($: EngineInterface) {
  const offen = (await read($, agents)).filter(a => a.stand === 'läuft')
  if (offen.length === 0) return
  const status = new Map((await $.agent.list()).map(a => [a.id, a.status]))
  const now = await $.clock.now()
  for (const a of offen) {
    const s = status.get(a.id)
    const stand = s === undefined ? 'fertig' : standAus(s)
    if (stand) await aendern($, a.id, z => ({ ...z, stand, beendet: z.beendet ?? now }))
  }
}

export const register: Register = (on, options) => {
  const exploreAufHaiku = options.explore_auf_haiku !== false
  const cacheMinuten = Number(options.cache_minuten ?? 60) || 60
  const warnungAb = Number(options.cache_warnung_minuten ?? 10) || 10

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agents', description: 'Agent-Radar: was die Subagents dieser Sitzung tun und kosten' })
    await update($, jetzt, () => 0)
    $.clock.every(TAKT_MS, async () => {
      const now = await $.clock.now()
      await update($, jetzt, () => now)
      await abgleichen($)
    })
    return next(e)
  })

  on('command.run', { command: 'agents' }, async $ => {
    await $.ui.open({ id: BEREICH, title: 'Agent-Radar' })
    return { text: 'Agent-Radar geöffnet.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const mitHaiku = exploreAufHaiku && e.subagentType === 'Explore' && !e.model
    const r = await next(mitHaiku ? { ...e, model: 'haiku' } : e)
    if (r.deny !== undefined || !r.agentId) return r

    const zeile: AgentZeile = {
      id: r.agentId,
      beschreibung: e.description,
      typ: e.subagentType,
      modell: r.model,
      gestartet: await $.clock.now(),
      beendet: null,
      tools: 0,
      tokens: 0,
      stand: 'läuft',
    }
    await update($, agents, liste => [...liste.filter(a => a.id !== zeile.id), zeile].slice(-50))
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      await aendern($, id, a => ({ ...a, tools: a.tools + 1 }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId) {
      const u = e.usage
      const verbraucht = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      const stand: AgentStand = e.reason === 'aborted' ? 'abgebrochen' : e.reason === 'answer' ? 'fertig' : 'fehler'
      await aendern($, e.agentId, a => ({
        ...a,
        tokens: a.tokens + verbraucht,
        modell: u?.model ?? a.modell,
        stand,
        beendet: now,
      }))
    } else {
      await update($, letzteAntwort, () => now)
      await update($, jetzt, () => now)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const darunter = await next(e)
    if (e.props.hasSurvey) return darunter

    const liste = await read($, agents)
    const now = (await read($, jetzt)) || (await $.clock.now())
    const laufend = liste.filter(a => a.stand === 'läuft')
    const rest = cacheRest(await read($, letzteAntwort), now, cacheMinuten)
    const cacheZeigen = rest !== null && rest <= warnungAb

    if (laufend.length === 0 && !cacheZeigen) return darunter

    const { Box, Button, Text } = $.ui.resolve(e)
    const erster = laufend[0]
    const agentZeile = erster && (
      <Box key="radar-agents" gap={1}>
        <Text wrap="truncate-end">
          <Text color="cyan">Agents: </Text>
          <Text bold>{laufend.length} läuft{laufend.length === 1 ? '' : 'en'}</Text>
          <Text dimColor>
            {' '}· {modellKurz(erster.modell)} „{erster.beschreibung}“ {dauer(now - erster.gestartet)}, {erster.tools} Tools
            {laufend.length > 1 ? ` · +${laufend.length - 1} weitere` : ''}
          </Text>
        </Text>
        <Button key="radar-zeigen" label="Anzeigen" onPress={() => void $.ui.open({ id: BEREICH, title: 'Agent-Radar' })} />
      </Box>
    )
    const cacheZeile = cacheZeigen && (
      <Text key="radar-cache" color={rest! <= 0 ? 'red' : 'yellow'}>
        {rest! <= 0
          ? 'Cache kalt — der nächste Prompt lädt den ganzen Verlauf neu (teuer). Lange Pause? Erst /handoff, dann neue Sitzung.'
          : `Cache warm noch ${rest} min — danach kostet der nächste Prompt den ganzen Verlauf neu.`}
      </Text>
    )
    return (
      <Box flexDirection="column">
        {darunter}
        {agentZeile}
        {cacheZeile}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: BEREICH }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const liste = await read($, agents)
    const now = (await read($, jetzt)) || (await $.clock.now())
    const rest = cacheRest(await read($, letzteAntwort), now, cacheMinuten)

    if (liste.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Noch keine Subagents in dieser Sitzung.</Text>
          {rest !== null && <Text dimColor>Cache: {rest > 0 ? `warm noch ${rest} min` : 'kalt'}</Text>}
        </Box>
      )
    }

    const platz = Math.max(3, (e.viewport?.rows ?? 24) - 8)
    const farbe = (s: AgentStand) => (s === 'läuft' ? 'cyan' : s === 'fertig' ? 'green' : s === 'fehler' ? 'red' : 'yellow')
    return (
      <Box flexDirection="column">
        {liste.slice(-platz).reverse().map(a => (
          <Text key={`a-${a.id}`} wrap="truncate-end">
            <Text color={farbe(a.stand)}>{a.stand.padEnd(11)}</Text>
            <Text bold>{modellKurz(a.modell).padEnd(7)}</Text>
            <Text>{a.beschreibung}</Text>
            <Text dimColor>
              {' '}· {a.typ} · {dauer((a.beendet ?? now) - a.gestartet)} · {a.tools} Tools{a.tokens ? ` · ${tokens(a.tokens)} Tokens` : ''}
            </Text>
          </Text>
        ))}
        <Text key="summe-titel" bold>Summe je Modell</Text>
        {summeJeModell(liste).map(s => (
          <Text key={`s-${s.modell}`} dimColor>
            {s.modell}: {s.anzahl} Agents · {tokens(s.tokens)} Tokens
          </Text>
        ))}
        {rest !== null && <Text key="cache" dimColor>Cache Hauptgespräch: {rest > 0 ? `warm noch ${rest} min` : 'kalt'}</Text>}
      </Box>
    )
  })
}
