import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LeitstandAgent, LeitstandSitzung, LeitstandZiel } from '../types'
import { BREITE, alsText, hutFuer, maennchen, modellFarbe, zusatzFarbe } from './clawd'
import type { MannZustand } from './clawd'
import {
  ALT_MS,
  TOT_MS,
  agentsFuerDatei,
  aktuell,
  ausblendenListe,
  basename,
  brauchtSchreiben,
  cacheStand,
  dateiName,
  dauer,
  dollar,
  istVersteckt,
  kuerzen,
  leererEigenStand,
  modellKurz,
  pruefeSitzung,
  sichtbar,
  sortieren,
  summe,
  tokens,
  werkzeugName,
  zielAus,
  zustandVon,
} from './logik'

export { alsText }

const eigenA = atom({ plugin: 'leitstand', key: 'eigen' } as const, leererEigenStand())
const alleA = atom({ plugin: 'leitstand', key: 'alle' } as const, [])
const jetztA = atom({ plugin: 'leitstand', key: 'jetzt' } as const, 0)
const offenA = atom({ plugin: 'leitstand', key: 'offen' } as const, false)
const eingabeA = atom({ plugin: 'leitstand', key: 'eingabe' } as const, null)
const stoppA = atom({ plugin: 'leitstand', key: 'stoppBitte' } as const, null)
const meldungA = atom({ plugin: 'leitstand', key: 'meldung' } as const, '')

export const PANE = 'leitstand'
export const BEFEHL = 'leitstand'
export const ORDNER = '.claude-leitstand/sitzungen'
const TAKT_MS = 2000
const BILD_MS = 300
const STANDARD_AUSBLENDEN = ''
// Private Wörter stehen nicht im (öffentlichen) Code, sondern lokal in ~/.claude-leitstand/ausblenden.txt (Komma oder Zeile je Wort).
const AUSBLENDEN_DATEI = '.claude-leitstand/ausblenden.txt'
async function lokaleAusblendenListe($: EngineInterface): Promise<string[]> {
  try {
    const home = await $.env.get('HOME')
    const text = home ? await $.fs.read(`${home.replace(/\/$/, '')}/${AUSBLENDEN_DATEI}`) : ''
    return ausblendenListe(text.replace(/\n/g, ','))
  } catch {
    return []
  }
}

type Konfig = { ausblenden: string[] }

// Nur Zeitgeber und Zwischenspeicher leben im Modul (gehen beim Neuladen verloren und werden von den Hooks neu angelegt).
let taktTimer: { cancel: () => void } | null = null
let bildTimer: { cancel: () => void } | null = null
let zuletzt: { json: string; zeit: number } | null = null
let letzteId = ''
const gemerkt = new Map<string, LeitstandSitzung>()

// ---- Dateiablage -------------------------------------------------------------------------------

