// brain-mods — reine Logik ohne Mods-API und ohne Node-APIs (läuft im Hooks-Modul UND unter `node --test`).
// Ansprüche/Verfall, Lebendigkeit, Kollisionsentscheidung, riskante git-Befehle, Kontext-Farbe, Band-Texte.

export const ANSPRUCH_MS = 30 * 60 * 1000; // Datei-Anspruch verfällt nach 30 min
export const TOT_MS = 3 * 60 * 1000; // ohne Herzschlag seit 3 min gilt eine Sitzung als tot
export const HERZ_MS = 60 * 1000; // Herzschlag-Takt
export const BRAIN_MS = 30 * 1000; // Brain-Band-Takt
export const SCHLUESSEL_PRAEFIX = "sitzung:";

export const SCHREIB_WERKZEUGE = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// ---- Pfade --------------------------------------------------------------------------------------------

// Normalisiert einen Pfad (POSIX und Windows-Trenner) gegen ein Arbeitsverzeichnis, ohne Node:path.
export function normalisierePfad(pfad, cwd = "") {
  let p = String(pfad || "").replace(/\\/g, "/");
  if (!p) return "";
  const absolut = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  if (!absolut && cwd) p = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "") + "/" + p;
  const laufwerk = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : "";
  const rest = laufwerk ? p.slice(2) : p;
  const teile = [];
  for (const t of rest.split("/")) {
    if (!t || t === ".") continue;
    if (t === "..") { teile.pop(); continue; }
    teile.push(t);
  }
  return `${laufwerk}/${teile.join("/")}`;
}

// Der Dateipfad eines Schreib-Werkzeugaufrufs (Edit/Write/MultiEdit: file_path, NotebookEdit: notebook_path).
export function werkzeugPfad(e) {
  if (!e || typeof e !== "object") return "";
  return String(e.file_path || e.notebook_path || "");
}

export function liegtIn(pfad, ordner) {
  if (!pfad || !ordner) return false;
  const o = String(ordner).replace(/\/+$/, "");
  return pfad === o || pfad.startsWith(o + "/");
}

// ---- Sitzungs-Einträge --------------------------------------------------------------------------------
// Ein Eintrag je Sitzung im gemeinsamen $.store (eigener Schlüssel "sitzung:<id>" — jede Sitzung schreibt nur
// ihren eigenen Schlüssel, darum keine Schreib-Wettläufe): { id, cwd, repo, herz, dateien: { <pfad>: ms } }.

export function neuerEintrag(id, { cwd = "", repo = "", jetzt = 0 } = {}) {
  return { id: String(id), cwd: String(cwd || ""), repo: String(repo || ""), herz: jetzt, dateien: {} };
}

// Entfernt verfallene Ansprüche (> 30 min) — gibt einen NEUEN Eintrag zurück.
export function aufraeumen(eintrag, jetzt) {
  const dateien = {};
  for (const [pfad, zeit] of Object.entries(eintrag?.dateien || {})) {
    if (typeof zeit === "number" && jetzt - zeit <= ANSPRUCH_MS) dateien[pfad] = zeit;
  }
  return { ...eintrag, dateien };
}

export function anspruchSetzen(eintrag, pfad, jetzt) {
  const sauber = aufraeumen(eintrag, jetzt);
  return { ...sauber, herz: jetzt, dateien: { ...sauber.dateien, [pfad]: jetzt } };
}

export function herzschlag(eintrag, jetzt) {
  return { ...aufraeumen(eintrag, jetzt), herz: jetzt };
}

export function istLebendig(eintrag, jetzt) {
  return !!eintrag && typeof eintrag.herz === "number" && jetzt - eintrag.herz <= TOT_MS;
}

// Ein Eintrag, den niemand mehr pflegt (kein Herzschlag seit länger als der Anspruchs-Verfall), darf jede
// Sitzung aus dem Speicher räumen — seine Ansprüche wären ohnehin alle verfallen.
export function istVerwaist(eintrag, jetzt) {
  return !eintrag || typeof eintrag.herz !== "number" || jetzt - eintrag.herz > ANSPRUCH_MS;
}

