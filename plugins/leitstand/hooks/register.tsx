import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LeitstandAgent, LeitstandEigen, LeitstandLimit, LeitstandSitzung, LeitstandZiel } from '../types'
import { baueAnsicht } from './ansicht'
import type { KnopfZiel, Seg, Zeile } from './ansicht'
import { crewZellen } from './clawd'
import type { Figur } from './clawd'
import {
  AGENT_STILL_MS,
  FERTIG_ZEIGEN_MS,
  agentsFuerDatei,
  aktuell,
  ausblendenListe,
  basename,
  brauchtSchreiben,
  dateiName,
  istVersteckt,
  kostenBasisFuer,
  kuerzen,
  leerZ,
  leererEigenStand,
  modellBezeichnung,
  neuerAgent,
  pruefeSitzung,
  tagKey,
  tagStart,
  tagWechsel,
  werkzeugName,
  zaehle,
  zielAus,
  zustandSeitVon,
  zustandVon,
} from './logik'

// Neue Schlüssel (eigen2, alle2): ein Neuladen aus Version 0.1 findet so keinen Zustand in der alten Form vor.
const eigenA = atom({ plugin: 'leitstand', key: 'eigen2' } as const, leererEigenStand())
const alleA = atom({ plugin: 'leitstand', key: 'alle2' } as const, [])
const jetztA = atom({ plugin: 'leitstand', key: 'jetzt' } as const, 0)
const offenA = atom({ plugin: 'leitstand', key: 'offen' } as const, false)
const auswahlA = atom({ plugin: 'leitstand', key: 'auswahl' } as const, null)
const aktionA = atom({ plugin: 'leitstand', key: 'aktion' } as const, null)
const eingabeA = atom({ plugin: 'leitstand', key: 'eingabe' } as const, null)
const stoppA = atom({ plugin: 'leitstand', key: 'stoppBitte' } as const, null)
const meldungA = atom({ plugin: 'leitstand', key: 'meldung' } as const, '')

export const PANE = 'leitstand'
export const BEFEHL = 'leitstand'
export const ORDNER = '.claude-leitstand/sitzungen'
const TAKT_MS = 2000
const RAND_RECHTS = 2
/** Vier Bilder je Sekunde für die Animation (nur `blit`, kein Render-Durchlauf). */
export const BILD_MS = 250
const STANDARD_AUSBLENDEN = ''
// Private Wörter stehen nicht im (öffentlichen) Code, sondern lokal in ~/.claude-leitstand/ausblenden.txt (Komma oder Zeile je Wort).
const AUSBLENDEN_DATEI = '.claude-leitstand/ausblenden.txt'

type Konfig = { ausblenden: string[] }

// Nur Zeitgeber und Zwischenspeicher leben im Modul (gehen beim Neuladen verloren und werden von den Hooks neu angelegt).
let taktTimer: { cancel: () => void } | null = null
let bildTimer: { cancel: () => void } | null = null
let zuletzt: { json: string; zeit: number } | null = null
let letzteId = ''
/** Der zuletzt gezeichnete Crew-Streifen: daraus malt der Bild-Takt die nächsten Bilder. */
let letztesBild: { figuren: Figur[]; spalten: number } | null = null
let letzteZellen = ''
const gemerkt = new Map<string, { mtime: number; s: LeitstandSitzung }>()

/** Hooks dürfen das Verhalten von Claude Code nie ändern: Fehler in unserem Teil werden verschluckt. */
async function still(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // nie stören
  }
}

// ---- Dateiablage -------------------------------------------------------------------------------

async function homeDir($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? home.replace(/\/$/, '') : null
}

/** Ablageordner der Herzschläge; `LEITSTAND_ABLAGE` (Umgebungsvariable) legt für Tests und Demos einen anderen fest. */
async function ordner($: EngineInterface): Promise<string | null> {
  const andere = await $.env.get('LEITSTAND_ABLAGE')
  if (andere) return andere.replace(/\/$/, '')
  const home = await homeDir($)
  return home ? `${home}/${ORDNER}` : null
}

async function lokaleAusblendenListe($: EngineInterface): Promise<string[]> {
  try {
    const home = await homeDir($)
    const text = home ? await $.fs.read(`${home}/${AUSBLENDEN_DATEI}`) : ''
    return ausblendenListe(text.replace(/\n/g, ','))
  } catch {
    return []
  }
}

