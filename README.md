# claude-mods

Ein Modpack für [Claude Code](https://claude.com/claude-code) **ab Version 2.1.289**. Die Mods ändern Claude Code selbst
(Band über dem Prompt, eigene Bereiche, Hooks auf Werkzeugaufrufe) und haben ein gemeinsames Ziel:
**besser mit KI arbeiten, schneller und mit weniger Tokens.**

*A mod pack for Claude Code ≥ 2.1.289: see every session and subagent at a glance, get stopped before an expensive
cold-cache rebuild, make subagents pick a model on purpose, route search agents to Haiku, keep parallel sessions from
overwriting each other, and keep your Mac awake without spending tokens. UI texts are German.*

## Installation

```bash
claude plugin marketplace add fbrogno/claude-mods
claude plugin install agent-radar@claude-mods
claude plugin install brain-mods@claude-mods
claude plugin install wachhalter@claude-mods
```

Danach Claude Code neu starten. Einstellungen je Mod findest du im Konfigurationsmenü (`/config`).

## Wo die Tokens wirklich hingehen

Jeder Schritt in Claude Code schickt den ganzen bisherigen Verlauf erneut ans Modell. Der Prompt-Cache macht das
billig, aber nur, solange er warm ist. Daraus ergeben sich drei Kostentreiber, die man im Alltag kaum sieht:

1. **Großer Kontext:** Bei 600k Kontext kostet jeder einzelne Schritt das Sechsfache eines Schritts bei 100k.
   Lange Sitzungen ohne Kompaktierung werden so mit jedem Schritt teurer.
2. **Kalter Cache:** Nach einer Pause muss der ganze Verlauf neu in den Cache geschrieben werden. Bei Claude Opus 5.5
   kostet das Schreiben (1 h Gültigkeit) 40-mal so viel wie das Lesen: Ein einziger Prompt nach der Pause kostet so viel
   wie rund 40 normale Schritte.
3. **Subagents:** Jeder Subagent startet mit dem kompletten Grundkontext (System, Werkzeuge, Skills, CLAUDE.md) und
   läuft ohne Modellangabe auf dem teuren Hauptmodell.

Die Mods setzen genau dort an.

## Die Mods

### agent-radar

Alle Claude-Code-Sitzungen und Subagents auf einen Blick, plus Wächter gegen die teuersten Muster.

- **Alle Sitzungen:** Jede Sitzung meldet alle 15 s ihren Stand in einen gemeinsamen lokalen Speicher, nur lokal und
  ohne Netzwerk. Das Band über dem Prompt zeigt die anderen Sitzungen: „Sitzungen: 1 arbeitet (2 Agents) · 1 fertig:
  backend vor 4:00“. So siehst du sofort, wo eine Antwort auf dich wartet.
- **`/agents`:** ein Bereich mit allen Sitzungen (arbeitet / fertig / wartet, Projektordner, Modell, Kontextgröße,
  Cache-Restzeit, letzte Aufgabe, laufende Agents), den Agents dieser Sitzung (Status, Modell, Dauer, Tools, Tokens,
  Summe je Modell) und deinen Nutzungslimits.
- **Kaltstart-Wächter:** Schickst du bei kaltem Cache und großem Kontext einen Prompt, fragt der Mod vorher nach und
  nennt die Kosten des Neuaufbaus. „Frische Sitzung“ hält den Prompt zurück, und nach `/clear` steht er wieder im
  Eingabefeld. Nach `/resume` erkennt der Mod den kalten Cache ebenfalls.
- **Pausen-Hinweis:** Kurz bevor der Cache abläuft, zeigt das Band bei großem Kontext die Kosten des Neuaufbaus und
  einen Knopf „Stand sichern“ (startet `/handoff`, falls vorhanden). Danach `/clear`, und nach der Pause geht es billig
  weiter.
- **Modellwahl-Pflicht:** `general-purpose`-Subagents ohne Modellangabe werden abgelehnt, mit der Bitte, bewusst zu
  wählen: haiku (suchen, sichten, prüfen), sonnet (umsetzen nach Plan, Tests) oder opus (Architektur, Reviews).
  Forks, Teammates und Plugin-Agents mit eigenem Modell sind ausgenommen.
- **Explore-Agents auf Haiku:** Reine Such-Agents (Typ `Explore`) ohne Modellangabe laufen auf Haiku.

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `kalt_waechter` | `true` | Vor teuren Prompts bei kaltem Cache nachfragen |
| `kalt_schwelle_k` | `200` | Ab dieser Kontextgröße (Tausend Tokens) fragt der Wächter und warnt vor Pausen |
| `modell_pflicht` | `true` | general-purpose-Subagents nur mit ausdrücklichem Modell |
| `explore_auf_haiku` | `true` | Explore-Agents ohne Modellangabe auf Haiku |
| `cache_minuten` | `60` | Lebensdauer des Prompt-Caches nach der letzten Antwort |
| `cache_warnung_minuten` | `10` | Ab dieser Restzeit erscheint der Pausen-Hinweis |

Die Dollarbeträge sind API-Listenpreise. Bei einem Abo sind sie ein Maß für den Limit-Verbrauch, kein Rechnungsbetrag.

### brain-mods

Drei Helfer, die keine Tokens kosten und nur lokal arbeiten.

- **Kollisionsschutz:** Arbeiten mehrere Claude-Code-Sitzungen parallel, fragt der Mod nach, bevor eine Sitzung eine
  Datei ändert, die eine andere in den letzten 30 Minuten bearbeitet hat. Dasselbe gilt vor `git stash`,
  `git reset --hard` und `git checkout -- .` im selben Repo.
- **Kontext-Anzeige:** Kontextgröße über dem Prompt mit festen Schwellen: gelb ab 200k, rot ab 350k Tokens (bei
  kleinen Fenstern zusätzlich ab 60 / 80 % Füllung). Ab Rot ein Hinweis „Stand sichern, dann /clear“ und der Knopf
  „Stand sichern“ (startet einen `/handoff`-Skill, falls vorhanden). Befehl `/kontext`.
- **Brain-Band:** Stand eines lokalen Second Brain (`~/brain` mit `.tools/brain-stand.mjs`). Ohne ein solches
  Brain bleibt diese Zeile einfach aus. Abschaltbar über `brainband`.

### wachhalter

`/wach` hält den Mac per `caffeinate -dims` wach, direkt ohne Umweg über das Modell, also ohne Tokens.

- `/wach 1` · `/wach 1,5 std` · `/wach 30m`: wach für diese Dauer (höchstens 24 h)
- `/wach aus`: beenden
- `/wach`: wie lange noch

Solange der Mac wach gehalten wird, steht die Restzeit in der Statuszeile.

## Empfohlene Einstellungen dazu

Diese offiziellen Einstellungen von Claude Code ergänzen die Mods (Stand 2.1.289):

| Ziel | Einstellung |
|---|---|
| Kontext klein halten | Auto-Compact einschalten und früher auslösen: `"autoCompactWindow": 300000` (Auto-Compact muss an sein, `autoCompactEnabled` nicht `false`) |
| Subagents ohne Modellangabe günstiger | `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" }` (gilt auch für Workflow-Agents; ein ausdrücklich gesetztes Modell gewinnt) |
| Kein Warten auf Sound-Hooks | Stop-Hook mit `"async": true` |
| Connectoren wirklich abschalten | `/mcp` je Projekt, `deniedMcpServers` oder `disableClaudeAiConnectors`. **Achtung:** `disabledMcpjsonServers` wirkt nur auf Server aus einer projekteigenen `.mcp.json`, nicht auf claude.ai-Connectoren oder User-Server |
| Skill-Liste verkleinern | `"skillOverrides": { "<skill>": "name-only" \| "off" }`, Kosten je Skill zeigt `/skill-doctor` |

## Empfehlung: Arbeit verteilen

Die Mods wirken am besten zusammen mit einer Regel in deiner `~/.claude/CLAUDE.md`, zum Beispiel:

```markdown
## Arbeit verteilen
- Das Gespräch mit mir führt immer das Hauptmodell; es plant, entscheidet und prüft jedes Ergebnis.
- Klar umrissene Teilaufgaben gehen an Subagents mit passendem Modell:
  haiku = suchen, sichten, prüfen · sonnet = Umsetzung nach Plan, Tests · opus = Architektur, Debugging, Reviews.
- Breite Suche nie im Hauptkontext, sondern per Explore-Subagent.
- Ab ~250k Kontext an einem natürlichen Abschnitt Stand sichern und frisch weitermachen; vor Pausen > 30 min ebenso.
```

## Weitere empfehlenswerte Mods

- **blast-radius**: hält riskante Shell-Befehle an und zeigt vorher, was sie ändern würden. Aus
  [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground), Ordner
  `claude-code/mods/blast-radius`.

## Entwickeln

```bash
claude plugin validate plugins/agent-radar
claude plugin test plugins/agent-radar
```

Zum Ausprobieren ohne Installation: `claude --plugin-dir plugins/agent-radar`.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
