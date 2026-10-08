import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { AgentStand, AgentZeile, SitzungsStand } from '../types'

const agents = atom({ plugin: 'agent-radar', key: 'agents' } as const, [])
/** Zeitpunkt der letzten Antwort im Hauptgespräch — ab da läuft der Prompt-Cache ab. */
const letzteAntwort = atom({ plugin: 'agent-radar', key: 'letzteAntwort' } as const, null)
/** Uhr für die Anzeige; der Takt schreibt sie, damit Band und Bereich neu zeichnen. */
const jetzt = atom({ plugin: 'agent-radar', key: 'jetzt' } as const, 0)
/** Alle lebenden Sitzungen dieses Rechners (inkl. der eigenen), aus dem gemeinsamen Speicher. */
const sitzungen = atom({ plugin: 'agent-radar', key: 'sitzungen' } as const, [])
const eigeneId = atom({ plugin: 'agent-radar', key: 'eigeneId' } as const, '')
/** Kontextgröße des Hauptgesprächs in Tokens, zuletzt gemessen. */
const kontextTokens = atom({ plugin: 'agent-radar', key: 'kontextTokens' } as const, null)

const BEREICH = 'agent-radar'
export const BEFEHL = 'radar'
const TAKT_MS = 15_000
const PRAEFIX = 'radar:'
/** Zeitpunkt der letzten Antwort je Sitzung — überdauert Neustarts, damit /resume den kalten Cache erkennt. */
const ANTWORT = 'antwort:'
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

/**
 * API-Listenpreise in $ je Mio. Tokens (Stand 25.09.2026): Cache lesen und Cache schreiben mit 1 h Gültigkeit.
 * Bei einem Abo ist das ein Maß für den Limit-Verbrauch, kein Rechnungsbetrag.
 */
const PREISE: Array<[RegExp, { lesen: number; schreiben: number }]> = [
  [/opus-5-5/, { lesen: 0.2, schreiben: 8 }],
  [/opus/, { lesen: 0.5, schreiben: 10 }],
  [/fable-5-1|mythos-5-1/, { lesen: 0.25, schreiben: 20 }],
  [/fable|mythos/, { lesen: 1, schreiben: 20 }],
  [/sonnet/, { lesen: 0.2, schreiben: 4 }],
  [/haiku/, { lesen: 0.1, schreiben: 2 }],
]

export function preise(modell: string): { lesen: number; schreiben: number } {
  const m = modell.toLowerCase()
  return PREISE.find(([muster]) => muster.test(m))?.[1] ?? { lesen: 0.2, schreiben: 8 }
}

/** Was der Neuaufbau eines kalten Caches kostet ($) und wie viele normale Schritte das entspricht. */
export function neuaufbau(kontext: number, modell: string): { dollar: number; schritte: number } {
  const p = preise(modell)
  return { dollar: (kontext / 1e6) * p.schreiben, schritte: Math.round(p.schreiben / p.lesen) }
}

