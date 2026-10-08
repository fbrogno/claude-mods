// brain-mods — drei Mods für Claude Code (ab 2.1.287), 0 Tokens, nur lokale Dateien/Prozesse, kein Netzwerk:
//   1) Kollisionsschutz: Datei-Ansprüche paralleler Sitzungen im gemeinsamen $.store; Dialog vor dem Schreiben
//      einer Datei, die eine andere lebende Sitzung in den letzten 30 min bearbeitet hat, und vor
//      git stash / reset --hard / checkout -- . im selben Repo.
//   2) Kontext-Anzeige: Kontextfüllung (aus $.session.usage()) im Band über dem Prompt, Knopf „Stand sichern“
//      (startet /handoff), ab 80 % einmalig ein Hinweis; Befehl /kontext.
//   3) Brain-Band: Brain-Stand wie die Statusleiste (node <brain>/.tools/brain-stand.mjs) und die Brain-Seiten,
//      die der Hinweis-Hook zur letzten Frage gemeldet hat; Knopf „Gehirn öffnen“ (brain zeig).
// Fehlerpfad überall: durchlassen und still ins Debug-Log — Ausnahme ist nur der Kollisionsdialog selbst.
// Die Mods-API wird ausgeschrieben ($.namensraum.methode) und nur an Funktionen auf oberster Ebene übergeben,
// weil Claude Code das Modul statisch analysiert (claude plugin validate).
import {
  SCHLUESSEL_PRAEFIX, HERZ_MS, BRAIN_MS, ANSPRUCH_MS, FORTFAHREN, ABBRECHEN, HINWEIS_FAST_VOLL,
  normalisierePfad, werkzeugPfad, neuerEintrag, anspruchSetzen, herzschlag, istVerwaist,
  findeKollision, findeRepoKollision, kollisionsFrage, repoFrage, riskanterGitBefehl,
  kontextLesung, kontextZeile, kontextFarbe, kontextBefehlText, brainTeile, leseStandAusgabe, seitenName,
} from "./logik.mjs";

// ---- Zustand dieses Moduls (geht bei einem Neuladen verloren; der eigene Eintrag kommt aus $.store zurück) ----
let optionen = {};
let eigen = null; // eigener Sitzungs-Eintrag (Kollisionsschutz)
let freigaben = {}; // pfad → { id, bis }: schon mit „Fortfahren“ bestätigte Kollisionen
let lesung = null; // letzte Kontext-Messung
let hingewiesen = false; // 80-%-Hinweis schon gezeigt
let brainOrt = ""; // Vault-Pfad (~/brain oder userConfig brain_pfad)
let brain = null; // { stand, hinweis } aus brain-stand.mjs --json

const an = (schluessel) => optionen[schluessel] !== false;

