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

declare module 'claude-code' {
  interface PluginState {
    'agent-radar': {
      agents: AgentZeile[]
      letzteAntwort: number | null
      jetzt: number
    }
  }
}
