import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentStand, AgentZeile, SitzungsStand } from '../types'

const agents = atom({ plugin: 'agent-radar', key: 'agents' } as const, [])
/** Zeitpunkt der letzten Antwort im Hauptgespräch — ab da läuft der Prompt-Cache ab. */
const letzteAntwort = atom({ plugin: 'agent-radar', key: 'letzteAntwort' } as const, null)
/** Uhr für die Anzeige; der Takt schreibt sie, damit Band und Bereich neu zeichnen. */
const jetzt = atom({ plugin: 'agent-radar', key: 'jetzt' } as const, 0)
/** Alle lebenden Sitzungen dieses Rechners (inkl. der eigenen), aus dem gemeinsamen Speicher. */
const sitzungen = atom({ plugin: 'agent-radar', key: 'sitzungen' } as const, [])
const eigeneId = atom({ plugin: 'agent-radar', key: 'eigeneId' } as const, '')

const BEREICH = 'agent-radar'
const TAKT_MS = 15_000
const PRAEFIX = 'radar:'
/** Ohne Herzschlag seit so langer Zeit gilt eine Sitzung als beendet (abgestürzt, Rechner zu). */
export const TOT_MS = 2 * 60_000
/** So lange gilt eine Sitzung nach ihrer letzten Antwort als „fertig, schau rein“. */
export const FERTIG_MS = 15 * 60_000

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

export function ordnerName(pfad: string): string {
  return pfad.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || pfad
}

/** Erste Zeile des Prompts, gekürzt — als Hinweis, woran eine Sitzung arbeitet. */
export function aufgabeAus(text: string): string {
  const zeile = text.trim().split('\n')[0] ?? ''
  return zeile.length > 60 ? `${zeile.slice(0, 59)}…` : zeile
}

export function istLebendig(s: SitzungsStand | null | undefined, jetztMs: number): boolean {
  return !!s && typeof s.herz === 'number' && jetztMs - s.herz <= TOT_MS
}

export type Lage = 'arbeitet' | 'fertig' | 'wartet'

/** arbeitet = Turn läuft; fertig = in den letzten 15 min geantwortet; wartet = länger still. */
export function lage(s: SitzungsStand, jetztMs: number): Lage {
  if (s.arbeitet) return 'arbeitet'
  return jetztMs - s.seit <= FERTIG_MS ? 'fertig' : 'wartet'
}