export function register(on, options) {
  optionen = options || {};

  on("session.start", async ($, e, next) => {
    const ergebnis = await next(e);
    try {
      await starte($);
    } catch (fehler) {
      still($, "Start", fehler);
    }
    try {
      await $.command.register({ name: "kontext", description: "Kontextfüllung dieser Sitzung anzeigen (brain-mods)", immediate: true });
    } catch (fehler) {
      still($, "/kontext", fehler);
    }
    return ergebnis;
  });

  // Nach /clear, /resume, /branch hat die Sitzung eine neue ID, session.start feuert aber nicht erneut.
  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    try {
      lesung = null;
      hingewiesen = false;
      freigaben = {};
      if (an("kollisionsschutz")) await anmelden($);
      if (an("kontext")) await kontextMessen($);
      if (an("brainband")) await brainLesen($);
    } catch (fehler) {
      still($, "SessionStart", fehler);
    }
    return next(e);
  });

  // Nach /compact (manuell oder automatisch) sofort neu messen — sonst zeigt das Band bis zum nächsten Turn den alten Wert.
  on("classic.PostCompact", async ($, e, next) => {
    const ergebnis = await next(e);
    try {
      if (an("kontext")) await kontextMessen($);
    } catch (fehler) {
      still($, "PostCompact", fehler);
    }
    return ergebnis;
  });

  on("session.end", async ($, e, next) => {
    try {
      if (eigen) await $.store.delete(SCHLUESSEL_PRAEFIX + eigen.id);
      eigen = null;
    } catch (fehler) {
      still($, "Abmelden", fehler);
    }
    return next(e);
  });

  // ---- Mod 1: Kollisionsschutz ----
  on("tool.call", { tool: ["Edit", "Write", "MultiEdit", "NotebookEdit"] }, async ($, e, next) => {
    if (!an("kollisionsschutz")) return next(e);
    let pruefung;
    try {
      pruefung = await dateiPruefen($, e);
    } catch (fehler) {
      still($, "Dateiprüfung", fehler);
      return next(e);
    }
    if (pruefung.kollision) {
      const antwort = await fragen($, kollisionsFrage(pruefung.kollision));
      if (antwort !== FORTFAHREN) {
        return { deny: `Abgebrochen (brain-mods): ${pruefung.pfad} wird gerade auch in Sitzung ${pruefung.kollision.kurz} bearbeitet. Frag den Nutzer, wie es weitergehen soll, bevor du die Datei erneut änderst.` };
      }
      freigaben[pruefung.pfad] = { id: pruefung.kollision.id, bis: pruefung.jetzt + ANSPRUCH_MS };
    }
    try {
      await beanspruchen($, pruefung.pfad, pruefung.jetzt);
    } catch (fehler) {
      still($, "Anspruch", fehler);
    }
    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (!an("kollisionsschutz")) return next(e);
    const befehl = riskanterGitBefehl(e.command);
    if (!befehl) return next(e);
    let kollision = null;
    try {
      kollision = await repoPruefen($);
    } catch (fehler) {
      still($, "Repo-Prüfung", fehler);
      return next(e);
    }
    if (!kollision) return next(e);
    const antwort = await fragen($, repoFrage(kollision, befehl));
    if (antwort !== FORTFAHREN) {
      return { deny: `Abgebrochen (brain-mods): ${befehl} hätte Arbeit von Sitzung ${kollision.kurz} im selben Repo treffen können (geteilter Stash/Arbeitsbaum). Frag den Nutzer, bevor du es erneut versuchst.` };
    }
    return next(e);
  });

  // ---- Mod 2 + 3: nach jedem Turn neu messen ----
  on("turn.complete", async ($, e, next) => {
    const ergebnis = await next(e);
    if (e.agentId) return ergebnis;
    try {
      if (an("kontext")) await kontextMessen($);
      if (an("brainband")) await brainLesen($);
    } catch (fehler) {
      still($, "Turn-Messung", fehler);
    }
    return ergebnis;
  });

  on("command.run", { command: "kontext" }, async ($) => {
    try {
      await kontextMessen($);
    } catch (fehler) {
      still($, "/kontext", fehler);
    }
    return { text: kontextBefehlText(lesung) };
  });

  // ---- Band über dem Prompt: Kontextzeile (Mod 2), Brain-Zeile und Hinweis-Seiten (Mod 3) ----
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const props = e.props || {};
    if (props.hasSurvey) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const zeilen = [];

    if (an("kontext") && lesung) {
      const teile = [Text({ key: "kontext-wert", color: kontextFarbe(lesung.prozent), bold: true, children: [kontextZeile(lesung)] })];
      if (lesung.prozent >= 80) teile.push(Text({ key: "kontext-voll", color: "red", children: [HINWEIS_FAST_VOLL] }));
      teile.push(Button({ key: "stand-sichern", label: "Stand sichern", onPress: () => { standSichern($); } }));
      zeilen.push(Box({ key: "zeile-kontext", flexDirection: "row", columnGap: 2, children: teile }));
    }

    if (an("brainband") && brain) {
      const teile = brainTeile(brain.stand).map((t, i) => Text({ key: `brain-${i}`, ...(t.farbe === "gray" ? { dimColor: true } : { color: t.farbe }), children: [i === 0 ? t.text : `· ${t.text}`] }));
      teile.push(Button({ key: "gehirn-oeffnen", label: "Gehirn öffnen", onPress: () => { gehirnOeffnen($); } }));
      zeilen.push(Box({ key: "zeile-brain", flexDirection: "row", columnGap: 1, children: teile }));
      const seiten = brain.hinweis?.seiten || [];
      if (seiten.length) {
        zeilen.push(Text({ key: "zeile-hinweis", dimColor: true, wrap: "truncate-end", children: [`Hinweis zur letzten Frage: ${seiten.map(seitenName).join(" · ")}`] }));
      }
    }

    if (!zeilen.length) return next(e);
    const andere = await next(e);
    if (andere) zeilen.push(andere);
    return Box({ flexDirection: "column", paddingX: 1, children: zeilen });
  });
}