async function profilName($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  return (dir ? basename(dir) : '') || '.claude'
}

async function entfernen($: EngineInterface, pfade: string[]) {
  if (pfade.length === 0) return
  try {
    await $.process.run(['rm', '-f', ...pfade], { timeoutMs: 5000 })
  } catch {
    // dann bleibt die Datei liegen; der Leser räumt beim nächsten Mal auf
  }
}

/** Limits aus `session.usage()`; Reset als Zeitpunkt in ms. */
function limitsAus(roh: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }> | undefined): LeitstandLimit[] {
  if (!roh) return []
  const aus: LeitstandLimit[] = []
  for (const l of roh) {
    if (typeof l.percentUsed !== 'number' || !Number.isFinite(l.percentUsed)) continue
    const t = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN
    aus.push({ art: String(l.kind), prozent: l.percentUsed, reset: Number.isFinite(t) ? t : null })
  }
  return aus
}

/** Früher gespeicherter Stand derselben Sitzung (Fortsetzung, Neustart der Sitzung am selben Tag): Zähler wieder aufnehmen. */
async function ausDateiLaden($: EngineInterface, id: string, now: number) {
  const eigen = await read($, eigenA)
  if (eigen.geladen) return
  let alt: LeitstandSitzung | null = null
  try {
    const dir = await ordner($)
    if (dir) alt = pruefeSitzung(JSON.parse(await $.fs.read(`${dir}/${dateiName(id)}`)))
  } catch {
    alt = null
  }
  const heute = tagKey(now)
  await update($, eigenA, s => {
    if (s.geladen) return s
    const basis = { ...s, geladen: true }
    if (!alt || alt.alt || alt.tag !== heute || s.zaehlSeit !== null) return basis
    const kostenBasis = alt.kosten !== null && alt.kostenHeute !== null ? { tag: heute, usd: Math.max(0, alt.kosten - alt.kostenHeute) } : null
    return {
      ...basis,
      tag: heute,
      zaehlSeit: alt.zaehlSeit,
      gesamt: alt.gesamt,
      haupt: alt.haupt,
      modelle: alt.modelle,
      letzteAntwort: alt.letzteAntwort,
      letzterSchritt: alt.limitsZeit,
      kostenBasis,
      agents: Object.fromEntries(alt.agents.map(a => [a.id, a])),
    }
  })
}

/** Die eigene Sitzung als Datei-Inhalt; null, wenn privat (dann gibt es gar keine Datei). */
async function baueSitzung($: EngineInterface, cfg: Konfig, now: number): Promise<LeitstandSitzung | null> {
  const cwd = await $.session.cwd()
  if (istVersteckt(cwd, [...cfg.ausblenden, ...(await lokaleAusblendenListe($))])) return null
  const id = await $.session.id()
  await ausDateiLaden($, id, now)
  const usage = await $.session.usage().catch(() => undefined)
  const usd = usage?.cost?.usd
  const tag = tagKey(now)
  // Tageswechsel, Beginn des Zustands und Tages-Kostenbasis nachführen
  await update($, eigenA, s => {
    let n = tagWechsel(s, tag)
    if (!n.seit) n = { ...n, seit: now }
    if (typeof usd === 'number' && Number.isFinite(usd)) {
      // Nach /clear zählt nur, was ab dem ersten Messwert der neuen Sitzung dazukommt: das Kostenbuch kann bei 0 beginnen oder weiterlaufen.
      n = n.nachClear
        ? { ...n, nachClear: false, kostenBasis: { tag, usd } }
        : { ...n, kostenBasis: kostenBasisFuer(n.kostenBasis, tag, usage?.startedAt ?? null, now, usd) }
    }
    return n
  })
  const eigen = await read($, eigenA)
  const hauptWerkzeug = eigen.arbeitet ? aktuell(eigen.aufrufe, undefined) : null
  const prozent = usage?.context?.percent ?? (usage?.context?.tokens && usage.context.window ? (usage.context.tokens / usage.context.window) * 100 : undefined)
  const kosten = typeof usd === 'number' && Number.isFinite(usd) ? usd : null
  const kostenHeute = kosten !== null && eigen.kostenBasis ? Math.max(0, kosten - eigen.kostenBasis.usd) : null
  const limits = limitsAus(usage?.rateLimits)
  return {
    v: 2,
    sessionId: id,
    profil: await profilName($),
    projekt: kuerzen(basename(cwd) || cwd, 40),
    modell: modellBezeichnung(await $.session.model()),
    kontextProzent: typeof prozent === 'number' && Number.isFinite(prozent) ? Math.round(prozent) : null,
    gestartet: typeof usage?.startedAt === 'number' ? usage.startedAt : null,
    zaehlSeit: eigen.zaehlSeit,
    tag,
    gesamt: eigen.gesamt,
    haupt: eigen.haupt,
    modelle: eigen.modelle,
    kosten: kosten === null ? null : Math.round(kosten * 10_000) / 10_000,
    kostenHeute: kostenHeute === null ? null : Math.round(kostenHeute * 10_000) / 10_000,
    limits,
    limitsZeit: limits.length > 0 ? (eigen.letzterSchritt ?? (typeof usage?.startedAt === 'number' ? usage.startedAt : null)) : null,
    letzteAntwort: eigen.letzteAntwort,
    zustand: zustandVon(eigen, now),
    zustandSeit: zustandSeitVon(eigen, now),
    werkzeug: hauptWerkzeug ? werkzeugName(hauptWerkzeug.werkzeug) : null,
    ziel: hauptWerkzeug ? hauptWerkzeug.ziel : '',
    agents: agentsFuerDatei(eigen, now),
    beendet: null,
    herz: now,
  }
}