export function dollar(betrag: number): string {
  return betrag < 10 ? betrag.toFixed(2).replace('.', ',') : String(Math.round(betrag))
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

/** Prompts, die die Person selbst geschickt hat (getippt, per Fernsteuerung oder von einem Plugin in ihrem Namen). */
export function vonPerson(origin: PromptOrigin | undefined): boolean {
  if (!origin) return true
  if (origin.kind === 'composer' || origin.kind === 'bridge') return true
  return origin.kind === 'plugin' && origin.asUser === true
}

/** Grobe Kontextschätzung aus dem Verlauf, solange nach /resume noch keine Messung da ist (~3,6 Zeichen je Token). */
export function schaetzeKontext(zeichen: number, basis = 70_000): number {
  return Math.round(basis + zeichen / 3.6)
}

export const MODELL_HINWEIS =
  'agent-radar: Bitte `model` setzen — haiku (suchen, sichten, prüfen), sonnet (umsetzen nach klarem Plan, Tests, Doku), ' +
  'opus (Architektur, unklare Fehler, Reviews, Sicherheit). Dann den Agent mit Modell erneut starten.'

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
/** Prompt, der für eine frische Sitzung zurückgehalten wurde; nach /clear kommt er ins Eingabefeld zurück. */
let wartenderPrompt: string | null = null

async function kontextMessen($: EngineInterface): Promise<number | null> {
  const { context } = await $.session.usage()
  const t = context.tokens ?? (context.percent !== undefined ? Math.round((context.percent / 100) * context.window) : null)
  await update($, kontextTokens, () => t)
  return t
}

/** Eigenen Stand in den gemeinsamen Speicher schreiben und alle Sitzungen neu einlesen. */
async function melden($: EngineInterface) {
  const now = await $.clock.now()
  const id = await $.session.id()
  const alteId = await read($, eigeneId)
  if (alteId && alteId !== id) await $.store.delete(PRAEFIX + alteId) // nach /clear: neue Sitzungs-ID
  await update($, eigeneId, () => id)

  const liste = await read($, agents)
  const usage = await $.session.usage()
  const ktx = await kontextMessen($)
  const eigen: SitzungsStand = {
    id,
    ort: ordnerName(await $.session.cwd()),
    aufgabe,
    modell: await $.session.model(),
    arbeitet,
    seit: seit || now,
    kontext: ktx,
    letzteAntwort: await read($, letzteAntwort),
    agents: liste.filter(a => a.stand === 'läuft').map(a => ({ modell: a.modell, beschreibung: a.beschreibung, gestartet: a.gestartet, tools: a.tools })),
    agentTokens: liste.reduce((n, a) => n + a.tokens, 0),
    limits: usage.rateLimits.map(r => ({ art: r.kind, prozent: Math.round(r.percentUsed) })),
    herz: now,
  }
  await $.store.set(PRAEFIX + id, eigen)

  const alle: SitzungsStand[] = []
  for (const schluessel of await $.store.keys()) {
    if (schluessel.startsWith(ANTWORT)) {
      const z = await $.store.get(schluessel)
      if (typeof z !== 'number' || now - z > 3 * 86_400_000) await $.store.delete(schluessel)
      continue
    }
    if (!schluessel.startsWith(PRAEFIX)) continue
    const s = (await $.store.get(schluessel)) as SitzungsStand | undefined
    if (s && istLebendig(s, now)) alle.push(s)
    else if (!s || typeof s.herz !== 'number' || now - s.herz > 30 * 60_000) await $.store.delete(schluessel) // Verwaistes wegräumen
  }
  await update($, sitzungen, () => alle.sort((a, b) => a.ort.localeCompare(b.ort)))
  await update($, jetzt, () => now)
}

/** Nie werfen: läuft oft unabgewartet nebenher (auch, wenn das Modul gerade entladen wird). */
async function meldenStill($: EngineInterface) {
  try {
    await melden($)
  } catch (fehler) {
    try {
      $.ui.log(`agent-radar: ${String((fehler as Error)?.message ?? fehler).slice(0, 200)}`, { to: 'debug' })
    } catch {
      // Umgebung schon entladen
    }
  }
}

/** Kontext für die Kaltstart-Prüfung: Messung, sonst (frisch nach /resume) Schätzung aus dem Verlauf. */
async function kontextFuerPruefung($: EngineInterface): Promise<number> {
  const gemessen = await kontextMessen($)
  if (gemessen !== null) return gemessen
  const zeilen = await $.session.messages()
  if (zeilen.length === 0) return 0
  const zeichen = zeilen.reduce((n, z) => n + z.text.length + (z.toolResults ?? []).reduce((m, r) => m + r.text.length, 0), 0)
  return schaetzeKontext(zeichen)
}

async function standSichern($: EngineInterface) {
  try {
    await $.command.run({ command: 'handoff', args: '' })
  } catch {
    $.ui.toast('Stand sichern ging nicht — bitte /handoff eintippen.')
  }
}

export const register: Register = (on, options) => {
  const exploreAufHaiku = options.explore_auf_haiku !== false
  const cacheMinuten = Number(options.cache_minuten ?? 60) || 60
  const warnungAb = Number(options.cache_warnung_minuten ?? 10) || 10
  const kaltWaechter = options.kalt_waechter !== false
  const kaltSchwelle = (Number(options.kalt_schwelle_k ?? 200) || 200) * 1000
  const modellPflicht = options.modell_pflicht !== false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      // Nicht /agents: das ist ein eingebauter Befehl von Claude Code.
      await $.command.register({ name: BEFEHL, description: 'Agent-Radar: alle Sitzungen und Subagents auf diesem Rechner' })
    } catch (fehler) {
      $.ui.log(`agent-radar: /${BEFEHL} nicht registriert: ${String((fehler as Error)?.message ?? fehler).slice(0, 160)}`, { to: 'debug' })
    }
    seit = await $.clock.now()
    await meldenStill($)
    $.clock.every(TAKT_MS, async () => {
      await abgleichen($)
      await meldenStill($)
    })
    return r
  })

  // Nach /clear den zurückgehaltenen Prompt wieder ins Eingabefeld legen.
  on('classic.SessionStart', { source: 'clear' }, async ($, e, next) => {
    const r = await next(e)
    if (wartenderPrompt) {
      const text = wartenderPrompt
      wartenderPrompt = null
      await update($, letzteAntwort, () => null)
      await $.prompt.fill({ text })
    }
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

  on('command.run', { command: BEFEHL }, async $ => {
    await meldenStill($)
    await $.ui.open({ id: BEREICH, title: 'Agent-Radar' })
    return { text: 'Agent-Radar geöffnet.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    const pruefen = kaltWaechter && !e.turnId && vonPerson(e.origin) && text !== '' && !text.startsWith('/')
    if (pruefen) {
      try {
        const id = await $.session.id()
        const now = await $.clock.now()
        const gemerkt = await $.store.get(ANTWORT + id)
        const letzte = (await read($, letzteAntwort)) ?? (typeof gemerkt === 'number' ? gemerkt : null)
        const ktx = await kontextFuerPruefung($)
        // Unbekannte letzte Antwort mit Verlauf = frisch fortgesetzte Sitzung: Cache gilt als kalt.
        const kalt = letzte === null ? ktx > 70_000 : now - letzte > cacheMinuten * 60_000
        if (kalt && ktx >= kaltSchwelle) {
          const { dollar: d, schritte } = neuaufbau(ktx, await $.session.model())
          const frage = `Cache kalt · Kontext ${tokens(ktx)}: Dieser Prompt baut alles neu auf (≈ ${dollar(d)} $ API-Preis, so viel wie ~${schritte} normale Schritte). Trotzdem hier weiter?`
          let wahl = 'Abbrechen'
          try {
            wahl = await $.ui.ask(frage, ['Hier weiter', 'Frische Sitzung (/clear)'])
          } catch {
            wahl = 'Abbrechen'
          }
          if (wahl !== 'Hier weiter') {
            const frisch = wahl.startsWith('Frische')
            wartenderPrompt = frisch ? e.text : null
            if (!frisch) void $.clock.sleep(300).then(() => $.prompt.fill({ text: e.text })).catch(() => undefined)
            return {
              drop: frisch
                ? 'agent-radar: Nicht gesendet. Tippe /clear — danach steht dein Prompt wieder im Eingabefeld (der letzte /handoff-Stand wird beim Start geladen).'
                : 'agent-radar: Abgebrochen — dein Prompt steht wieder im Eingabefeld.',
            }
          }
        }
      } catch (fehler) {
        $.ui.log(`agent-radar Kaltstart-Prüfung: ${String((fehler as Error)?.message ?? fehler).slice(0, 200)}`, { to: 'debug' })
      }
    }

    arbeitet = true
    seit = await $.clock.now()
    if (text && !text.startsWith('/')) aufgabe = aufgabeAus(text)
    void meldenStill($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (modellPflicht && e.subagentType === 'general-purpose' && !e.model && !e.fork && !e.isTeammate) {
      return { deny: MODELL_HINWEIS }
    }
    let modell = e.model
    if (!modell && exploreAufHaiku && e.subagentType === 'Explore') modell = 'haiku'
    const r = await next(modell !== e.model ? { ...e, model: modell } : e)
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
      try {
        await $.store.set(ANTWORT + (await $.session.id()), now)
      } catch {
        // nur für die Kaltstart-Prüfung nach /resume
      }
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
    const ktx = (await read($, kontextTokens)) ?? 0
    // Nur wenn ein Neuaufbau wirklich ins Gewicht fällt (großer Kontext).
    const cacheZeigen = rest !== null && rest <= warnungAb && ktx >= kaltSchwelle * 0.75
    const id = await read($, eigeneId)
    const alleSitzungen = await read($, sitzungen)
    const andere = andereText(alleSitzungen.filter(s => s.id !== id), now)
    const hauptModell = alleSitzungen.find(s => s.id === id)?.modell ?? 'opus-5-5'

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
    const kosten = cacheZeigen ? dollar(neuaufbau(ktx, hauptModell).dollar) : ''
    const cacheZeile = cacheZeigen && (
      <Box key="radar-cache" gap={1}>
        <Text color={rest! <= 0 ? 'red' : 'yellow'} wrap="truncate-end">
          {rest! <= 0
            ? `Cache kalt · Kontext ${tokens(ktx)}: der nächste Prompt kostet ≈ ${kosten} $ Neuaufbau — eine frische Sitzung (/clear) ist günstiger.`
            : `Cache warm noch ${rest} min · Kontext ${tokens(ktx)}: nach einer Pause kostet der nächste Prompt ≈ ${kosten} $. Pause? Erst Stand sichern, dann /clear.`}
        </Text>
        {rest! > 0 && <Button key="radar-sichern" label="Stand sichern" onPress={() => void standSichern($).catch(() => undefined)} />}
      </Box>
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
            </Text>
            {s.kontext !== null && (
              <Text color={s.kontext >= kaltSchwelle * 1.5 ? 'red' : s.kontext >= kaltSchwelle ? 'yellow' : undefined} dimColor={s.kontext < kaltSchwelle}>
                {' '}· Kontext {tokens(s.kontext)}
              </Text>
            )}
            <Text dimColor>
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
