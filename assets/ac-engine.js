/* AllergenCheck – Erkennungs-Engine (Browser + Node).
 * Ordnet Rezeptzeilen und Etiketten-Zutatenlisten den 14 EU-Allergenen (LMIV Anhang II) zu.
 * a = sicher enthalten, p = bitte prüfen (wird vorsorglich mit ausgewiesen). */
(function (root) {
  "use strict";

  var ORDER = "ABCDEFGHLMNOPR";
  var UNITS = toSet("g gr gramm kg kilo mg ml l liter cl dl el tl essloffel teeloffel prise prisen stuck stk st bund bunde dose dosen becher packchen pck pkg packung packungen scheibe scheiben tasse tassen msp messerspitze schuss spritzer handvoll glas glaser x");
  var DESCRIPTORS = expand("frisch fein gehackt gerieben gewurfelt geschnitten gekocht gebraten gerostet geschalt gemahlen getrocknet geschmolzen zerlassen gepresst halbiert geviertelt entkernt geputzt gewaschen abgetropft passiert pueriert blanchiert tiefgekuhlt aufgetaut klein gross mittelgross rot gelb grun weiss schwarz braun heiss kalt warm lauwarm weich hart flussig kuhl grob dunn dick lang kurz reif jung alt ganz halb gesalzen ungesalzen natur fettarm mager entolt stark schwach reduziert leicht") .concat(
    "bio tk type und oder mit ohne nach belieben etwas ca circa zum zur zu fur das die der den dem des ein eine einer einen vom von aus in im an auf a la al optional evtl eventuell nb zb deko garnitur zimmertemperatur zimmerwarm stuckchen streifen wurfel wurfeln ringe ringen stucke scheibchen sorte sorten art je nachdem gut viel wenig mehr menge rest reichlich portion portionen stuck ausbacken anbraten braten frittieren bestreuen garnieren servieren dekorieren abschmecken festkochend festkochende mehligkochend mehligkochende vorwiegend zweig zweige stange stangen stiel stiele blatt blatter extra nativ natives vergine con carne n".split(" "));
  var DESC = toSet(DESCRIPTORS.join(" "));

  var ALLERGENS = [];
  var NAMES = {};
  var baseKeys = [];
  var customKeys = [];
  var keys = [];

  function toSet(str) { var s = Object.create(null); str.split(/\s+/).forEach(function (w) { if (w) s[w] = true; }); return s; }
  function expand(str) {
    var out = [];
    str.split(/\s+/).forEach(function (w) { ["", "e", "en", "er", "es", "em"].forEach(function (x) { out.push(w + x); }); });
    return out;
  }

  function normalize(s) {
    return String(s == null ? "" : s)
      .replace(/[¼½¾⅓⅔⅛]/g, " 1 ")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/ß/g, "ss")
      .replace(/([a-z0-9])[-‐‑]+(?=[a-z0-9])/g, "$1")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function isNoise(tok) {
    return UNITS[tok] || /^\d+(g|gr|kg|mg|ml|l|cl|dl|el|tl|stk|st|x)?$/.test(tok);
  }

  function cleanTokens(text) {
    return normalize(text).split(" ").filter(function (t) { return t && !isNoise(t); });
  }

  function sortCodes(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (c) { c = String(c).trim().toUpperCase(); if (c && ORDER.indexOf(c) >= 0 && !seen[c]) { seen[c] = 1; out.push(c); } });
    return out.sort(function (x, y) { return ORDER.indexOf(x) - ORDER.indexOf(y); });
  }
  function codes(str) { return sortCodes(String(str || "").split(/[,\s]+/)); }
  function union() { var all = []; for (var i = 0; i < arguments.length; i++) all = all.concat(arguments[i] || []); return sortCodes(all); }
  function minus(a, b) { return sortCodes(a).filter(function (c) { return (b || []).indexOf(c) < 0; }); }

  function addKey(map, raw, entry) {
    var k = cleanTokens(raw).join(" ");
    if (!k) return;
    var ex = map[k];
    if (ex) {
      ex.a = union(ex.a, entry.a);
      ex.p = union(ex.p, entry.p);
      if (entry.hint && !ex.hint) ex.hint = entry.hint;
      if (entry.custom) { ex.custom = true; ex.name = entry.name; }
      return;
    }
    map[k] = { k: k, len: k.replace(/ /g, "").length, name: entry.name, a: entry.a.slice(), p: entry.p.slice(), hint: entry.hint || "", custom: !!entry.custom };
  }

  function buildKeys(items, custom) {
    var map = Object.create(null);
    items.forEach(function (it) {
      var e = { name: it[0], a: codes(it[1]), p: codes(it[2]), hint: it[4] || "" };
      addKey(map, it[0], e);
      String(it[3] || "").split("|").forEach(function (s) { addKey(map, s, e); });
    });
    var out = Object.keys(map).map(function (k) { var e = map[k]; e.p = minus(e.p, e.a); return e; });
    if (custom) out.forEach(function (e) { e.custom = true; });
    return out;
  }

  function init(data) {
    ALLERGENS = (data.allergens || []).map(function (x) { return { code: x[0], name: x[1], desc: x[2] }; });
    NAMES = {};
    ALLERGENS.forEach(function (x) { NAMES[x.code] = x.name; });
    baseKeys = buildKeys(data.items || [], false);
    rebuild();
    return api;
  }

  /* entries: [{name, syn:[..]|"a|b", a:[..], p:[..], hint}] – eigene Zutaten und Komponenten */
  function setCustom(entries) {
    customKeys = buildKeys((entries || []).map(function (e) {
      var syn = Array.isArray(e.syn) ? e.syn.join("|") : String(e.syn || "").split(/[,;|]/).join("|");
      return [e.name, (e.a || []).join(","), (e.p || []).join(","), syn, e.hint || ""];
    }), true);
    rebuild();
  }

  function rebuild() {
    var customSet = Object.create(null);
    customKeys.forEach(function (k) { customSet[k.k] = true; });
    keys = customKeys.concat(baseKeys.filter(function (k) { return !customSet[k.k]; }));
  }

  function findMatches(clean) {
    var cands = [];
    var n = clean.length;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], k = key.k, from = 0, pos;
      while ((pos = clean.indexOf(k, from)) >= 0) {
        var end = pos + k.length;
        var atStart = pos === 0 || clean.charCodeAt(pos - 1) === 32;
        var atEnd = end === n || clean.charCodeAt(end) === 32;
        var ok = key.len < 4 ? (atStart && atEnd) : key.len === 4 ? (atStart || atEnd) : true;
        if (ok) cands.push({ key: key, start: pos, end: end });
        from = pos + 1;
      }
    }
    cands.sort(function (x, y) {
      return (y.key.custom - x.key.custom) || (y.key.len - x.key.len) || (x.start - y.start);
    });
    var taken = [];
    var accepted = [];
    cands.forEach(function (c) {
      for (var j = 0; j < taken.length; j++) if (c.start < taken[j][1] && c.end > taken[j][0]) return;
      taken.push([c.start, c.end]);
      accepted.push(c);
    });
    accepted.sort(function (x, y) { return x.start - y.start; });
    return accepted;
  }

  function analyzeLine(text) {
    var toks = cleanTokens(text);
    var clean = toks.join(" ");
    var res = { text: String(text || "").trim(), clean: clean, matches: [], a: [], p: [], status: "empty", hints: [] };
    if (!clean) return res;
    var ms = findMatches(clean);
    var cover = new Uint8Array(clean.length);
    ms.forEach(function (m) {
      for (var i = m.start; i < m.end; i++) cover[i] = 1;
      res.matches.push({ name: m.key.name, a: m.key.a, p: m.key.p, hint: m.key.hint, start: m.start, end: m.end, custom: m.key.custom });
      res.a = union(res.a, m.key.a);
      res.p = union(res.p, m.key.p);
      if (m.key.hint && res.hints.indexOf(m.key.hint) < 0) res.hints.push(m.key.hint);
    });
    res.p = minus(res.p, res.a);
    var pos = 0, sig = 0, covered = 0;
    toks.forEach(function (t) {
      var s = pos, e = pos + t.length;
      pos = e + 1;
      if (DESC[t]) return;
      sig++;
      var c = 0;
      for (var i = s; i < e; i++) c += cover[i];
      if (c / t.length >= 0.6) covered++;
    });
    if (!ms.length) res.status = sig ? "unknown" : "empty";
    else res.status = covered === sig ? "ok" : "partial";
    return res;
  }

  function isHeader(line) { return /:\s*$/.test(line) && line.length < 60; }

  function splitRecipe(text) {
    return String(text || "")
      .split(/\r?\n|[•·▪●◦]|•/)
      .map(function (l) { return l.replace(/^\s*(?:[-*–+]|\d+[.)])\s+/, "").trim(); })
      .filter(function (l) { return l && !isHeader(l); });
  }

  var TRACE_RE = /(kann\s+(?:\w+\s+){0,2})?spuren|may contain|traces of|hergestellt in einem betrieb|verarbeitet auch/i;

  function splitLabel(text) {
    var t = String(text || "").replace(/\r?\n/g, " ");
    var m = /zutaten\s*[:\-]/i.exec(t);
    if (m) t = t.slice(m.index + m[0].length);
    t = t.replace(/\d+(?:[.,]\d+)?\s*%/g, " ");
    var cut = TRACE_RE.exec(t);
    var main = cut ? t.slice(0, cut.index) : t;
    var trace = cut ? t.slice(cut.index) : "";
    var parts = [];
    function push(chunk, isTrace) {
      chunk.split(/[,;()\[\]{}:]|\.(?=\s|$)|\bund\b|\s&\s/i).forEach(function (s) {
        s = s.trim();
        if (isTrace) s = s.replace(/^(kann\s+)?(auch\s+)?(spuren\s+(von|an)?|may contain|traces of)\s*/i, "").replace(/\s*enthalten\.?$/i, "").trim();
        if (s && /[a-zA-ZäöüÄÖÜ]{2}/.test(s)) parts.push({ text: s, trace: isTrace });
      });
    }
    push(main, false);
    if (trace) push(trace, true);
    return parts;
  }

  function analyzeLabel(text) {
    var items = splitLabel(text).map(function (p) {
      var r = analyzeLine(p.text);
      if (p.trace) r.status = "trace";
      r.trace = p.trace;
      return r;
    });
    var a = [], p = [], traces = [];
    items.forEach(function (r) {
      if (r.trace) traces = union(traces, r.a, r.p);
      else { a = union(a, r.a); p = union(p, r.p); }
    });
    return { items: items, a: a, p: minus(p, a), traces: minus(traces, a), unknown: items.filter(function (r) { return r.status === "unknown"; }).length };
  }

  /* dish: {id, name, base, lines:[{t, ref?, set?}]}; getDish(id) -> dish */
  function resolveDish(dish, getDish, stack) {
    stack = stack || [];
    var out = { a: [], p: [], codes: [], lines: [], unknown: 0, partial: 0, cycle: false };
    if (!dish) return out;
    if (stack.indexOf(dish.id) >= 0) { out.cycle = true; return out; }
    var next = stack.concat([dish.id]);
    (dish.lines || []).forEach(function (l) {
      var r;
      if (l.ref) {
        var c = getDish ? getDish(l.ref) : null;
        if (!c) r = { text: l.t || "(Komponente fehlt)", ref: l.ref, missing: true, a: [], p: [], status: "unknown", matches: [], hints: [] };
        else {
          var sub = resolveDish(c, getDish, next);
          if (sub.cycle) out.cycle = true;
          r = { text: c.name, ref: l.ref, a: sub.a, p: sub.p, status: sub.unknown ? "unknown" : sub.partial ? "partial" : "ok", matches: [], hints: [], sub: sub };
        }
      } else {
        if (!l.t || !String(l.t).trim()) return;
        r = analyzeLine(l.t);
        if (r.status === "empty") return;
      }
      r.manual = Array.isArray(l.set);
      r.eff = r.manual ? { a: sortCodes(l.set), p: [] } : { a: r.a, p: r.p };
      if (!r.manual) {
        if (r.status === "unknown") out.unknown++;
        else if (r.status === "partial") out.partial++;
      }
      out.a = union(out.a, r.eff.a);
      out.p = union(out.p, r.eff.p);
      out.lines.push(r);
    });
    out.p = minus(out.p, out.a);
    out.codes = union(out.a, out.p);
    return out;
  }

  var api = {
    ORDER: ORDER,
    init: init,
    setCustom: setCustom,
    normalize: normalize,
    cleanTokens: cleanTokens,
    analyzeLine: analyzeLine,
    splitRecipe: splitRecipe,
    splitLabel: splitLabel,
    analyzeLabel: analyzeLabel,
    resolveDish: resolveDish,
    sortCodes: sortCodes,
    union: union,
    minus: minus,
    allergens: function () { return ALLERGENS; },
    name: function (c) { return NAMES[c] || c; },
    keyCount: function () { return keys.length; }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ACEngine = api;
})(typeof self !== "undefined" ? self : this);