/** Eine Zeile Überblick über die ANDEREN Sitzungen für das Band; null, wenn es nichts zu sagen gibt. */
export function andereText(andere: SitzungsStand[], jetztMs: number): string | null {
  if (andere.length === 0) return null
  const arbeiten = andere.filter(s => lage(s, jetztMs) === 'arbeitet')
  const fertig = andere.filter(s => lage(s, jetztMs) === 'fertig').sort((a, b) => b.seit - a.seit)
  const agentsAnzahl = andere.reduce((n, s) => n + s.agents.length, 0)
  const teile: string[] = []
  if (arbeiten.length) teile.push(`${arbeiten.length} ${arbeiten.length === 1 ? 'arbeitet' : 'arbeiten'}${agentsAnzahl ? ` (${agentsAnzahl} Agents)` : ''}`)
  if (fertig.length) {
    const f = fertig[0]!
    teile.push(`${fertig.length} fertig: ${f.ort} vor ${dauer(jetztMs - f.seit)}${fertig.length > 1 ? ` +${fertig.length - 1}` : ''}`)
  }
  return teile.length ? teile.join(' · ') : null
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

// Eigener Stand dieser Sitzung (geht beim Neuladen verloren; der Takt schreibt ihn sofort neu).
let arbeitet = false
let seit = 0
let aufgabe = ''

/** Eigenen Stand in den gemeinsamen Speicher schreiben und alle Sitzungen neu einlesen. */
async function melden($: EngineInterface) {
  const now = await $.clock.now()
  const id = await $.session.id()
  const alteId = await read($, eigeneId)
  if (alteId && alteId !== id) await $.store.delete(PRAEFIX + alteId) // nach /clear: neue Sitzungs-ID
  await update($, eigeneId, () => id)

  const liste = await read($, agents)
  const usage = await $.session.usage()
  const eigen: SitzungsStand = {
    id,
    ort: ordnerName(await $.session.cwd()),
    aufgabe,
    modell: await $.session.model(),
    arbeitet,
    seit: seit || now,
    kontext: usage.context.percent ?? (usage.context.tokens ? Math.round((usage.context.tokens / usage.context.window) * 100) : null),
    letzteAntwort: await read($, letzteAntwort),
    agents: liste.filter(a => a.stand === 'läuft').map(a => ({ modell: a.modell, beschreibung: a.beschreibung, gestartet: a.gestartet, tools: a.tools })),
    agentTokens: liste.reduce((n, a) => n + a.tokens, 0),
    limits: usage.rateLimits.map(r => ({ art: r.kind, prozent: Math.round(r.percentUsed) })),
    herz: now,
  }
  await $.store.set(PRAEFIX + id, eigen)

  const alle: SitzungsStand[] = []
  for (const schluessel of await $.store.keys()) {
    if (!schluessel.startsWith(PRAEFIX)) continue
    const s = (await $.store.get(schluessel)) as SitzungsStand | undefined
    if (s && istLebendig(s, now)) alle.push(s)
    else if (!s || typeof s.herz !== 'number' || now - s.herz > 30 * 60_000) await $.store.delete(schluessel) // Verwaistes wegräumen
  }
  await update($, sitzungen, () => alle.sort((a, b) => a.ort.localeCompare(b.ort)))
  await update($, jetzt, () => now)
}

async function meldenStill($: EngineInterface) {
  try {
    await melden($)
  } catch (fehler) {
    $.ui.log(`agent-radar: ${String((fehler as Error)?.message ?? fehler).slice(0, 200)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  const exploreAufHaiku = options.explore_auf_haiku !== false
  const cacheMinuten = Number(options.cache_minuten ?? 60) || 60
  const warnungAb = Number(options.cache_warnung_minuten ?? 10) || 10

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'agents', description: 'Agent-Radar: alle Sitzungen und Subagents auf diesem Rechner' })
    seit = await $.clock.now()
    await meldenStill($)
    $.clock.every(TAKT_MS, async () => {
      await abgleichen($)
      await meldenStill($)
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    try {
      await $.store.delete(PRAEFIX + (await $.session.id()))
    } catch {
      // beim Beenden nie stören
    }
    return next(e)
  })

  on('command.run', { command: 'agents' }, async $ => {
    await meldenStill($)
    await $.ui.open({ id: BEREICH, title: 'Agent-Radar' })
    return { text: 'Agent-Radar geöffnet.' }
  })

  on('prompt.submit', async ($, e, next) => {
    arbeitet = true
    seit = await $.clock.now()
    if (e.text.trim() && !e.text.trim().startsWith('/')) aufgabe = aufgabeAus(e.text)
    void meldenStill($)
    return next(e)
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
    void meldenStill($)
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
      arbeitet = false
      seit = now
      await update($, letzteAntwort, () => now)
    }
    void meldenStill($)
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
    const id = await read($, eigeneId)
    const andere = andereText((await read($, sitzungen)).filter(s => s.id !== id), now)

    if (laufend.length === 0 && !cacheZeigen && !andere) return darunter

    const { Box, Button, Text } = $.ui.resolve(e)
    const zeigen = () => void $.ui.open({ id: BEREICH, title: 'Agent-Radar' })
    const erster = laufend[0]
    const agentZeile = erster && (
      <Text key="radar-agents" wrap="truncate-end">
        <Text color="cyan">Agents: </Text>
        <Text bold>{laufend.length} läuft{laufend.length === 1 ? '' : 'en'}</Text>
        <Text dimColor>
          {' '}· {modellKurz(erster.modell)} „{erster.beschreibung}“ {dauer(now - erster.gestartet)}, {erster.tools} Tools
          {laufend.length > 1 ? ` · +${laufend.length - 1} weitere` : ''}
        </Text>
      </Text>
    )
    const andereZeile = andere && (
      <Text key="radar-andere" wrap="truncate-end">
        <Text color="cyan">Sitzungen: </Text>
        <Text>{andere}</Text>
      </Text>
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
        {(agentZeile || andereZeile) && (
          <Box key="radar-zeile" gap={1}>
            <Box flexDirection="column">
              {agentZeile}
              {andereZeile}
            </Box>
            <Button key="radar-zeigen" label="Anzeigen" onPress={zeigen} />
          </Box>
        )}
        {cacheZeile}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: BEREICH }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const liste = await read($, agents)
    const now = (await read($, jetzt)) || (await $.clock.now())
    const id = await read($, eigeneId)
    const alle = await read($, sitzungen)
    const eigen = alle.find(s => s.id === id)
    const andere = alle.filter(s => s.id !== id)
    const farbeLage = (l: Lage) => (l === 'arbeitet' ? 'cyan' : l === 'fertig' ? 'green' : 'gray')
    const farbeStand = (s: AgentStand) => (s === 'läuft' ? 'cyan' : s === 'fertig' ? 'green' : s === 'fehler' ? 'red' : 'yellow')

    const sitzungsZeilen = (s: SitzungsStand, istEigen: boolean) => {
      const l = lage(s, now)
      const rest = cacheRest(s.letzteAntwort, now, cacheMinuten)
      return (
        <Box key={`s-${s.id}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={farbeLage(l)}>{(l === 'arbeitet' ? '● arbeitet ' : l === 'fertig' ? '✓ fertig   ' : '○ wartet   ')}</Text>
            <Text bold>{s.ort}</Text>
            {istEigen && <Text dimColor> (diese)</Text>}
            <Text dimColor>
              {' '}· {modellKurz(s.modell)} · {l === 'arbeitet' ? `seit ${dauer(now - s.seit)}` : `vor ${dauer(now - s.seit)}`}
              {s.kontext !== null ? ` · Kontext ${s.kontext} %` : ''}
              {rest !== null ? ` · Cache ${rest > 0 ? `${rest} min` : 'kalt'}` : ''}
              {s.agentTokens ? ` · Agents ${tokens(s.agentTokens)} Tokens` : ''}
            </Text>
          </Text>
          {s.aufgabe && <Text dimColor wrap="truncate-end">{'    '}„{s.aufgabe}“</Text>}
          {s.agents.map((a, i) => (
            <Text key={`s-${s.id}-a-${i}`} wrap="truncate-end">
              <Text color="cyan">{'    ↳ '}{modellKurz(a.modell).padEnd(7)}</Text>
              <Text>{a.beschreibung}</Text>
              <Text dimColor> · {dauer(now - a.gestartet)} · {a.tools} Tools</Text>
            </Text>
          ))}
        </Box>
      )
    }

    const limits = eigen?.limits ?? []
    return (
      <Box flexDirection="column">
        <Text key="t-sitzungen" bold>Sitzungen auf diesem Rechner ({alle.length})</Text>
        {eigen && sitzungsZeilen(eigen, true)}
        {andere.map(s => sitzungsZeilen(s, false))}
        {limits.length > 0 && (
          <Text key="limits" dimColor>Limits: {limits.map(l => `${l.art} ${l.prozent} %`).join(' · ')}</Text>
        )}
        <Text key="t-agents" bold>Agents dieser Sitzung ({liste.length})</Text>
        {liste.length === 0 && <Text key="keine" dimColor>Noch keine Subagents.</Text>}
        {liste.slice(-12).reverse().map(a => (
          <Text key={`a-${a.id}`} wrap="truncate-end">
            <Text color={farbeStand(a.stand)}>{a.stand.padEnd(11)}</Text>
            <Text bold>{modellKurz(a.modell).padEnd(7)}</Text>
            <Text>{a.beschreibung}</Text>
            <Text dimColor>
              {' '}· {a.typ} · {dauer((a.beendet ?? now) - a.gestartet)} · {a.tools} Tools{a.tokens ? ` · ${tokens(a.tokens)} Tokens` : ''}
            </Text>
          </Text>
        ))}
        {liste.length > 0 && <Text key="summe-titel" bold>Summe je Modell</Text>}
        {summeJeModell(liste).map(s => (
          <Text key={`sum-${s.modell}`} dimColor>
            {s.modell}: {s.anzahl} Agents · {tokens(s.tokens)} Tokens
          </Text>
        ))}
      </Box>
    )
  })
}