async function schreibeDatei($: EngineInterface, dir: string, s: LeitstandSitzung) {
  await $.fs.write(`${dir}/${dateiName(s.sessionId)}`, JSON.stringify(s))
}

/** Herzschlag schreiben: nur bei Änderung (oder alle 30 s zur Lebenszeichen-Auffrischung). Wirft nie. */
async function herzschlag($: EngineInterface, cfg: Konfig): Promise<LeitstandSitzung | null> {
  try {
    const now = await $.clock.now()
    const id = await $.session.id()
    const dir = await ordner($)
    if (letzteId && letzteId !== id) zuletzt = null // nach /clear: neue Sitzung, neue Datei
    letzteId = id
    const s = await baueSitzung($, cfg, now)
    if (!s || !dir) return s
    const { herz: _herz, ...ohneHerz } = s
    const json = JSON.stringify(ohneHerz)
    if (brauchtSchreiben(zuletzt, json, now)) {
      await schreibeDatei($, dir, s)
      zuletzt = { json, zeit: now }
    }
    return s
  } catch {
    return null
  }
}

/** Alle Dateien von heute lesen (laufende und beendete); ältere räumt der Leser weg. Jeder Fehler heißt nur „keine Daten". */
async function lesen($: EngineInterface, eigene: LeitstandSitzung | null, now: number): Promise<LeitstandSitzung[]> {
  const ergebnis = new Map<string, LeitstandSitzung>()
  try {
    const dir = await ordner($)
    if (dir) {
      const heute0 = tagStart(now)
      const eintraege = await $.fs.list(dir).catch(() => [])
      const weg: string[] = []
      const gesehen = new Set<string>()
      for (const f of eintraege) {
        if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
        if (f.mtimeMs > 0 && f.mtimeMs < heute0) {
          weg.push(`${dir}/${f.name}`)
          gemerkt.delete(f.name)
          continue
        }
        gesehen.add(f.name)
        const alt = gemerkt.get(f.name)
        if (alt && alt.mtime === f.mtimeMs) {
          ergebnis.set(alt.s.sessionId, alt.s)
          continue
        }
        try {
          const s = pruefeSitzung(JSON.parse(await $.fs.read(`${dir}/${f.name}`)))
          if (s && s.herz >= heute0 - 1) {
            gemerkt.set(f.name, { mtime: f.mtimeMs, s })
            ergebnis.set(s.sessionId, s)
          }
        } catch {
          // halb geschriebene Datei: der letzte gute Stand bleibt
          if (alt) ergebnis.set(alt.s.sessionId, alt.s)
        }
      }
      for (const k of [...gemerkt.keys()]) if (!gesehen.has(k)) gemerkt.delete(k)
      await entfernen($, weg.slice(0, 50))
    }
  } catch {
    // keine Daten
  }
  if (eigene) ergebnis.set(eigene.sessionId, eigene)
  return [...ergebnis.values()]
}