const kurzId = (id) => String(id || "").slice(0, 8);
const ordnerName = (pfad) => String(pfad || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";

function treffer(eintrag, zeit, jetzt) {
  return {
    id: eintrag.id,
    kurz: kurzId(eintrag.id),
    ort: ordnerName(eintrag.cwd),
    vorMin: Math.max(0, Math.round((jetzt - zeit) / 60000)),
    zeit,
  };
}

// Hat eine ANDERE, lebende Sitzung dieselbe Datei in den letzten 30 min beansprucht? → jüngster Treffer, sonst null.
export function findeKollision(eigeneId, pfad, eintraege, jetzt) {
  let best = null;
  for (const e of eintraege || []) {
    if (!e || e.id === eigeneId || !istLebendig(e, jetzt)) continue;
    const zeit = e.dateien?.[pfad];
    if (typeof zeit !== "number" || jetzt - zeit > ANSPRUCH_MS) continue;
    if (!best || zeit > best.zeit) best = treffer(e, zeit, jetzt);
  }
  return best;
}

// Hat eine ANDERE, lebende Sitzung im selben Repo (Haupt-Arbeitsbaum, Worktrees teilen den Stash) in den letzten
// 30 min Dateien beansprucht? Zählt der Repo-Eintrag der Sitzung ODER ein beanspruchter Pfad unter dem Repo.
export function findeRepoKollision(eigeneId, repo, eintraege, jetzt) {
  if (!repo) return null;
  let best = null;
  for (const e of eintraege || []) {
    if (!e || e.id === eigeneId || !istLebendig(e, jetzt)) continue;
    const gleichesRepo = e.repo && e.repo === repo;
    for (const [pfad, zeit] of Object.entries(e.dateien || {})) {
      if (typeof zeit !== "number" || jetzt - zeit > ANSPRUCH_MS) continue;
      if (!gleichesRepo && !liegtIn(pfad, repo)) continue;
      if (!best || zeit > best.zeit) best = treffer(e, zeit, jetzt);
    }
  }
  return best;
}

const sitzungsName = (k) => `Sitzung ${k.kurz}${k.ort ? ` (${k.ort})` : ""}`;
const vorText = (k) => (k.vorMin < 1 ? "gerade eben" : `vor ${k.vorMin} min`);

export function kollisionsFrage(k) {
  return `Diese Datei bearbeitet gerade auch ${sitzungsName(k)} (${vorText(k)}) — trotzdem?`;
}

export function repoFrage(k, befehl) {
  return `${befehl}: ${sitzungsName(k)} hat in diesem Repo ${vorText(k)} Dateien bearbeitet — Stash und Arbeitsbaum sind geteilt. Trotzdem?`;
}

export const FORTFAHREN = "Fortfahren";
export const ABBRECHEN = "Abbrechen";

// ---- Riskante git-Befehle -----------------------------------------------------------------------------

function woerter(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Erkennt git stash (außer list/show), git reset --hard, git checkout -- . / git checkout . in einer Befehlszeile.
// Rückgabe: Kurzbezeichnung oder null.
export function riskanterGitBefehl(befehl) {
  for (const roh of String(befehl || "").split(/&&|\|\||;|\||\n/)) {
    const w = woerter(roh.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
    // Vorspann überspringen: VAR=wert, sudo/command/exec/nohup/time und env samt Optionen (env -u GIT_DIR …).
    for (let weiter = true; weiter && w.length;) {
      weiter = false;
      while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w.shift(); weiter = true; }
      if (["sudo", "command", "exec", "nohup", "time"].includes(w[0])) { w.shift(); weiter = true; }
      if (w[0] === "env") {
        w.shift();
        while (w.length && w[0].startsWith("-")) w.splice(0, ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(w[0]) ? 2 : 1);
        weiter = true;
      }
    }
    if (w[0] !== "git") continue;
    let i = 1;
    while (i < w.length && w[i].startsWith("-")) i += (w[i] === "-C" || w[i] === "-c") ? 2 : 1;
    const sub = w[i];
    const rest = w.slice(i + 1);
    if (sub === "stash") {
      const aktion = rest.find(a => !a.startsWith("-")) || "push";
      if (aktion === "list" || aktion === "show") continue;
      return aktion === "push" ? "git stash" : `git stash ${aktion}`;
    }
    if (sub === "reset" && rest.includes("--hard")) return "git reset --hard";
    if (sub === "checkout" && rest.includes(".")) return "git checkout -- .";
  }
  return null;
}

// ---- Kontext ------------------------------------------------------------------------------------------

export function kontextFarbe(prozent) {
  if (prozent < 60) return "green";
  if (prozent < 80) return "yellow";
  return "red";
}

export function kurzZahl(n) {
  const x = Number(n) || 0;
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(x % 1_000_000 === 0 ? 0 : 1)}M`;
  if (x >= 1_000) return `${Math.round(x / 1_000)}k`;
  return String(x);
}

// Aus $.session.usage().context eine Lesung { prozent, tokens, fenster } oder null (kein Fenster bekannt).
export function kontextLesung(context) {
  if (!context || !context.window) return null;
  const tokens = Number(context.tokens ?? 0);
  const prozent = Math.round(Number(context.percent ?? (tokens / context.window) * 100));
  return { prozent, tokens, fenster: context.window };
}

export function kontextZeile(lesung) {
  if (!lesung) return "Kontext: noch keine Messung";
  return `Kontext ${lesung.prozent} % · ${kurzZahl(lesung.tokens)} / ${kurzZahl(lesung.fenster)}`;
}

export const HINWEIS_FAST_VOLL = "Kontext fast voll — Stand sichern?";
export const CACHE_NICHT_VERFUEGBAR = "Cache-Restzeit: liefert die Mods-API nicht";

export function kontextBefehlText(lesung) {
  const zeilen = [kontextZeile(lesung)];
  if (lesung && lesung.prozent >= 80) zeilen.push(HINWEIS_FAST_VOLL);
  zeilen.push(CACHE_NICHT_VERFUEGBAR);
  return zeilen.join("\n");
}

// ---- Brain-Band ---------------------------------------------------------------------------------------

// Dieselben Teile wie die Statusleiste (brain-stand.mjs#statusZeile), ohne ANSI und ohne Emoji.
export function brainTeile(stand) {
  if (!stand || typeof stand !== "object") return [{ text: "Brain: Stand unbekannt", farbe: "gray" }];
  const { wartend = 0, konflikte = 0, pruefbeduerftig = 0, vorschlaege = 0, ingest = "", frisch = 0 } = stand;
  const teile = [];
  if (wartend === 0 && konflikte === 0 && pruefbeduerftig === 0) {
    teile.push({ text: "Brain: aktuell", farbe: "green" });
  } else {
    teile.push({ text: wartend !== 0 ? `Brain: ${wartend} wartend` : "Brain", farbe: "yellow" });
    if (konflikte !== 0) teile.push({ text: `${konflikte} Konflikt(e)!`, farbe: "red" });
    if (pruefbeduerftig !== 0) teile.push({ text: `${pruefbeduerftig} prüfbedürftig`, farbe: "magenta" });
  }
  if (vorschlaege !== 0) teile.push({ text: `${vorschlaege} ${vorschlaege === 1 ? "Vorschlag" : "Vorschläge"}`, farbe: "yellow" });
  if (ingest) teile.push(frisch !== 0 ? { text: `Ingest ${ingest} ⚠`, farbe: "yellow" } : { text: `Ingest ${ingest}`, farbe: "gray" });
  return teile;
}

// Aus der JSON-Zeile von brain-stand.mjs --json → { stand, hinweis } oder null.
export function leseStandAusgabe(stdout) {
  try {
    const zeile = String(stdout || "").trim().split("\n").pop();
    const d = JSON.parse(zeile);
    return d && typeof d === "object" && d.stand ? d : null;
  } catch { return null; }
}

export function seitenName(rel) {
  return String(rel || "").split("/").pop().replace(/\.(md|markdown|txt)$/i, "");
}
