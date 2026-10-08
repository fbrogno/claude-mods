export type AgentStand = 'läuft' | 'fertig' | 'abgebrochen' | 'fehler'

export type AgentZeile = {
  id: string
  beschreibung: string
  typ: string
  modell: string
  gestartet: number
  beendet: number | null
  tools: number
  tokens: number
  stand: AgentStand
}

/** Was eine Sitzung über sich in den gemeinsamen Speicher schreibt (Schlüssel `radar:<id>`). */
export type SitzungsStand = {
  id: string
  ort: string
  aufgabe: string
  modell: string
  arbeitet: boolean
  /** Beginn des laufenden Turns bzw. Ende des letzten. */
  seit: number
  /** Kontextgröße in Tokens (nicht Prozent — bei 1M-Fenstern sagt Prozent zu wenig). */
  kontext: number | null
  letzteAntwort: number | null
  agents: Array<{ modell: string; beschreibung: string; gestartet: number; tools: number }>
  agentTokens: number
  limits: Array<{ art: string; prozent: number }>
  herz: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-radar': {
      agents: AgentZeile[]
      letzteAntwort: number | null
      jetzt: number
      sitzungen: SitzungsStand[]
      eigeneId: string
      kontextTokens: number | null
    }
  }
}