// ---- Abgleich mit der Agent-Liste --------------------------------------------------------------

const standAusListe = (status: string): LeitstandAgent['stand'] =>
  status === 'completed' ? 'fertig' : status === 'failed' || status === 'killed' ? 'fehler' : status === 'idle' || status === 'waiting' ? 'wartet' : 'laeuft'

async function abgleichen($: EngineInterface, now: number) {
  const liste = await $.agent.list().catch(() => null)
  await update($, eigenA, s => {
    const agents: Record<string, LeitstandAgent> = { ...s.agents }
    const gesehen = { ...s.gesehen }
    const inListe = new Set<string>()
    if (liste) {
      for (const a of liste) {
        inListe.add(a.id)
        gesehen[a.id] = true
        const stand = standAusListe(a.status)
        const cur = agents[a.id]
        if (!cur) {
          // ein Agent, den die Mod nicht hat starten sehen (Mod später geladen): aufnehmen, solange er läuft
          if (stand === 'laeuft' || stand === 'wartet') {
            agents[a.id] = neuerAgent(a.id, { name: kuerzen(a.name ?? a.description ?? '', 60), typ: kuerzen(a.type ?? '', 30), art: a.teammateId ? 'teammate' : 'agent', stand }, now)
          }
          continue
        }
        if (cur.stand === stand) continue
        const beendet = stand === 'fertig' || stand === 'fehler'
        agents[a.id] = { ...cur, stand, beendet: beendet ? (cur.beendet ?? now) : null, aktiv: beendet ? cur.aktiv : now }
      }
      // Was der Host einmal nannte und nicht mehr nennt, ist zu Ende; was er nie nannte (Workflow-Agents), endet über `turn.complete`
      // oder, ohne jede Regung, nach 20 min.
      for (const a of Object.values(agents)) {
        if (a.stand !== 'laeuft' && a.stand !== 'wartet') continue
        if (inListe.has(a.id)) continue
        if (gesehen[a.id] || now - a.aktiv > AGENT_STILL_MS) agents[a.id] = { ...a, stand: 'fertig', beendet: a.beendet ?? now }
      }
    }
    // Alte Einträge und Aufrufe aufräumen
    for (const a of Object.values(agents)) if (a.beendet !== null && now - a.beendet > 2 * FERTIG_ZEIGEN_MS) delete agents[a.id]
    const aufrufe = Object.fromEntries(Object.entries(s.aufrufe).filter(([, a]) => now - a.start < 30 * 60_000))
    return { ...s, agents, gesehen, aufrufe }
  })
}

async function agentAendern($: EngineInterface, id: string, fn: (a: LeitstandAgent) => LeitstandAgent) {
  await update($, eigenA, s => (s.agents[id] ? { ...s, agents: { ...s.agents, [id]: fn(s.agents[id]!) } } : s))
}

// ---- Takt und Animation ------------------------------------------------------------------------------

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

/** Ein Bild der Animation: nur der Crew-Streifen wird neu berechnet und per `blit` gemalt, und nur, wenn er sich geändert hat. */
async function bild($: EngineInterface) {
  try {
    const b = letztesBild
    if (!b) return
    const now = await $.clock.now()
    const z = crewZellen(b.figuren, b.spalten, Math.floor(now / BILD_MS), now, BILD_MS)
    const cells = z.kodiere()
    if (cells === letzteZellen) return
    const r = await $.ui.blit({ requestId: PANE, key: 'crew', cells, columns: z.spalten, rows: z.zeilen })
    if (!r.deny) letzteZellen = cells
  } catch {
    // nie stören
  }
}

/** Animation nur, solange das Pane platziert ist. */
function bildStarten($: EngineInterface, offen: boolean) {
  if (!offen) {
    if (bildTimer) bildTimer.cancel()
    bildTimer = null
    letztesBild = null
    letzteZellen = ''
    return
  }
  if (bildTimer) return
  bildTimer = $.clock.every(BILD_MS, () => void bild($))
}

function taktStarten($: EngineInterface, cfg: Konfig) {
  if (taktTimer) return
  taktTimer = $.clock.every(TAKT_MS, () => void takt($, cfg).catch(() => undefined))
}

