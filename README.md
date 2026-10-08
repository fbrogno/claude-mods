# claude-mods

Ein Modpack für [Claude Code](https://claude.com/claude-code) **ab Version 2.1.289**. Die Mods ändern Claude Code selbst
(Band über dem Prompt, eigene Bereiche, Hooks auf Werkzeugaufrufe) und haben ein gemeinsames Ziel:
**besser mit KI arbeiten, schneller und mit weniger Tokens.**

*A mod pack for Claude Code ≥ 2.1.289: see what your subagents are doing, route search agents to Haiku, get warned
before the prompt cache goes cold, and keep parallel sessions from overwriting each other. UI texts are German.*

## Installation

```bash
claude plugin marketplace add fbrogno/claude-mods
claude plugin install agent-radar@claude-mods
claude plugin install brain-mods@claude-mods
```

Danach Claude Code neu starten. Einstellungen je Mod findest du im Konfigurationsmenü (`/config`).

## Die Mods

### agent-radar

Zeigt alle Claude-Code-Sitzungen auf deinem Rechner und was ihre Subagents gerade tun und kosten.

- **Alle Sitzungen:** Jede Sitzung mit agent-radar meldet alle 15 s ihren Stand in einen gemeinsamen lokalen
  Speicher, nur lokal und ohne Netzwerk. Das Band über dem Prompt zeigt die anderen Sitzungen: „Sitzungen: 1 arbeitet
  (2 Agents) · 1 fertig: backend vor 4:00“. So siehst du sofort, wo eine Antwort auf dich wartet.
- **`/agents`** öffnet einen Bereich mit allen Sitzungen (arbeitet / fertig / wartet, Projektordner, Modell,
  Kontextfüllung, Cache-Restzeit, letzte Aufgabe, laufende Agents) und den Agents dieser Sitzung (Status, Modell,
  Dauer, Tools, Tokens, Summe je Modell) sowie deine Nutzungslimits.
- **Explore-Agents auf Haiku:** Reine Such-Agents (Typ `Explore`) ohne eigene Modellangabe laufen auf Haiku statt
  auf dem teuren Hauptmodell. Das Hauptgespräch bleibt unverändert. Abschaltbar.
- **Cache-Warnung:** Der Prompt-Cache hält nach der letzten Antwort nur eine begrenzte Zeit. Kurz vor Ablauf
  erscheint ein Hinweis, danach eine Warnung: Der nächste Prompt lädt den ganzen Verlauf neu, und das ist teuer.

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `explore_auf_haiku` | `true` | Explore-Agents ohne Modellangabe auf Haiku |
| `cache_minuten` | `60` | Lebensdauer des Prompt-Caches nach der letzten Antwort |
| `cache_warnung_minuten` | `10` | Ab dieser Restzeit erscheint die Cache-Anzeige |

### brain-mods

Drei Helfer, die keine Tokens kosten und nur lokal arbeiten.

- **Kollisionsschutz:** Arbeiten mehrere Claude-Code-Sitzungen parallel, fragt der Mod nach, bevor eine Sitzung eine
  Datei ändert, die eine andere in den letzten 30 Minuten bearbeitet hat. Dasselbe gilt vor `git stash`,
  `git reset --hard` und `git checkout -- .` im selben Repo.
- **Kontext-Anzeige:** Füllung des Kontextfensters über dem Prompt, ab 80 % ein Hinweis, Knopf „Stand sichern“
  (startet einen `/handoff`-Skill, falls vorhanden). Befehl `/kontext`.
- **Brain-Band:** Stand eines lokalen Second Brain (`~/brain` mit `.tools/brain-stand.mjs`). Ohne ein solches
  Brain bleibt diese Zeile einfach aus. Abschaltbar über `brainband`.

## Empfehlung dazu: Arbeit verteilen

Die Mods wirken am besten zusammen mit einer Regel in deiner `~/.claude/CLAUDE.md`, zum Beispiel:

```markdown
## Arbeit verteilen
- Das Gespräch mit mir führt immer das Hauptmodell; es plant, entscheidet und prüft jedes Ergebnis.
- Klar umrissene Teilaufgaben gehen an Subagents mit passendem Modell:
  haiku = suchen, sichten, prüfen · sonnet = Umsetzung nach Plan, Tests · Hauptmodell = Architektur, Debugging, Reviews.
- Breite Suche nie im Hauptkontext, sondern per Explore-Subagent.
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
