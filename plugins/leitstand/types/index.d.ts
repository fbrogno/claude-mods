/**
 * Leitstand 0.3: die Formen der Daten, die die Mod hält (Zustand im Host) und in
 * ~/.claude-leitstand/sitzungen/<sessionId>.json ablegt.
 *
 * Grundsatz: nur gemessene Werte stehen als Zahl. Was die Mod schätzt, ist in den
 * Typen als solches benannt (kalt/warm, Ersparnis) und wird in der Anzeige mit „≈" markiert.
 */

/** Gezählte Anfragen (`turn.step`) und die vier Token-Zahlen, wie die API sie meldet. */
export type LeitstandZaehler = {
  anfragen: number
  /** Eingabe-Token ohne Cache (`input_tokens`). */
  eingabe: number
  /** Aus dem Cache gelesen (`cache_read_input_tokens`). */
  cacheLesen: number
  /** In den Cache geschrieben (`cache_creation_input_tokens`). */
  cacheSchreiben: number
  ausgabe: number
}

export type LeitstandStand = 'laeuft' | 'wartet' | 'fertig' | 'fehler'
export type LeitstandArt = 'agent' | 'fork' | 'workflow' | 'teammate'

/** Ein Subagent (auch Workflow-Agent, Fork, Teammate) einer Sitzung. */
export type LeitstandAgent = {
  id: string
  /** Kurzer Name (Beschreibung des Auftrags), höchstens 60 Zeichen. */
  name: string
  /** Agent-Typ (Explore, general-purpose, ...). */
  typ: string
  art: LeitstandArt
  /** Modell-Bezeichnung wie „haiku 4.5"; leer, solange noch keine Anfrage gezählt wurde. */
  modell: string
  stand: LeitstandStand
  /** Aktuelles Werkzeug (nur der Name), null wenn gerade keines läuft. */
  werkzeug: string | null
  /** Gekürztes Ziel (höchstens 60 Zeichen, nie Befehlsinhalt). */
  ziel: string
  gestartet: number
  beendet: number | null
  /** Letzte Regung (Anfrage oder Werkzeug), für die Ruhe-Erkennung. */
  aktiv: number
  /** Gezählt aus den Anfragen dieses Agents. */
  z: LeitstandZaehler
}

export type LeitstandZustand = 'arbeitet' | 'wartet' | 'braucht' | 'abgebrochen' | 'fehler' | 'ruht'

export type LeitstandLimit = {
  /** five_hour, seven_day oder was der Host meldet. */
  art: string
  /** 0 bis 100. */
  prozent: number
  /** Zeitpunkt des Zurücksetzens (ms), falls gemeldet. */
  reset: number | null
}

/** Inhalt von ~/.claude-leitstand/sitzungen/<sessionId>.json (Format 2, seit 0.3 mit `titel`). */
export type LeitstandSitzung = {
  v: 2
  sessionId: string
  /** Name des Konfig-Ordners (.claude, .claude-firma2). */
  profil: string
  projekt: string
  /** Titel der Sitzung (aus den classic-Ereignissen `UserPromptSubmit`/`SessionStart`), auf 40 Zeichen gekürzt; null, solange der Host keinen nannte. */
  titel: string | null
  /** Modell der Hauptschleife als Bezeichnung („opus 5.5"). */
  modell: string
  kontextProzent: number | null
  /** Beginn der Sitzung laut Host (`session.usage().startedAt`). */
  gestartet: number | null
  /** Seit wann die Mod zählt (erster gezählter Schritt des Tages); null = noch nichts gezählt. */
  zaehlSeit: number | null
  /** Tag (JJJJ-MM-TT, lokal), auf den sich Zähler und Tageskosten beziehen. */
  tag: string
  /** Gezählt ab Tagesbeginn bzw. Zählbeginn: Summe aus Hauptschleife und Subagents. */
  gesamt: LeitstandZaehler
  /** Davon die Hauptschleife allein (ohne Subagents). */
  haupt: LeitstandZaehler
  /** Dasselbe je Modell (Schlüssel: Bezeichnung wie „opus 5.5"). */
  modelle: Record<string, LeitstandZaehler>
  /** Kosten der Sitzung seit ihrem Start in Dollar, wie /cost sie summiert (gemessen, inkl. Subagents). */
  kosten: number | null
  /** Davon heute angefallen (Kosten minus Stand zu Tagesbeginn); null ohne Messung. */
  kostenHeute: number | null
  /** Die Limits des Kontos (kontoweit) und der Stand der Messung: wann die Werte sich zuletzt änderten bzw. erstmals gesehen wurden. */
  limits: LeitstandLimit[]
  limitsZeit: number | null
  letzteAntwort: number | null
  zustand: LeitstandZustand
  zustandSeit: number
  werkzeug: string | null
  ziel: string
  agents: LeitstandAgent[]
  /** Zeitpunkt des Sitzungsendes; null solange sie läuft. */
  beendet: number | null
  herz: number
}