/** Zeitgeber (neu) anlegen, falls ein Neuladen sie verloren hat: idempotent. */
async function sicher($: EngineInterface, cfg: Konfig) {
  taktStarten($, cfg)
  const offen = await $.ui.panes().then(p => p.some(x => x.id === PANE)).catch(() => false)
  bildStarten($, offen)
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

/** Klick auf eine Zeile: wählt den Umfang (Sitzung) bzw. das Ziel für Nachricht und Stopp (Haupt/Agent); ein zweiter Klick nimmt zurück. */
async function waehlen($: EngineInterface, z: KnopfZiel) {
  const gleich = (a: LeitstandZiel | null, b: LeitstandZiel) => a !== null && a.art === b.art && a.id === b.id
  await update($, eingabeA, () => null)
  switch (z.was) {
    case 'alle':
      await update($, auswahlA, () => null)
      await update($, aktionA, () => null)
      return
    case 'sitzung':
      await update($, auswahlA, cur => (cur === z.id ? null : z.id))
      await update($, aktionA, () => null)
      return
    case 'haupt': {
      const ziel: LeitstandZiel = { art: 'sitzung', id: z.sitzungId }
      await update($, auswahlA, () => z.sitzungId)
      await update($, aktionA, cur => (gleich(cur, ziel) ? null : ziel))
      return
    }
    case 'agent': {
      const ziel: LeitstandZiel = { art: 'agent', id: z.id }
      await update($, auswahlA, () => z.sitzungId)
      await update($, aktionA, cur => (gleich(cur, ziel) ? null : ziel))
      return
    }
  }
}

// ---- Zeichnen ---------------------------------------------------------------------------------------

/** Benachbarte Stücke gleichen Stils zusammenfassen (weniger Elemente). */
function verschmelzen(segs: Seg[]): Seg[] {
  const aus: Seg[] = []
  for (const s of segs) {
    const l = aus[aus.length - 1]
    if (l && l.c === s.c && !!l.dim === !!s.dim && !!l.b === !!s.b) l.t += s.t
    else aus.push({ ...s })
  }
  return aus
}

// ---- Registrierung ----------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const cfg: Konfig = { ausblenden: ausblendenListe(options.ausblenden ?? STANDARD_AUSBLENDEN) }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await still(async () => {
      try {
        await $.command.register({ name: BEFEHL, description: 'Leitstand: Live-Dashboard aller Sitzungen mit Kosten, Cache, Limits und Subagents (öffnen/schließen)' })
      } catch (fehler) {
        $.ui.log(`leitstand: /${BEFEHL} nicht registriert: ${kuerzen(String((fehler as Error)?.message ?? fehler), 160)}`, { to: 'debug' })
      }
      await sicher($, cfg)
      void takt($, cfg)
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    await still(async () => {
      const clear = e.reason === 'clear'
      if (!clear) {
        if (taktTimer) taktTimer.cancel()
        if (bildTimer) bildTimer.cancel()
        taktTimer = null
        bildTimer = null
        letztesBild = null
      }
      // Die Datei bleibt liegen, mit Endzeit: beendete Sitzungen zählen in „heute".
      const now = await $.clock.now()
      const dir = await ordner($)
      const s = dir ? await baueSitzung($, cfg, now) : null
      if (dir && s) await schreibeDatei($, dir, { ...s, beendet: now, zustand: 'ruht', zustandSeit: now })
      zuletzt = null
      if (clear) {
        letzteId = ''
        await update($, eigenA, () => ({ ...leererEigenStand(), geladen: true, nachClear: true }))
        await update($, auswahlA, () => null)
        await update($, aktionA, () => null)
      }
    })
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
    await still(async () => {
      void sicher($, cfg)
      const now = await $.clock.now()
      if (!e.agentId) {
        await update($, eigenA, s => ({ ...s, arbeitet: true, seit: now, turnId: e.turnId, braucht: null }))
      } else {
        await agentAendern($, e.agentId, a => ({ ...a, stand: 'laeuft', beendet: null, aktiv: now }))
      }
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await still(async () => {
      const now = await $.clock.now()
      if (e.agentId) {
        await agentAendern($, e.agentId, a => ({ ...a, stand: e.reason === 'answer' ? 'fertig' : 'fehler', beendet: now, aktiv: now }))
      } else {
        const ende: LeitstandEigen['ende'] = e.reason === 'answer' ? 'wartet' : e.reason === 'aborted' ? 'abgebrochen' : 'fehler'
        await update($, eigenA, s => ({ ...s, arbeitet: false, ende, seit: now, turnId: null, braucht: null }))
      }
    })
    return next(e)
  })

  // Jede Anfrage des Modells (Hauptschleife und Subagents): zählen, was die API als Verbrauch meldet. Streamendes Ereignis, daher ein Generator.
  // Nur echte Antworten haben `usage`; ein Fehler oder eine abgebrochene Anfrage liefert keine (null) und zählt nicht.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    await still(async () => {
      const u = r?.usage
      if (!u) return
      const now = await $.clock.now()
      const modell = modellBezeichnung(u.model || e.model)
      const agentId = e.agentId
      await update($, eigenA, s0 => {
        const s = tagWechsel(s0, tagKey(now))
        const art = agentId ? s.agents[agentId] : undefined
        const agents = agentId && art ? { ...s.agents, [agentId]: { ...art, modell, z: zaehle(art.z, u), aktiv: now, stand: art.stand === 'fertig' || art.stand === 'fehler' ? 'laeuft' : art.stand, beendet: art.stand === 'fertig' || art.stand === 'fehler' ? null : art.beendet } } : s.agents
        return {
          ...s,
          gesamt: zaehle(s.gesamt, u),
          haupt: agentId ? s.haupt : zaehle(s.haupt, u),
          modelle: { ...s.modelle, [modell]: zaehle(s.modelle[modell] ?? leerZ(), u) },
          agents,
          zaehlSeit: s.zaehlSeit ?? now,
          letzterSchritt: now,
          letzteAntwort: agentId ? s.letzteAntwort : now,
        }
      })
    })
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await still(async () => {
      if (r.deny !== undefined || !r.agentId) return
      const id = r.agentId
      const now = await $.clock.now()
      const art: LeitstandAgent['art'] = e.workflow ? 'workflow' : e.fork ? 'fork' : e.isTeammate ? 'teammate' : 'agent'
      const zeile = neuerAgent(
        id,
        {
          name: kuerzen(e.name ?? e.description ?? '', 60),
          typ: kuerzen(e.subagentType ?? '', 30),
          art,
          modell: modellBezeichnung(r.model),
        },
        now,
      )
      await update($, eigenA, s => {
        const rest = Object.values(s.agents).filter(a => a.id !== id).slice(-30)
        return { ...s, agents: { ...Object.fromEntries(rest.map(a => [a.id, a])), [id]: zeile } }
      })
    })
    return r
  })

  // Erlaubnis oder Rückfrage: ergibt die Prüfung „ask", wartet die Sitzung (nach kurzer Schonfrist) auf die Person.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    await still(async () => {
      if (e.agentId || r.decision !== 'ask' || e.approver !== 'person' || !e.tool_use_id) return
      const now = await $.clock.now()
      const id = e.tool_use_id
      await update($, eigenA, s => (s.braucht ? s : { ...s, braucht: { id, seit: now, verschachtelt: !!s.aufrufe[id] } }))
    })
    return r
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id
    const agentId = e.agentId
    let now = 0
    await still(async () => {
      void sicher($, cfg)
      now = await $.clock.now()
      const aufruf = { agentId, werkzeug: tool, ziel: zielAus(tool, e as unknown as Record<string, unknown>), start: now }
      // Rückfragen an die Person (AskUserQuestion, Plan-Freigabe) stehen im Aufruf selbst.
      const fragt = !agentId && (tool === 'AskUserQuestion' || tool === 'ExitPlanMode')
      await update($, eigenA, s => {
        const braucht = fragt ? { id, seit: now, verschachtelt: true } : s.braucht && s.braucht.id === id && !s.braucht.verschachtelt ? null : s.braucht
        const agents = agentId && s.agents[agentId] ? { ...s.agents, [agentId]: { ...s.agents[agentId]!, aktiv: now } } : s.agents
        return { ...s, braucht, agents, aufrufe: { ...s.aufrufe, [id]: aufruf } }
      })
    })
    try {
      return await next(e)
    } finally {
      await still(async () => {
        await update($, eigenA, s => {
          const { [id]: _weg, ...aufrufe } = s.aufrufe
          return { ...s, aufrufe, braucht: s.braucht && s.braucht.id === id ? null : s.braucht }
        })
      })
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void sicher($, cfg) // nach einem Neuladen der Mod startet das Zeichnen die Zeitgeber wieder
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Raster = 'Raster' in t ? t.Raster : null
    const Input = 'Input' in t ? t.Input : null
    const alle = await read($, alleA)
    const jetzt = (await read($, jetztA)) || (await $.clock.now())
    const auswahl = await read($, auswahlA)
    const aktion = await read($, aktionA)
    const eingabe = await read($, eingabeA)
    const stopp = await read($, stoppA)
    const meldung = await read($, meldungA)
    const eigeneId = await $.session.id().catch(() => '')
    const a = baueAnsicht({
      jetzt,
      breite: Math.max(20, e.props.bodyColumns - RAND_RECHTS), // Luft am rechten Rand: Zahlen kleben sonst an der Kante
      hoehe: e.props.scroll?.bodyRows ?? null,
      eigeneId,
      sitzungen: alle,
      auswahl,
      aktion,
      eingabe,
      stoppBitte: stopp,
      meldung,
      raster: Raster !== null,
      bildMs: BILD_MS,
    })
    letztesBild = a.crew ? { figuren: a.crew.figuren, spalten: a.crew.spalten } : null
    letzteZellen = ''

    const textRuns = (key: string, segs: Seg[]) =>
      verschmelzen(segs).map((s, i) => (
        <Text key={`${key}.${i}`} color={s.c} dimColor={s.dim ? true : undefined} weight={s.b ? 'bold' : undefined}>
          {s.t}
        </Text>
      ))
    const zeileText = (key: string, segs: Seg[]) => (
      <Text key={key} wrap="truncate-end">
        {textRuns(key, segs)}
      </Text>
    )
    const rasterEl = (key: string, z: { spalten: number; zeilen: number; kodiere: () => string }) =>
      Raster ? <Raster key={key} columns={z.spalten} rows={z.zeilen} cells={z.kodiere()} /> : null

    const eingabeFeld = (ziel: LeitstandZiel) =>
      Input ? (
        <Input
          key={`e-${ziel.id}`}
          label="Nachricht: "
          placeholder="kurzer Text, Enter schickt"
          submitLabel="senden"
          autoFocus
          onSubmit={(text: string) => void nachrichtSenden($, ziel, text).catch(() => undefined)}
        />
      ) : null

    const zeile = (z: Zeile, i: number) => {
      const key = `z${i}`
      switch (z.art) {
        case 'text':
          return zeileText(key, z.segs)
        case 'knopf':
          return (
            <Button key={z.key} plain onPress={() => void waehlen($, z.ziel).catch(() => undefined)}>
              {verschmelzen(z.segs).map((s, j) => (
                <Text key={`${key}.${j}`} color={s.c} dimColor={s.dim ? true : undefined} weight={s.b ? 'bold' : undefined}>
                  {s.t}
                </Text>
              ))}
            </Button>
          )
        case 'raster':
          return rasterEl(z.key, z.raster)
        case 'block':
          return (
            <Box key={z.key} flexDirection="row">
              <Box flexDirection="column">{z.links.map((l, j) => zeileText(`${key}l${j}`, l))}</Box>
              {rasterEl(`${z.key}-raster`, z.raster)}
              <Box flexDirection="column">{z.rechts.map((r, j) => zeileText(`${key}r${j}`, r))}</Box>
            </Box>
          )
        case 'aktionen':
          return (
            <Box key={`a-${z.ziel.id}`} gap={2}>
              <Text>{' '.repeat(z.einrueck)}</Text>
              {z.darfNachricht && (
                <Button key={`n-${z.ziel.id}`} plain hotkey="n" onPress={() => void update($, eingabeA, cur => (cur && cur.id === z.ziel.id ? null : z.ziel)).catch(() => undefined)}>
                  Nachricht
                </Button>
              )}
              {z.darfStopp && (
                <Button key={`s-${z.ziel.id}`} plain hotkey="s" onPress={() => void stoppKlick($, z.ziel, eigeneId).catch(() => undefined)}>
                  {z.stoppBitte ? 'Sicher? Nochmal s' : 'Stopp'}
                </Button>
              )}
            </Box>
          )
        case 'eingabe':
          return eingabeFeld(z.ziel)
      }
    }

    return <Box flexDirection="column">{a.zeilen.map(zeile)}</Box>
  })
}