async function ordner($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home.replace(/\/$/, '')}/${ORDNER}` : null
}

async function profilName($: EngineInterface): Promise<string | undefined> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return basename(dir) || undefined
  const wurzel = String($.plugin.root)
  const treffer = wurzel.match(/\/(\.claude[^/]*)\//)
  return treffer ? treffer[1] : '.claude'
}

async function entfernen($: EngineInterface, pfade: string[]) {
  if (pfade.length === 0) return
  try {
    await $.process.run(['rm', '-f', ...pfade], { timeoutMs: 5000 })
  } catch {
    // dann bleibt die Datei liegen; der Leser blendet sie nach 3 min ohnehin aus
  }
}

/** Die eigene Sitzung als Datei-Inhalt; null, wenn privat (dann gibt es gar keine Datei). */
async function baueSitzung($: EngineInterface, cfg: Konfig, now: number): Promise<LeitstandSitzung | null> {
  const cwd = await $.session.cwd()
  if (istVersteckt(cwd, [...cfg.ausblenden, ...(await lokaleAusblendenListe($))])) return null
  let eigen = await read($, eigenA)
  if (!eigen.seit) {
    // Beginn der Sitzung einmal festhalten, sonst ändert sich der Herzschlag bei jedem Takt.
    await update($, eigenA, z => (z.seit ? z : { ...z, seit: now }))
    eigen = await read($, eigenA)
  }
  const usage = await $.session.usage().catch(() => undefined)
  const hauptWerkzeug = eigen.arbeitet ? aktuell(eigen.aufrufe, undefined) : null
  const prozent = usage?.context?.percent
  return {
    v: 1,
    sessionId: await $.session.id(),
    profil: await profilName($),
    projekt: kuerzen(basename(cwd) || cwd, 40),
    modell: modellKurz(await $.session.model()),
    kontextProzent: typeof prozent === 'number' ? Math.round(prozent) : null,
    letzteAntwort: eigen.letzteAntwort,
    kosten: typeof usage?.cost?.usd === 'number' ? Math.round(usage.cost.usd * 100) / 100 : null,
    zustand: zustandVon(eigen.arbeitet, eigen.seit || now, now),
    werkzeug: hauptWerkzeug ? werkzeugName(hauptWerkzeug.werkzeug) : null,
    ziel: hauptWerkzeug ? hauptWerkzeug.ziel : '',
    seit: eigen.seit || now,
    agents: agentsFuerDatei(eigen, now),
    herz: now,
  }
}

/** Herzschlag schreiben: nur bei Änderung (oder alle 30 s zur Lebenszeichen-Auffrischung). Wirft nie. */
async function herzschlag($: EngineInterface, cfg: Konfig): Promise<LeitstandSitzung | null> {
  try {
    const now = await $.clock.now()
    const id = await $.session.id()
    const dir = await ordner($)
    if (letzteId && letzteId !== id && dir) {
      // nach /clear hat die Sitzung eine neue ID: alte Datei weg
      await entfernen($, [`${dir}/${dateiName(letzteId)}`])
      zuletzt = null
    }
    letzteId = id
    const s = await baueSitzung($, cfg, now)
    if (!s || !dir) return s
    const { herz: _herz, ...ohneHerz } = s
    const json = JSON.stringify(ohneHerz)
    if (brauchtSchreiben(zuletzt, json, now)) {
      await $.fs.write(`${dir}/${dateiName(id)}`, JSON.stringify(s))
      zuletzt = { json, zeit: now }
    }
    return s
  } catch {
    return null
  }
}

/** Alle Herzschläge lesen. Jeder Fehler heißt nur „keine Daten“. */
async function lesen($: EngineInterface, eigene: LeitstandSitzung | null, now: number): Promise<LeitstandSitzung[]> {
  const ergebnis = new Map<string, LeitstandSitzung>()
  try {
    const dir = await ordner($)
    if (dir) {
      const eintraege = await $.fs.list(dir).catch(() => [])
      const weg: string[] = []
      for (const f of eintraege) {
        if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
        if (f.mtimeMs > 0 && now - f.mtimeMs > ALT_MS) {
          weg.push(`${dir}/${f.name}`)
          continue
        }
        if (f.mtimeMs > 0 && now - f.mtimeMs > TOT_MS) continue
        try {
          const s = pruefeSitzung(JSON.parse(await $.fs.read(`${dir}/${f.name}`)))
          if (s) {
            gemerkt.set(s.sessionId, s)
            if (sichtbar(s, now)) ergebnis.set(s.sessionId, s)
          }
        } catch {
          // halb geschriebene Datei: der letzte gute Stand bleibt, solange er frisch ist
          const id = f.name.replace(/\.json$/, '')
          const alt = gemerkt.get(id)
          if (alt && sichtbar(alt, now)) ergebnis.set(alt.sessionId, alt)
        }
      }
      await entfernen($, weg.slice(0, 50))
    }
  } catch {
    // keine Daten
  }
  if (eigene) ergebnis.set(eigene.sessionId, eigene)
  return [...ergebnis.values()]
}

// ---- Abgleich mit der Agent-Liste --------------------------------------------------------------

async function abgleichen($: EngineInterface, now: number) {
  const eigen = await read($, eigenA)
  const offen = Object.values(eigen.agents).filter(a => a.stand === 'laeuft' && !a.id.startsWith('wf:'))
  if (offen.length === 0) return
  const status = new Map((await $.agent.list().catch(() => [])).map(a => [a.id, a.status]))
  for (const a of offen) {
    const s = status.get(a.id)
    // Ein Agent, der noch nicht in der Liste steht, bekommt 10 s Gnadenfrist (Start-Wettlauf).
    if (s === undefined && now - a.gestartet < 10_000) continue
    const neu = s === undefined || s === 'completed' ? 'fertig' : s === 'failed' || s === 'killed' ? 'fehler' : null
    if (neu) await agentAendern($, a.id, z => ({ ...z, stand: neu, beendet: z.beendet ?? now }))
  }
  // Alte, nie beendete Aufrufe aufräumen (Sicherheitsnetz).
  await update($, eigenA, s => {
    const frisch = Object.fromEntries(Object.entries(s.aufrufe).filter(([, a]) => now - a.start < 30 * 60_000))
    return Object.keys(frisch).length === Object.keys(s.aufrufe).length ? s : { ...s, aufrufe: frisch }
  })
}

async function agentAendern($: EngineInterface, id: string, fn: (a: LeitstandAgent) => LeitstandAgent) {
  await update($, eigenA, s => (s.agents[id] ? { ...s, agents: { ...s.agents, [id]: fn(s.agents[id]!) } } : s))
}

// ---- Takt ------------------------------------------------------------------------------------------

async function takt($: EngineInterface, cfg: Konfig) {
  try {
    const now = await $.clock.now()
    await abgleichen($, now)
    const eigene = await herzschlag($, cfg)
    const panes = await $.ui.panes().catch(() => [])
    const offen = panes.some(p => p.id === PANE)
    await update($, offenA, () => offen)
    if (offen) {
      const alle = await lesen($, eigene, now)
      await update($, alleA, () => alle)
      await update($, jetztA, () => now)
    }
    bildStarten($, offen)
  } catch {
    // nie stören
  }
}

function etwasLaeuft(alle: LeitstandSitzung[], now: number): boolean {
  return alle.some(
    s => s.zustand === 'arbeitet' || s.agents.some(a => a.stand === 'laeuft' || (a.beendet !== null && now - a.beendet < 5 * BILD_MS + 600)),
  )
}

/** Animation nur, solange das Pane platziert ist; gezeichnet wird nur, wenn etwas läuft. */
function bildStarten($: EngineInterface, offen: boolean) {
  if (!offen) {
    if (bildTimer) bildTimer.cancel()
    bildTimer = null
    return
  }
  if (bildTimer) return
  bildTimer = $.clock.every(BILD_MS, () => {
    void (async () => {
      try {
        const now = await $.clock.now()
        if (etwasLaeuft(await read($, alleA), now)) await update($, jetztA, () => now)
      } catch {
        // nie stören
      }
    })()
  })
}

function taktStarten($: EngineInterface, cfg: Konfig) {
  if (taktTimer) return
  taktTimer = $.clock.every(TAKT_MS, () => void takt($, cfg).catch(() => undefined))
}

// ---- Aktionen ------------------------------------------------------------------------------------

async function melden($: EngineInterface, text: string) {
  await update($, meldungA, () => text)
  $.clock.after(6000, () => void update($, meldungA, m => (m === text ? '' : m)).catch(() => undefined))
}

async function nachrichtSenden($: EngineInterface, ziel: LeitstandZiel, text: string) {
  const t = text.trim()
  await update($, eingabeA, () => null)
  if (!t) return
  try {
    const an = ziel.art === 'agent' ? { agentId: ziel.id } : { sessionId: ziel.id }
    const r = await $.session.send({ to: an, text: t })
    await melden($, r.isDelivered ? 'Nachricht zugestellt.' : `Nicht zugestellt: ${kuerzen(String(r.reason ?? 'unbekannt'), 60)}`)
  } catch (fehler) {
    await melden($, `Nicht zugestellt: ${kuerzen(String((fehler as Error)?.message ?? fehler), 60)}`)
  }
}

const STOPP_BITTE = 'Leitstand: Bitte beende die aktuelle Arbeit, sichere deinen Stand und warte auf neue Anweisungen.'

/** Stopp nach Bestätigung: echtes Beenden, wo die API es kann (eigene Agents, eigener Turn); sonst eine Bitte. */
async function stoppen($: EngineInterface, ziel: LeitstandZiel, eigeneId: string) {
  try {
    if (ziel.art === 'agent') {
      try {
        await $.tool.call({ tool: 'TaskStop', task_id: ziel.id })
        await melden($, 'Agent gestoppt.')
        return
      } catch {
        const r = await $.session.send({ to: { agentId: ziel.id }, text: STOPP_BITTE })
        await melden($, r.isDelivered ? 'Stopp-Bitte an den Agent geschickt.' : 'Stopp nicht möglich.')
        return
      }
    }
    if (ziel.id === eigeneId) {
      const turnId = (await read($, eigenA)).turnId
      if (turnId) {
        await $.turn.abort({ turnId })
        await melden($, 'Laufender Zug dieser Sitzung abgebrochen.')
      } else await melden($, 'Diese Sitzung arbeitet gerade nicht.')
      return
    }
    const r = await $.session.send({ to: { sessionId: ziel.id }, text: STOPP_BITTE })
    await melden($, r.isDelivered ? 'Stopp-Bitte an die Sitzung geschickt.' : `Stopp-Bitte nicht zugestellt: ${kuerzen(String(r.reason ?? ''), 50)}`)
  } catch (fehler) {
    await melden($, `Stopp ging nicht: ${kuerzen(String((fehler as Error)?.message ?? fehler), 60)}`)
  }
}

async function stoppKlick($: EngineInterface, ziel: LeitstandZiel, eigeneId: string) {
  const now = await $.clock.now()
  const bitte = await read($, stoppA)
  if (bitte && bitte.ziel === ziel.id && bitte.bis > now) {
    await update($, stoppA, () => null)
    await stoppen($, ziel, eigeneId)
    return
  }
  await update($, stoppA, () => ({ ziel: ziel.id, bis: now + 5000 }))
  $.clock.after(5000, () => void update($, stoppA, s => (s && s.ziel === ziel.id ? null : s)).catch(() => undefined))
}

/** Zeitgeber (neu) anlegen, falls ein Neuladen sie verloren hat: idempotent. */
async function sicher($: EngineInterface, cfg: Konfig) {
  taktStarten($, cfg)
  const offen = await $.ui.panes().then(p => p.some(x => x.id === PANE)).catch(() => false)
  bildStarten($, offen)
}

// ---- Registrierung --------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const cfg: Konfig = { ausblenden: ausblendenListe(options.ausblenden ?? STANDARD_AUSBLENDEN) }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: BEFEHL, description: 'Leitstand: alle Sitzungen und Subagents als Pixel-Männchen im Seitenpanel (öffnen/schließen)' })
    } catch (fehler) {
      $.ui.log(`leitstand: /${BEFEHL} nicht registriert: ${kuerzen(String((fehler as Error)?.message ?? fehler), 160)}`, { to: 'debug' })
    }
    await sicher($, cfg)
    void takt($, cfg)
    return r
  })

  on('session.end', async ($, e, next) => {
    try {
      if (taktTimer) taktTimer.cancel()
      if (bildTimer) bildTimer.cancel()
      taktTimer = null
      bildTimer = null
      const dir = await ordner($)
      if (dir) await entfernen($, [`${dir}/${dateiName(e.sessionId)}`])
      zuletzt = null
      if (e.reason === 'clear') {
        letzteId = ''
        await update($, eigenA, () => leererEigenStand())
      }
    } catch {
      // beim Beenden nie stören
    }
    return next(e)
  })

  on('command.run', { command: BEFEHL }, async $ => {
    await sicher($, cfg)
    const offen = await $.ui.panes().then(p => p.some(x => x.id === PANE)).catch(() => false)
    if (offen) {
      await $.ui.close({ id: PANE })
      bildStarten($, false)
      return { text: 'Leitstand geschlossen.' }
    }
    await $.ui.open({ id: PANE, title: 'Leitstand' })
    void takt($, cfg)
    return { text: 'Leitstand geöffnet.' }
  })

  on('turn.start', async ($, e, next) => {
    void sicher($, cfg)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, eigenA, s => ({ ...s, arbeitet: true, seit: now, turnId: e.turnId }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId) {
      const u = e.usage
      const verbraucht = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      await agentAendern($, e.agentId, a => ({
        ...a,
        tokens: a.tokens + verbraucht,
        modell: u?.model ? modellKurz(u.model) : a.modell,
        stand: e.reason === 'answer' ? 'fertig' : 'fehler',
        beendet: now,
      }))
    } else {
      await update($, eigenA, s => ({ ...s, arbeitet: false, seit: now, turnId: null, letzteAntwort: e.usage ? now : s.letzteAntwort }))
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || !r.agentId) return r
    const id = r.agentId
    const now = await $.clock.now()
    const zeile: LeitstandAgent = {
      id,
      beschreibung: kuerzen(e.description ?? '', 60),
      typ: kuerzen(e.subagentType ?? '', 30),
      modell: e.fork ? 'fork' : modellKurz(r.model),
      stand: 'laeuft',
      werkzeug: null,
      ziel: '',
      gestartet: now,
      beendet: null,
      tokens: 0,
      tools: 0,
    }
    await update($, eigenA, s => {
      const rest = Object.values(s.agents).filter(a => a.id !== id).slice(-30)
      return { ...s, agents: { ...Object.fromEntries(rest.map(a => [a.id, a])), [id]: zeile } }
    })
    return r
  })

  on('tool.call', async ($, e, next) => {
    void sicher($, cfg)
    const tool = String(e.tool)
    const id = e.tool_use_id
    const agentId = e.agentId
    const now = await $.clock.now()
    const aufruf = { agentId, werkzeug: tool, ziel: zielAus(tool, e as unknown as Record<string, unknown>), start: now }
    const wf = tool === 'Workflow' ? `wf:${id}` : null
    await update($, eigenA, s => {
      const agents = { ...s.agents }
      if (agentId && agents[agentId]) agents[agentId] = { ...agents[agentId]!, tools: agents[agentId]!.tools + 1 }
      if (wf) {
        agents[wf] = {
          id: wf,
          beschreibung: `Workflow: ${aufruf.ziel}`,
          typ: 'workflow',
          modell: 'workflow',
          stand: 'laeuft',
          werkzeug: null,
          ziel: '',
          gestartet: now,
          beendet: null,
          tokens: 0,
          tools: 0,
        }
      }
      return { ...s, aufrufe: { ...s.aufrufe, [id]: aufruf }, agents }
    })
    let fehler = false
    try {
      const r = await next(e)
      fehler = !!(r as { isError?: boolean; deny?: unknown }).isError || (r as { deny?: unknown }).deny !== undefined
      return r
    } catch (err) {
      fehler = true
      throw err
    } finally {
      const ende = await $.clock.now().catch(() => now)
      await update($, eigenA, s => {
        const { [id]: _weg, ...aufrufe } = s.aufrufe
        const agents = wf && s.agents[wf] ? { ...s.agents, [wf]: { ...s.agents[wf]!, stand: fehler ? 'fehler' : 'fertig', beendet: ende } } : s.agents
        return { ...s, aufrufe, agents: agents as typeof s.agents }
      }).catch(() => undefined)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = 'Input' in t ? t.Input : null
    const alleRoh = await read($, alleA)
    const jetzt = (await read($, jetztA)) || (await $.clock.now())
    const eingabe = await read($, eingabeA)
    const stopp = await read($, stoppA)
    const meldung = await read($, meldungA)
    const eigeneId = await $.session.id().catch(() => '')
    const alle = sortieren(
      alleRoh.filter(s => s.sessionId === eigeneId || sichtbar(s, jetzt)),
      eigeneId,
    )
    const sum = summe(alle)
    const tick = Math.floor(jetzt / BILD_MS)

    const mann = (key: string, hutKey: string, zustand: MannZustand, modell: string, beendet: number | null) => {
      const phase = beendet === null ? undefined : Math.floor((jetzt - beendet) / BILD_MS)
      const m = maennchen({ hut: hutFuer(hutKey), zustand, tick, phase })
      return (
        <Box key={key} flexDirection="row" width={BREITE + 4}>
          <Box flexDirection="column" width={BREITE}>
            {m.zeilen.map((zeile, i) => (
              <Text key={`${key}-z${i}`}>
                {zeile.map((lauf, j) => (
                  <Text key={`${key}-z${i}-${j}`} color={lauf.fg} backgroundColor={lauf.bg}>
                    {lauf.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
          <Text color={zusatzFarbe(zustand)}> {m.zusatz}</Text>
        </Box>
      )
    }
    const modellZeile = (key: string, modell: string, zustand: MannZustand) => (
      <Box key={key} width={BREITE + 4}>
        <Text color={modellFarbe(modell)} bold>
          {modell}
        </Text>
        <Text dimColor> {zustand === 'arbeitet' ? 'arbeitet' : zustand === 'wartet' ? 'wartet' : zustand === 'ruht' ? 'ruht' : zustand === 'fertig' ? 'fertig' : 'Fehler'}</Text>
      </Box>
    )

    const knoepfe = (ziel: LeitstandZiel, darfStopp: boolean, darfNachricht: boolean) => {
      const wartet = stopp !== null && stopp.ziel === ziel.id && stopp.bis > jetzt
      return (
        <Box key={`k-${ziel.id}`} gap={1}>
          {darfNachricht && (
            <Button
              key={`n-${ziel.id}`}
              label="Nachricht"
              onPress={() => void update($, eingabeA, cur => (cur && cur.id === ziel.id ? null : ziel)).catch(() => undefined)}
            />
          )}
          {darfStopp && (
            <Button
              key={`s-${ziel.id}`}
              label={wartet ? 'Sicher? Nochmal Stopp' : 'Stopp'}
              variant={wartet ? 'primary' : undefined}
              onPress={() => void stoppKlick($, ziel, eigeneId).catch(() => undefined)}
            />
          )}
        </Box>
      )
    }
    const eingabeFeld = (ziel: LeitstandZiel) =>
      Input && eingabe && eingabe.id === ziel.id ? (
        <Input
          key={`e-${ziel.id}`}
          label="Nachricht: "
          placeholder="kurzer Text, Enter schickt"
          submitLabel="senden"
          autoFocus
          onSubmit={(text: string) => void nachrichtSenden($, ziel, text).catch(() => undefined)}
        />
      ) : null

    const karte = (s: LeitstandSitzung) => {
      const istEigen = s.sessionId === eigeneId
      const cache = cacheStand(s.letzteAntwort, jetzt)
      const hauptZustand: MannZustand = s.zustand
      const agents = s.agents.slice(-8)
      return (
        <Box
          key={`karte-${s.sessionId}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={istEigen ? '#D97757' : undefined}
          paddingX={1}
          marginBottom={1}
        >
          <Text wrap="truncate-end">
            <Text bold>{s.projekt}</Text>
            {istEigen && <Text color="#D97757"> ◀ diese</Text>}
            <Text dimColor> · </Text>
            <Text color={modellFarbe(s.modell)}>{s.modell}</Text>
            <Text dimColor> · ctx </Text>
            <Text color={s.kontextProzent !== null && s.kontextProzent >= 80 ? 'red' : undefined}>{s.kontextProzent === null ? '–' : `${s.kontextProzent} %`}</Text>
            <Text dimColor> · Cache </Text>
            <Text color={cache === 'warm' ? '#3FB950' : cache === 'kalt' ? '#58A6FF' : undefined} dimColor={cache === null}>{cache === null ? '–' : '●'}</Text>
            {s.profil ? <Text dimColor> · {s.profil}</Text> : null}
          </Text>
          <Box key={`reihe-${s.sessionId}`} flexDirection="row" flexWrap="wrap" gap={1}>
            <Box flexDirection="column" key={`m-${s.sessionId}`}>
              {mann(`h-${s.sessionId}`, s.sessionId, hauptZustand, s.modell, null)}
              {modellZeile(`hl-${s.sessionId}`, s.modell, hauptZustand)}
            </Box>
            {agents.map(a => {
              const z: MannZustand = a.stand === 'laeuft' ? 'arbeitet' : a.stand
              return (
                <Box flexDirection="column" key={`m-${s.sessionId}-${a.id}`}>
                  {mann(`a-${s.sessionId}-${a.id}`, a.id, z, a.modell, a.beendet)}
                  {modellZeile(`al-${s.sessionId}-${a.id}`, a.modell, z)}
                </Box>
              )
            })}
          </Box>
          <Text key={`zh-${s.sessionId}`} wrap="truncate-end">
            <Text color={s.zustand === 'arbeitet' ? '#58A6FF' : s.zustand === 'wartet' ? '#E3B341' : undefined} dimColor={s.zustand === 'ruht'}>
              {s.zustand === 'arbeitet' ? '● arbeitet ' : s.zustand === 'wartet' ? '? wartet auf dich ' : '○ ruht '}
            </Text>
            {s.werkzeug ? (
              <Text>
                {s.werkzeug}
                {s.ziel ? `: ${s.ziel}` : ''}{' '}
              </Text>
            ) : null}
            <Text dimColor>seit {dauer(jetzt - s.seit)}</Text>
            {s.kosten !== null ? <Text dimColor> · {dollar(s.kosten)}</Text> : null}
          </Text>
          {(s.zustand === 'arbeitet' || !istEigen) && knoepfe({ art: 'sitzung', id: s.sessionId }, s.zustand === 'arbeitet', !istEigen)}
          {!istEigen && eingabeFeld({ art: 'sitzung', id: s.sessionId })}
          {agents.map(a => (
            <Box key={`az-${s.sessionId}-${a.id}`} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={a.stand === 'laeuft' ? '#58A6FF' : a.stand === 'fertig' ? '#3FB950' : '#F85149'}>{a.stand === 'laeuft' ? '● ' : a.stand === 'fertig' ? '✓ ' : '✗ '}</Text>
                <Text color={modellFarbe(a.modell)} bold>{a.modell} </Text>
                <Text>{a.beschreibung || a.typ}</Text>
                {a.werkzeug ? <Text dimColor> · {a.werkzeug}{a.ziel ? `: ${a.ziel}` : ''}</Text> : null}
                <Text dimColor> · {dauer((a.beendet ?? jetzt) - a.gestartet)}{a.tokens ? ` · ${tokens(a.tokens)}` : ''}</Text>
              </Text>
              {istEigen && !a.id.startsWith('wf:') && a.stand === 'laeuft' && knoepfe({ art: 'agent', id: a.id }, true, true)}
              {istEigen && eingabeFeld({ art: 'agent', id: a.id })}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text key="summe" wrap="truncate-end">
          <Text bold>{sum.sitzungen === 1 ? '1 Sitzung' : `${sum.sitzungen} Sitzungen`}</Text>
          <Text dimColor> · </Text>
          <Text color={sum.agentsLaufen > 0 ? '#58A6FF' : undefined}>{sum.agentsLaufen} {sum.agentsLaufen === 1 ? 'Agent läuft' : 'Agents laufen'}</Text>
          {sum.kosten !== null ? <Text dimColor> · Kosten {dollar(sum.kosten)}</Text> : null}
        </Text>
        {meldung ? <Text key="meldung" color="#E3B341" wrap="truncate-end">{meldung}</Text> : null}
        {alle.length === 0 ? (
          <Text key="leer" dimColor>
            Noch keine Sitzung gemeldet. Sobald eine Sitzung mit der Mod „leitstand“ läuft, erscheint sie hier.
          </Text>
        ) : (
          alle.map(karte)
        )}
      </Box>
    )
  })

}