// ---- Start ---------------------------------------------------------------------------------------------

async function starte($) {
  if (an("brainband")) brainOrt = await findeBrain($);
  if (an("kollisionsschutz")) {
    await anmelden($);
    $.clock.every(HERZ_MS, () => herz($));
  }
  if (an("kontext")) await kontextMessen($);
  if (an("brainband") && brainOrt) {
    await brainLesen($);
    $.clock.every(BRAIN_MS, () => brainLesen($));
  }
}

// Der Vault: userConfig brain_pfad, sonst <Home>/brain. Gilt nur, wenn dort .tools/brain-stand.mjs liegt.
async function findeBrain($) {
  let ort = String(optionen.brain_pfad || "").trim();
  if (!ort) {
    const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
    if (!home) return "";
    ort = `${home}/brain`;
  }
  ort = normalisierePfad(ort);
  return (await $.fs.exists(`${ort}/.tools/brain-stand.mjs`)) ? ort : "";
}

function still($, wo, fehler) {
  try {
    $.ui.log(`brain-mods ${wo}: ${String(fehler?.message ?? fehler).slice(0, 200)}`, { to: "debug" });
  } catch {
    // auch das Loggen darf nie stören
  }
}

// ---- Mod 1 ---------------------------------------------------------------------------------------------

async function anmelden($) {
  const id = await $.session.id();
  const jetzt = await $.clock.now();
  const cwd = await $.session.cwd();
  let repo = "";
  try {
    repo = (await $.session.repo())?.root || "";
  } catch {
    repo = "";
  }
  const alt = await $.store.get(SCHLUESSEL_PRAEFIX + id);
  eigen = alt && typeof alt === "object" && alt.id === id
    ? { ...herzschlag(alt, jetzt), cwd, repo: normalisierePfad(repo) }
    : neuerEintrag(id, { cwd, repo: repo ? normalisierePfad(repo) : "", jetzt });
  await $.store.set(SCHLUESSEL_PRAEFIX + id, eigen);
  // Verwaiste Einträge (abgestürzte Sitzungen ohne Abmeldung) wegräumen.
  for (const schluessel of await $.store.keys()) {
    if (!schluessel.startsWith(SCHLUESSEL_PRAEFIX) || schluessel === SCHLUESSEL_PRAEFIX + id) continue;
    if (istVerwaist(await $.store.get(schluessel), jetzt)) await $.store.delete(schluessel);
  }
}

async function herz($) {
  try {
    if (!eigen) return;
    eigen = herzschlag(eigen, await $.clock.now());
    await $.store.set(SCHLUESSEL_PRAEFIX + eigen.id, eigen);
  } catch (fehler) {
    still($, "Herzschlag", fehler);
  }
}

async function andereEintraege($) {
  const out = [];
  for (const schluessel of await $.store.keys()) {
    if (!schluessel.startsWith(SCHLUESSEL_PRAEFIX)) continue;
    if (eigen && schluessel === SCHLUESSEL_PRAEFIX + eigen.id) continue;
    const eintrag = await $.store.get(schluessel);
    if (eintrag && typeof eintrag === "object") out.push(eintrag);
  }
  return out;
}