export type LeitstandAufruf = { agentId?: string; werkzeug: string; ziel: string; start: number }

/** Eigener Laufzeitstand dieser Sitzung (überlebt ein Neuladen im Host-Zustand). */
export type LeitstandEigen = {
  /** Wurde der Stand schon aus einer vorhandenen Datei derselben Sitzung ergänzt? */
  geladen: boolean
  /** Titel der Sitzung, wie der Host ihn zuletzt nannte (nur gelesen, nie verändert). */
  titel: string | null
  /** Zuletzt gelesene Limits und wann sie sich zuletzt geändert haben (= Stand der Messung). */
  limits: LeitstandLimit[]
  limitsZeit: number | null
  tag: string
  zaehlSeit: number | null
  gesamt: LeitstandZaehler
  modelle: Record<string, LeitstandZaehler>
  /** Hauptschleife zählt noch einmal gesondert (für die Crew-Zeile „Haupt"). */
  haupt: LeitstandZaehler
  arbeitet: boolean
  /** Wie der letzte Zug endete (gilt, solange nichts arbeitet). */
  ende: 'wartet' | 'abgebrochen' | 'fehler'
  /** Seit wann der aktuelle Zustand gilt. */
  seit: number
  letzteAntwort: number | null
  turnId: string | null
  /**
   * Eine Erlaubnis oder Rückfrage wartet auf die Person (`tool.check` ergab „ask" oder das Werkzeug ist eine Rückfrage).
   * `verschachtelt`: der Werkzeugaufruf lief schon, als gefragt wurde; dann endet das Warten mit dem Aufruf, sonst mit seinem Beginn.
   */
  braucht: { id: string; seit: number; verschachtelt: boolean } | null
  /** Zeitpunkt der letzten gezählten Anfrage (Hauptschleife oder Subagent). */
  letzterSchritt: number | null
  aufrufe: Record<string, LeitstandAufruf>
  /** Agents, die der Host in `$.agent.list()` schon einmal nannte. */
  gesehen: Record<string, true>
  agents: Record<string, LeitstandAgent>
  kostenBasis: { tag: string; usd: number } | null
  /** Nach /clear: die erste Messung der neuen Sitzung ist die Basis (egal, ob das Kostenbuch bei null beginnt oder weiterläuft). */
  nachClear: boolean
}

export type LeitstandZiel = { art: 'sitzung'; id: string } | { art: 'agent'; id: string }

declare module 'claude-code' {
  interface PluginState {
    leitstand: {
      eigen3: LeitstandEigen
      /** Alle Sitzungen von heute (laufende und beendete), wie zuletzt gelesen. */
      alle3: LeitstandSitzung[]
      jetzt: number
      offen: boolean
      /** Gewählte Sitzung (Umfang von Kacheln, Modellen, Crew); null = alle. */
      auswahl: string | null
      /** Ziel für Nachricht und Stopp. */
      aktion: LeitstandZiel | null
      /** Ziel, an das gerade eine Nachricht getippt wird. */
      eingabe: LeitstandZiel | null
      /** Stopp-Knopf, der einmal gedrückt wurde und 5 s auf die Bestätigung wartet. */
      stoppBitte: { ziel: string; bis: number } | null
      meldung: string
    }
  }
}
