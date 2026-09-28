/* Schnelltest der Engine: node test/engine-smoke.js */
"use strict";
const path = require("path");
const E = require("../assets/ac-engine.js");
E.init(require(path.join(__dirname, "../assets/data/zutaten.json")));

let fail = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function line(text, a, p, status) {
  const r = E.analyzeLine(text);
  const ok = eq(r.a, a) && (p === undefined || eq(r.p, p)) && (status === undefined || r.status === status);
  if (!ok) { fail++; console.log("FAIL", JSON.stringify(text), "→ a", r.a, "p", r.p, r.status, r.matches.map(m => m.name)); }
}

line("500 g Buchweizenmehl", [], [], "ok");
line("200g Weizenmehl Type 405", ["A"], [], "ok");
line("1 Dose Kokosmilch", [], [], "ok");
line("250 ml Hafermilch", ["A"], []);
line("1 kg Schweinefleisch", [], [], "ok");
line("2 EL Butterschmalz", ["G"], []);
line("2 Eier", ["C"], [], "ok");
line("200 g Reis", [], [], "ok");
line("4 Hähnchenoberschenkel", [], []);
line("1/2 Bund Petersilie, fein gehackt", [], [], "ok");
line("3 Zweige Rosmarin", [], []);
line("100 g Parmesan, gerieben", ["G"], []);
line("Grana Padano", ["C", "G"], []);
line("1 TL Dijon-Senf", ["M"], [], "ok");
line("Sojasauce", ["A", "F"], []);
line("Tamari", ["F"], ["A"]);
line("2 Knoblauchzehen", [], [], "ok");
line("1 Schuss Weißwein", ["O"], []);
line("½ Stange Lauch", [], []);
line("Pesto Genovese", ["G"], ["H"]);
line("Gemüsebrühe", [], ["A", "L"]);
line("Zimtschnecken", ["A", "C", "G"], ["F", "H"]);
line("Garnelen", ["B"], []);
line("Muskatnuss", [], [], "ok");
line("Blätterteig", ["A"], ["G"]);
line("Maisstärke", [], [], "ok");
line("Frühlingszwiebeln", [], [], "ok");
line("Röstzwiebeln", ["A"], []);
line("Mandelmilch", ["H"], []);
line("Tofu", ["F"], []);
line("Xylophonsaft", [], [], "unknown");

const lab = E.analyzeLabel("Zutaten: Weizenmehl (45%), Zucker, Palmfett, Haselnüsse 13%, Magermilchpulver, Emulgator: Lecithine (Soja), Salz. Kann Spuren von Erdnüssen und Sesam enthalten.");
if (!eq(lab.a, ["A", "F", "G", "H"]) || !eq(lab.traces, ["E", "N"])) { fail++; console.log("FAIL label", lab.a, lab.p, lab.traces); }

const recipe = E.splitRecipe("Für den Teig:\n- 250 g Mehl\n- 2 Eier\n• 1 Prise Salz\n\n3. 100 ml Milch");
if (recipe.length !== 4) { fail++; console.log("FAIL splitRecipe", recipe); }

// Komponenten + manuelle Überschreibung + Zyklus
const dishes = {
  b1: { id: "b1", name: "Hausdressing", base: true, lines: [{ t: "Joghurt" }, { t: "Senf" }] },
  d1: { id: "d1", name: "Salat", lines: [{ t: "Blattsalat" }, { ref: "b1" }, { t: "Brühe", set: ["L"] }] },
  c1: { id: "c1", name: "X", lines: [{ ref: "c2" }] },
  c2: { id: "c2", name: "Y", lines: [{ ref: "c1" }] },
};
const get = (id) => dishes[id];
const r = E.resolveDish(dishes.d1, get);
if (!eq(r.codes, ["G", "L", "M"])) { fail++; console.log("FAIL resolveDish", r.codes); }
const rc = E.resolveDish(dishes.c1, get);
if (!rc.cycle) { fail++; console.log("FAIL cycle"); }

E.setCustom([{ name: "Hausgewürz Nr. 5", a: ["L"], syn: "gewurz 5" }]);
line("1 TL Hausgewürz Nr. 5", ["L"], []);

console.log(fail ? `${fail} Fehler` : `OK – ${E.keyCount()} Schlüssel`);
process.exit(fail ? 1 : 0);
