export type LeitstandStand = 'laeuft' | 'fertig' | 'fehler'
export type LeitstandZustand = 'arbeitet' | 'wartet' | 'ruht'

/** Ein Subagent (oder Workflow) einer Sitzung, wie er in der Herzschlag-Datei steht. */
export type LeitstandAgent = {
  id: string
  beschreibung: string
  /** Agent-Typ (Explore, general-purpose, workflow, ...). */
  typ: string
  /** haiku / sonnet / opus / fork / sonstiges Kürzel. */
  modell: string
  stand: LeitstandStand
  /** Aktuelles Werkzeug (nur der Name), null wenn gerade keines läuft. */
  werkzeug: string | null
  /** Gekürztes Ziel (höchstens 60 Zeichen, nie Befehlsinhalt). */
  ziel: string
  gestartet: number
  beendet: number | null
  tokens: number
  tools: number
}

/** Inhalt von ~/.claude-leitstand/sitzungen/<sessionId>.json */
export type LeitstandSitzung = {
  v: 1
  sessionId: string
  /** Name des Konfig-Ordners (.claude, .claude-firma2), falls ermittelbar. */
  profil?: string
  projekt: string
  modell: string
  kontextProzent: number | null
  letzteAntwort: number | null
  kosten: number | null
  zustand: LeitstandZustand
  werkzeug: string | null
  ziel: string
  seit: number
  agents: LeitstandAgent[]
  herz: number
}

export type LeitstandAufruf = { agentId?: string; werkzeug: string; ziel: string; start: number }

/** Eigener Laufzeitstand dieser Sitzung (überlebt ein Neuladen im Host-Zustand). */
export type LeitstandEigen = {
  arbeitet: boolean
  seit: number
  letzteAntwort: number | null
  turnId: string | null
  aufrufe: Record<string, LeitstandAufruf>
  agents: Record<string, LeitstandAgent>
}

export type LeitstandZiel = { art: 'sitzung'; id: string } | { art: 'agent'; id: string }

declare module 'claude-code' {
  interface PluginState {
    leitstand: {
      eigen: LeitstandEigen
      alle: LeitstandSitzung[]
      jetzt: number
      offen: boolean
      /** Ziel, an das gerade eine Nachricht getippt wird. */
      eingabe: LeitstandZiel | null
      /** Stopp-Knopf, der einmal gedrückt wurde und 5 s auf die Bestätigung wartet. */
      stoppBitte: { ziel: string; bis: number } | null
      meldung: string
    }
  }
}