async function dateiPruefen($, e) {
  if (!eigen) await anmelden($);
  const jetzt = await $.clock.now();
  const pfad = normalisierePfad(werkzeugPfad(e), await $.session.cwd());
  if (!pfad || pfad === "/") return { pfad: "", jetzt, kollision: null };
  const kollision = findeKollision(eigen.id, pfad, await andereEintraege($), jetzt);
  const frei = freigaben[pfad];
  if (kollision && frei && frei.id === kollision.id && frei.bis > jetzt) return { pfad, jetzt, kollision: null };
  return { pfad, jetzt, kollision };
}

async function beanspruchen($, pfad, jetzt) {
  if (!pfad || !eigen) return;
  eigen = anspruchSetzen(eigen, pfad, jetzt);
  await $.store.set(SCHLUESSEL_PRAEFIX + eigen.id, eigen);
}

async function repoPruefen($) {
  if (!eigen) await anmelden($);
  if (!eigen.repo) return null;
  return findeRepoKollision(eigen.id, eigen.repo, await andereEintraege($), await $.clock.now());
}

// Der Kollisionsdialog. Ohne Oberfläche (claude -p, SDK) ist niemand zu fragen → durchlassen und loggen.
// Weggeklickt oder „Chat about this“ → Abbrechen (sichere Seite).
async function fragen($, frage) {
  let oberflaechen = [];
  try {
    oberflaechen = await $.session.surfaces();
  } catch {
    oberflaechen = [];
  }
  if (!oberflaechen.length) {
    still($, "Kollision ohne Oberfläche", frage);
    return FORTFAHREN;
  }
  try {
    return await $.ui.ask(frage, [FORTFAHREN, ABBRECHEN]);
  } catch {
    return ABBRECHEN;
  }
}

// ---- Mod 2 ---------------------------------------------------------------------------------------------

async function kontextMessen($) {
  const { context } = await $.session.usage();
  lesung = kontextLesung(context);
  if (lesung && lesung.prozent >= 80 && !hingewiesen) {
    hingewiesen = true;
    $.ui.toast(HINWEIS_FAST_VOLL, { timeoutMs: 8000 });
  }
  if (lesung && lesung.prozent < 60) hingewiesen = false; // nach Kompaktierung wieder scharf
  $.ui.invalidate("ui.render");
}

// „Stand sichern“: den vorhandenen Handoff-Ablauf starten (/handoff), sonst als Bitte an Claude.
async function standSichern($) {
  try {
    await $.command.run({ command: "handoff", args: "" });
  } catch {
    try {
      await $.prompt.submit({ text: "Bitte sichere jetzt den Arbeitsstand mit dem Skill handoff." });
    } catch (fehler) {
      $.ui.toast("Stand sichern ging nicht — bitte /handoff eintippen.");
      still($, "Stand sichern", fehler);
    }
  }
}

// ---- Mod 3 ---------------------------------------------------------------------------------------------

async function brainLesen($) {
  try {
    if (!brainOrt) return;
    const sid = eigen?.id || (await $.session.id());
    const lauf = await $.process.run(["node", `${brainOrt}/.tools/brain-stand.mjs`, "--json", `--sid=${sid}`], { cwd: brainOrt, timeoutMs: 8000 });
    if (lauf.exitCode !== 0) return;
    const neu = leseStandAusgabe(lauf.stdout);
    if (!neu) return;
    brain = neu;
    $.ui.invalidate("ui.render");
  } catch (fehler) {
    still($, "Brain-Stand", fehler);
  }
}

async function gehirnOeffnen($) {
  try {
    if (!brainOrt) {
      $.ui.toast("Brain nicht gefunden (~/brain oder Plugin-Option brain_pfad).");
      return;
    }
    const lauf = await $.process.run(["node", `${brainOrt}/.tools/brain.mjs`, "zeig"], { cwd: brainOrt, timeoutMs: 30000 });
    $.ui.toast(lauf.exitCode === 0 ? "Gehirn geöffnet." : "Gehirn öffnen ging nicht — im Terminal: brain zeig");
  } catch (fehler) {
    $.ui.toast("Gehirn öffnen ging nicht — im Terminal: brain zeig");
    still($, "Gehirn öffnen", fehler);
  }
}
