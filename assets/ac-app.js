/* AllergenCheck – App-Logik. Alle Betriebsdaten bleiben lokal auf dem Gerät (localStorage).
 * Einzige Serververbindung: Prüfung des Lizenzcodes (ac-check-token). */
(function () {
  "use strict";
  var E = window.ACEngine;
  var CFG = {
    fn: "https://xeuexovdipdiiuzjpzkj.supabase.co/functions/v1",
    key: "sb_publishable_3dLuQ2PfEsjavJyl0fmkaA_DXB8ZS6f",
    tess: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    version: "1.0.0"
  };
  var DB_KEY = "ac.data.v1", LIC_KEY = "ac.lic.v1", TRIAL_KEY = "ac.trial.v1";
  var TRIAL_DAYS = 14, GRACE_DAYS = 3, DAY = 864e5;
  var CATS = ["Vorspeise", "Suppe", "Salat", "Hauptgericht", "Beilage", "Dessert", "Kuchen & Gebäck", "Frühstück", "Snack", "Getränk", "Sonstiges"];

  var d = document, $main = d.getElementById("main"), dlg = d.getElementById("dlg");
  var S, results = {}, tab = "dishes", ready = false;

  // ---------- Hilfen ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fmtDate(t) { var x = new Date(t); return pad(x.getDate()) + "." + pad(x.getMonth() + 1) + "." + x.getFullYear(); }
  function fmtDateTime(t) { var x = new Date(t); return fmtDate(t) + " " + pad(x.getHours()) + ":" + pad(x.getMinutes()); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast("Speichern fehlgeschlagen – Speicher voll?"); return false; } }
  function toast(msg, ms) {
    var t = d.createElement("div"); t.className = "toast"; t.textContent = msg; d.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function chips(a, p, big) {
    a = a || []; p = p || [];
    if (!a.length && !p.length) return '<span class="code none' + (big ? " big" : "") + '" title="Keine der 14 Hauptallergene erkannt">–</span>';
    return a.map(function (c) { return '<span class="code' + (big ? " big" : "") + '" title="' + esc(E.name(c)) + '">' + c + "</span>"; }).join("") +
      p.map(function (c) { return '<span class="code p' + (big ? " big" : "") + '" title="' + esc(E.name(c)) + ' – bitte prüfen">' + c + "</span>"; }).join("");
  }
  function codeText(list) { return list.length ? list.join(", ") : "–"; }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
  function download(name, blob) {
    var a = d.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; d.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function stamp() { var x = new Date(); return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate()); }

  // ---------- Daten ----------
  function blank() { return { v: 1, created: Date.now(), dishes: [], custom: [], biz: { name: "", addr: "", resp: "", phone: "" } }; }
  function load() {
    var x = lsGet(DB_KEY);
    if (!x || !Array.isArray(x.dishes)) x = blank();
    x.custom = x.custom || []; x.biz = x.biz || blank().biz;
    return x;
  }
  var persistAsked = false;
  function save() {
    S.saved = Date.now();
    var ok = lsSet(DB_KEY, S);
    if (ok && !persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(function () {}); }
    return ok;
  }
  function dishById(id) { for (var i = 0; i < S.dishes.length; i++) if (S.dishes[i].id === id) return S.dishes[i]; return null; }
  function lineKey(t) { return E.normalize(t); }
  function toEngine(dish) {
    var over = dish.over || {};
    var lines = E.splitRecipe(dish.text || "").map(function (t) { var k = lineKey(t); return over[k] ? { t: t, set: over[k] } : { t: t }; });
    (dish.refs || []).forEach(function (r) { lines.push({ ref: r }); });
    return { id: dish.id, name: dish.name, base: dish.base, lines: lines };
  }
  function getEngineDish(id) { var x = dishById(id); return x ? toEngine(x) : null; }
  function customEntries(withBases) {
    var out = S.custom.map(function (c) { return { name: c.name, syn: c.syn || "", a: c.a || [], p: c.p || [], hint: "Eigene Zutat" }; });
    if (withBases) S.dishes.forEach(function (x) {
      if (x.base && x.name && results[x.id]) out.push({ name: x.name, a: results[x.id].a, p: results[x.id].p, hint: "Komponente „" + x.name + "“" });
    });
    return out;
  }
  function recompute() {
    results = {};
    E.setCustom(customEntries(false));
    S.dishes.forEach(function (x) { if (x.base) results[x.id] = E.resolveDish(toEngine(x), getEngineDish); });
    E.setCustom(customEntries(true));
    S.dishes.forEach(function (x) { results[x.id] = E.resolveDish(toEngine(x), getEngineDish); });
  }
  function sortedDishes(filter) {
    return S.dishes.filter(filter || function () { return true; }).sort(function (a, b) {
      return (CATS.indexOf(a.cat) - CATS.indexOf(b.cat)) || a.name.localeCompare(b.name, "de");
    });
  }

  // ---------- Lizenz ----------
  function post(path, body) {
    return fetch(CFG.fn + "/" + path, { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.key, Authorization: "Bearer " + CFG.key }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function trialStart() {
    var t = lsGet(TRIAL_KEY);
    if (!t) { t = (S && S.created) || Date.now(); lsSet(TRIAL_KEY, t); }
    return t;
  }
  function endOfDay(dateStr) { var t = Date.parse(dateStr + "T23:59:59"); return isNaN(t) ? 0 : t; }
  function licState() {
    var now = Date.now(), l = lsGet(LIC_KEY);
    if (l && l.token) {
      if (l.status === "revoked") return { mode: "revoked", lic: l };
      var until = endOfDay(l.valid_until);
      if (l.status === "active" && now <= until) return { mode: "active", lic: l, until: until };
      if (l.status === "active" && now <= until + GRACE_DAYS * DAY) return { mode: "grace", lic: l, until: until };
      if (l.status === "active" || l.status === "expired") return { mode: "expired", lic: l, until: until };
    }
    var end = trialStart() + TRIAL_DAYS * DAY;
    if (now < end) return { mode: "trial", until: end, left: Math.ceil((end - now) / DAY) };
    return { mode: "locked" };
  }
  function canEdit() { var m = licState().mode; return m === "trial" || m === "active" || m === "grace"; }
  function guard() {
    if (canEdit()) return true;
    openDialog('<div class="dh"><h2>Nur-Lesen-Modus</h2></div><div class="db"><p>Ihre Testphase bzw. Ihr Abo ist abgelaufen. Alle Daten bleiben erhalten und können weiterhin angesehen und gesichert werden.</p><p>Zum Bearbeiten und für PDF-Ausgaben bitte ein Abo abschließen und den Lizenzcode unter <b>Mehr → Lizenz</b> eingeben.</p></div>' +
      '<div class="df"><button class="btn sec" data-close>Schließen</button><a class="btn acc" href="kaufen.html">Abo abschließen</a></div>');
    return false;
  }
  function checkToken(token, manual) {
    token = String(token || "").trim().toUpperCase();
    return post("ac-check-token", { token: token }).then(function (j) {
      var prev = lsGet(LIC_KEY) || {};
      if (j && j.valid) {
        lsSet(LIC_KEY, { token: token, plan: j.plan || "", valid_until: j.valid_until, status: "active", checked_at: Date.now(), name: j.name || "" });
        return { ok: true, j: j };
      }
      if (j && j.valid === false) {
        var st = j.reason === "revoked" ? "revoked" : j.reason === "expired" ? "expired" : j.reason === "not_active" ? "pending" : "invalid";
        if (!manual && prev.token === token) {
          if (st === "invalid") localStorage.removeItem(LIC_KEY);
          else lsSet(LIC_KEY, Object.assign({}, prev, { status: st, checked_at: Date.now(), valid_until: j.valid_until || prev.valid_until }));
        } else if (manual && (st === "expired" || st === "revoked")) {
          lsSet(LIC_KEY, { token: token, plan: j.plan || "", valid_until: j.valid_until || "", status: st, checked_at: Date.now() });
        }
        return { ok: false, reason: j.reason || "invalid" };
      }
      return { ok: false, reason: "server" };
    }).catch(function () { return { ok: false, reason: "offline" }; });
  }
  function maybeRecheck() {
    var l = lsGet(LIC_KEY);
    if (!l || !l.token || !navigator.onLine) return;
    var st = licState();
    var due = Date.now() - (l.checked_at || 0) > DAY || ((st.mode === "grace" || st.mode === "expired") && Date.now() - (l.checked_at || 0) > 36e5);
    if (!due) return;
    checkToken(l.token, false).then(function () { renderChrome(); if (ready && tab === "more") render(); });
  }
  function reasonText(r) {
    return { not_active: "Dieser Code ist noch nicht aktiv – die Freischaltung erfolgt nach Zahlungseingang.", expired: "Dieses Abo ist abgelaufen. Nach Zahlung der Verlängerung wird es automatisch wieder aktiv.", revoked: "Dieser Code wurde gesperrt. Bitte wenden Sie sich an kontakt@vaydena.de.", offline: "Keine Verbindung. Bitte online gehen und erneut versuchen.", server: "Der Server ist gerade nicht erreichbar. Bitte später erneut versuchen." }[r] || "Dieser Code ist ungültig. Bitte Eingabe prüfen.";
  }
  function renderChrome() {
    var st = licState(), pill = d.getElementById("licPill"), ban = d.getElementById("banner");
    pill.hidden = false; pill.className = "pill"; ban.hidden = true;
    if (st.mode === "active") { pill.textContent = st.lic.plan === "year" ? "Jahresabo" : "Abo aktiv"; }
    else if (st.mode === "trial") { pill.textContent = "Test: noch " + st.left + " Tag" + (st.left === 1 ? "" : "e"); if (st.left <= 3) pill.className = "pill warn"; }
    else {
      pill.textContent = st.mode === "grace" ? "Abo läuft ab" : "Nur Lesen"; pill.className = "pill warn";
      ban.hidden = false;
      ban.innerHTML = '<div class="wrap">' + (st.mode === "grace"
        ? "<span><b>Ihr Abo ist am " + fmtDate(st.until) + " abgelaufen.</b> Noch wenige Tage voll nutzbar – bitte Verlängerung bezahlen.</span>"
        : st.mode === "revoked" ? "<span><b>Lizenz gesperrt.</b> Daten bleiben lesbar und exportierbar.</span>"
          : "<span><b>" + (st.mode === "expired" ? "Abo abgelaufen." : "Testphase beendet.") + "</b> Daten bleiben lesbar; Bearbeiten und PDFs mit Abo.</span>") +
        ' <a class="btn small acc" href="kaufen.html">Abo abschließen</a></div>';
    }
    pill.onclick = function () { go("more"); };
  }

  // ---------- Dialog ----------
  function openDialog(html, onOpen) {
    dlg.innerHTML = html;
    dlg.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { closeDialog(); }); });
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
    if (onOpen) onOpen(dlg);
  }
  function closeDialog() { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); dlg.innerHTML = ""; }
  function confirmDlg(text, okLabel, cb, danger) {
    openDialog('<div class="dh"><h2>Bitte bestätigen</h2></div><div class="db"><p>' + text + '</p></div><div class="df"><button class="btn sec" data-close>Abbrechen</button><button class="btn ' + (danger ? "danger" : "") + '" id="dOk">' + esc(okLabel) + "</button></div>",
      function () { d.getElementById("dOk").onclick = function () { closeDialog(); cb(); }; });
  }
  function codePicker(title, sub, selected, cb, extraBtn) {
    var sel = (selected || []).slice();
    openDialog('<div class="dh"><h2>' + esc(title) + '</h2><p class="muted small">' + sub + '</p></div><div class="db"><div class="codelist" id="cp">' +
      E.allergens().map(function (x) { return '<div class="toggle' + (sel.indexOf(x.code) >= 0 ? " on" : "") + '" data-c="' + x.code + '" role="checkbox" tabindex="0" aria-checked="' + (sel.indexOf(x.code) >= 0) + '"><b>' + x.code + "</b>" + esc(x.name) + "</div>"; }).join("") +
      '</div></div><div class="df">' + (extraBtn ? '<button class="btn sec" id="cpX">' + esc(extraBtn) + "</button>" : "") + '<button class="btn sec" data-close>Abbrechen</button><button class="btn" id="cpOk">Übernehmen</button></div>',
      function () {
        d.getElementById("cp").addEventListener("click", function (e) {
          var t = e.target.closest(".toggle"); if (!t) return;
          var c = t.getAttribute("data-c"), i = sel.indexOf(c);
          if (i >= 0) sel.splice(i, 1); else sel.push(c);
          t.classList.toggle("on", i < 0); t.setAttribute("aria-checked", i < 0);
        });
        d.getElementById("cp").addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.target.click(); } });
        d.getElementById("cpOk").onclick = function () { closeDialog(); cb(E.sortCodes(sel)); };
        if (extraBtn) d.getElementById("cpX").onclick = function () { closeDialog(); cb(null); };
      });
  }

  // ---------- Navigation ----------
  function go(t) { tab = t; editing = null; render(); window.scrollTo(0, 0); }
  d.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { go(b.getAttribute("data-tab")); }); });
  function render() {
    d.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === tab); });
    if (editing) return renderEditor();
    ({ dishes: renderDishes, check: renderCheck, guest: renderGuest, export: renderExport, more: renderMore })[tab]();
  }

  // ---------- Gerichte ----------
  var listFilter = { q: "", kind: "all" };
  function renderDishes() {
    var n = S.dishes.length;
    var html = '<div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">Gerichte</h1><button class="btn" id="new">+ Neu</button></div>';
    if (!n) {
      html += '<div class="card"><h2>Los geht\'s</h2><p>Legen Sie Ihr erstes Gericht an: Name eingeben, Zutaten einfügen (eine pro Zeile, Mengen dürfen drinstehen) – AllergenCheck erkennt die 14 EU-Hauptallergene automatisch.</p>' +
        '<p class="muted small">Grundrezepte wie Soßen, Teige oder Dressings legen Sie als <b>Komponente</b> an und verwenden sie in mehreren Gerichten.</p>' +
        '<div class="row"><button class="btn" id="new2">Erstes Gericht anlegen</button><button class="btn sec" id="demo">Beispiele laden</button></div></div>';
      $main.innerHTML = html;
      d.getElementById("new").onclick = d.getElementById("new2").onclick = function () { newDish(false); };
      d.getElementById("demo").onclick = loadDemo;
      return;
    }
    html += '<div class="card" style="padding:12px"><div class="row"><input class="grow" type="search" id="q" placeholder="Suchen …" value="' + esc(listFilter.q) + '" aria-label="Gerichte durchsuchen">' +
      '<select id="kind" style="width:auto" aria-label="Filter"><option value="all">Alle</option><option value="dish">Gerichte</option><option value="base">Komponenten</option><option value="open">Offene Punkte</option></select></div>' +
      '<ul class="list" id="dl"></ul></div><p class="muted small center">Orange = enthalten · gestrichelt = bitte prüfen (wird vorsorglich mit ausgewiesen)</p>';
    $main.innerHTML = html;
    d.getElementById("kind").value = listFilter.kind;
    d.getElementById("new").onclick = function () { newDish(false); };
    var q = d.getElementById("q"), k = d.getElementById("kind");
    q.oninput = function () { listFilter.q = q.value; fill(); };
    k.onchange = function () { listFilter.kind = k.value; fill(); };
    function fill() {
      var nq = E.normalize(listFilter.q);
      var items = sortedDishes(function (x) {
        var r = results[x.id] || {};
        if (listFilter.kind === "dish" && x.base) return false;
        if (listFilter.kind === "base" && !x.base) return false;
        if (listFilter.kind === "open" && !(r.unknown || r.p && r.p.length || r.cycle)) return false;
        return !nq || E.normalize(x.name + " " + (x.cat || "")).indexOf(nq) >= 0;
      });
      d.getElementById("dl").innerHTML = items.length ? items.map(function (x) {
        var r = results[x.id] || { a: [], p: [] };
        return '<li class="item" data-id="' + x.id + '"><div class="grow"><div class="t">' + esc(x.name || "(ohne Name)") + (x.base ? '<span class="tag base">Komponente</span>' : "") +
          (r.unknown ? '<span class="tag warn">' + r.unknown + " unklar</span>" : "") + (r.cycle ? '<span class="tag warn">Zirkelbezug</span>' : "") +
          '</div><div class="s">' + esc(x.cat || "") + " · geändert " + fmtDate(x.updated || x.created) + '</div></div><div class="codes">' + chips(r.a, r.p) + "</div></li>";
      }).join("") : '<li class="muted" style="padding:12px 4px">Keine Treffer.</li>';
    }
    fill();
    d.getElementById("dl").addEventListener("click", function (e) { var li = e.target.closest(".item"); if (li) openEditor(li.getAttribute("data-id")); });
  }
  function newDish(base) {
    if (!guard()) return;
    editing = { id: uid(), name: "", cat: base ? "Sonstiges" : "Hauptgericht", base: !!base, text: "", refs: [], over: {}, note: "", created: Date.now(), hist: [], isNew: true };
    render(); setTimeout(function () { var n = d.getElementById("eName"); if (n) n.focus(); }, 30);
  }
  function openEditor(id) { var x = dishById(id); if (!x) return; editing = JSON.parse(JSON.stringify(x)); render(); window.scrollTo(0, 0); }

  // ---------- Editor ----------
  var editing = null;
  function renderEditor() {
    var x = editing, ro = !canEdit();
    var bases = sortedDishes(function (b) { return b.base && b.id !== x.id; });
    $main.innerHTML =
      '<div class="row" style="margin-bottom:10px"><button class="btn sec small" id="back">← Zurück</button><h1 class="grow" style="margin:0;font-size:1.25rem">' + (x.isNew ? "Neues " + (x.base ? "Grundrezept" : "Gericht") : "Bearbeiten") + "</h1></div>" +
      '<div class="card"><label for="eName">Name</label><input type="text" id="eName" maxlength="120" value="' + esc(x.name) + '" placeholder="z. B. Wiener Schnitzel mit Kartoffelsalat">' +
      '<div class="row"><div class="grow"><label for="eCat">Kategorie</label><select id="eCat">' + CATS.map(function (c) { return "<option" + (c === x.cat ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div></div>" +
      '<label class="check"><input type="checkbox" id="eBase"' + (x.base ? " checked" : "") + '> <span>Komponente / Grundrezept <span class="muted small">(z. B. Soße, Teig, Dressing – in anderen Gerichten verwendbar, erscheint nicht auf der Speisekarte)</span></span></label>' +
      '<label for="eText">Zutaten – eine pro Zeile</label><textarea id="eText" spellcheck="false" placeholder="200 g Weizenmehl&#10;2 Eier&#10;100 ml Milch&#10;1 Prise Salz">' + esc(x.text) + "</textarea>" +
      '<div class="row" style="margin-top:8px"><button class="btn sec small" id="eOcr">📷 Zutatenliste fotografieren</button><button class="btn sec small" id="eRef"' + (bases.length ? "" : " disabled title=\"Noch keine Komponenten angelegt\"") + '>+ Komponente einfügen</button></div>' +
      '<ul class="lines" id="eRefs"></ul>' +
      '<label for="eNote">Notiz (erscheint in der Dokumentation)</label><input type="text" id="eNote" maxlength="300" value="' + esc(x.note || "") + '" placeholder="z. B. Lieferant, Produktname, Charge">' +
      "</div>" +
      '<div class="card" id="eRes"></div>' +
      '<div class="row" style="margin-bottom:20px"><button class="btn grow" id="eSave">Speichern</button>' + (x.isNew ? "" : '<button class="btn sec" id="eDup">Duplizieren</button><button class="btn danger" id="eDel">Löschen</button>') + "</div>" +
      (x.hist && x.hist.length ? '<div class="card"><h3>Änderungsverlauf der Kennzeichnung</h3><ul class="lines">' + x.hist.slice().reverse().slice(0, 15).map(function (h) { return '<li class="ln"><div class="body"><div class="txt">' + fmtDateTime(h.at) + '</div></div><div class="codes">' + chips(h.a, h.p) + "</div></li>"; }).join("") + "</ul></div>" : "");

    var nm = d.getElementById("eName"), ct = d.getElementById("eCat"), bs = d.getElementById("eBase"), tx = d.getElementById("eText"), nt = d.getElementById("eNote");
    if (ro) [nm, ct, bs, tx, nt].forEach(function (i) { i.disabled = true; });
    var upd = debounce(function () { analyzeDraft(); }, 180);
    nm.oninput = function () { x.name = nm.value; };
    ct.onchange = function () { x.cat = ct.value; };
    bs.onchange = function () { x.base = bs.checked; };
    tx.oninput = function () { x.text = tx.value; upd(); };
    nt.oninput = function () { x.note = nt.value; };
    d.getElementById("back").onclick = function () { editing = null; render(); };
    d.getElementById("eOcr").onclick = function () { if (!guard()) return; pickOcr(function (text) { x.text = (x.text ? x.text.replace(/\s*$/, "\n") : "") + labelToLines(text); tx.value = x.text; analyzeDraft(); }); };
    d.getElementById("eRef").onclick = function () {
      if (!guard()) return;
      openDialog('<div class="dh"><h2>Komponente einfügen</h2></div><div class="db"><ul class="list" id="bl">' + bases.map(function (b) {
        var r = results[b.id] || {};
        return '<li class="item" data-id="' + b.id + '"><div class="grow t">' + esc(b.name) + '</div><div class="codes">' + chips(r.a, r.p) + "</div></li>";
      }).join("") + '</ul></div><div class="df"><button class="btn sec" data-close>Abbrechen</button></div>', function () {
        d.getElementById("bl").onclick = function (e) {
          var li = e.target.closest(".item"); if (!li) return;
          var id = li.getAttribute("data-id");
          if (x.refs.indexOf(id) < 0) x.refs.push(id);
          closeDialog(); analyzeDraft();
        };
      });
    };
    d.getElementById("eSave").onclick = saveDraft;
    if (ro) d.getElementById("eSave").disabled = true;
    var dup = d.getElementById("eDup"), del = d.getElementById("eDel");
    if (dup) dup.onclick = function () {
      if (!guard()) return;
      var c = JSON.parse(JSON.stringify(dishById(x.id) || x));
      c.id = uid(); c.name = c.name + " (Kopie)"; c.created = c.updated = Date.now(); c.hist = [];
      S.dishes.push(c); save(); recompute(); openEditor(c.id); toast("Kopie angelegt");
    };
    if (del) del.onclick = function () {
      if (!guard()) return;
      var used = S.dishes.filter(function (o) { return (o.refs || []).indexOf(x.id) >= 0; });
      confirmDlg("„" + esc(x.name) + "“ wirklich löschen?" + (used.length ? "<br><br><b>Achtung:</b> wird verwendet in: " + used.map(function (o) { return esc(o.name); }).join(", ") + ". Dort wird die Verknüpfung entfernt." : ""), "Löschen", function () {
        S.dishes = S.dishes.filter(function (o) { return o.id !== x.id; });
        S.dishes.forEach(function (o) { o.refs = (o.refs || []).filter(function (r) { return r !== x.id; }); });
        save(); recompute(); editing = null; render(); toast("Gelöscht");
      }, true);
    };
    analyzeDraft();
  }
  function analyzeDraft() {
    var x = editing, ro = !canEdit();
    E.setCustom(customEntries(true));
    var r = E.resolveDish(toEngine(x), function (id) { return id === x.id ? null : getEngineDish(id); });
    var refsEl = d.getElementById("eRefs");
    refsEl.innerHTML = x.refs.map(function (id) {
      var b = dishById(id), rr = results[id] || { a: [], p: [] };
      return '<li class="ln"><span class="dot"></span><div class="body"><div class="txt">🔗 Komponente: <b>' + esc(b ? b.name : "(gelöscht)") + '</b></div></div><div class="codes">' + chips(rr.a, rr.p) + '</div>' + (ro ? "" : '<button class="btn sec small" data-rm="' + id + '" aria-label="Entfernen">✕</button>') + "</li>";
    }).join("");
    refsEl.onclick = function (e) { var b = e.target.closest("[data-rm]"); if (!b) return; x.refs = x.refs.filter(function (i) { return i !== b.getAttribute("data-rm"); }); analyzeDraft(); };

    var textLines = r.lines.filter(function (l) { return !l.ref; });
    var html = '<div class="row"><h2 class="grow" style="margin:0">Kennzeichnung</h2><div class="codes">' + chips(r.a, r.p, true) + "</div></div>";
    if (r.codes.length) html += '<p class="small" style="margin-top:8px">' + r.codes.map(function (c) { return "<b>" + c + "</b> " + esc(E.name(c)); }).join(" · ") + "</p>";
    if (r.cycle) html += '<div class="notice bad">Zirkelbezug: Eine Komponente verweist (indirekt) auf sich selbst.</div>';
    if (r.unknown) html += '<div class="notice bad">' + r.unknown + " Zeile(n) nicht erkannt – bitte über „Festlegen“ die Allergene angeben (oder „keine“ bestätigen).</div>";
    if (r.p.length) html += '<div class="notice">Gestrichelte Codes sind möglich, aber nicht sicher (z. B. je nach Produkt). Sie werden vorsorglich ausgewiesen – Etikett prüfen und Zeile ggf. festlegen.</div>';
    if (textLines.length) {
      html += '<ul class="lines" id="eLines">' + textLines.map(function (l, i) {
        var why = l.manual ? '<span class="man">manuell festgelegt</span>' : l.matches.length ? "erkannt: " + l.matches.map(function (m) { return esc(m.name); }).join(", ") : "nicht erkannt";
        return '<li class="ln ' + (l.manual ? "ok" : l.status) + '"><span class="dot"></span><div class="body"><div class="txt">' + esc(l.text) + '</div><div class="why">' + why + "</div>" +
          (!l.manual && l.hints.length ? '<div class="hint">' + l.hints.map(esc).join(" ") + "</div>" : "") +
          '</div><div class="codes">' + chips(l.eff.a, l.eff.p) + "</div>" + (ro ? "" : '<button class="btn sec small" data-i="' + i + '">Festlegen</button>') + "</li>";
      }).join("") + "</ul>";
    } else html += '<p class="muted" style="margin-top:10px">Noch keine Zutaten eingegeben.</p>';
    var box = d.getElementById("eRes");
    box.innerHTML = html;
    var ul = d.getElementById("eLines");
    if (ul) ul.onclick = function (e) {
      var b = e.target.closest("[data-i]"); if (!b) return;
      var l = textLines[+b.getAttribute("data-i")], k = lineKey(l.text);
      codePicker("Allergene festlegen", "Zeile: „" + esc(l.text) + "“<br>Wählen Sie alle enthaltenen Allergene. Keine Auswahl = bestätigt allergenfrei.", l.manual ? l.eff.a : E.union(l.a, l.p), function (sel) {
        x.over = x.over || {};
        if (sel === null) delete x.over[k]; else x.over[k] = sel;
        analyzeDraft();
      }, l.manual ? "Automatik" : null);
    };
    x._res = r;
  }
  function saveDraft() {
    if (!guard()) return;
    var x = editing;
    x.name = (x.name || "").trim();
    if (!x.name) { toast("Bitte einen Namen eingeben"); d.getElementById("eName").focus(); return; }
    var clash = S.dishes.some(function (o) { return o.id !== x.id && o.name.toLowerCase() === x.name.toLowerCase(); });
    if (clash) { toast("Es gibt bereits ein Eintrag mit diesem Namen"); return; }
    // Überschreibungen für nicht mehr vorhandene Zeilen aufräumen
    var keys = {}; E.splitRecipe(x.text).forEach(function (t) { keys[lineKey(t)] = 1; });
    Object.keys(x.over || {}).forEach(function (k) { if (!keys[k]) delete x.over[k]; });
    var r = x._res || { a: [], p: [] };
    delete x._res;
    var last = x.hist && x.hist[x.hist.length - 1];
    if (!last || last.a.join() !== r.a.join() || last.p.join() !== r.p.join()) { x.hist = (x.hist || []).concat([{ at: Date.now(), a: r.a, p: r.p }]).slice(-50); }
    x.updated = Date.now();
    var isNew = x.isNew; delete x.isNew;
    var i = S.dishes.findIndex(function (o) { return o.id === x.id; });
    if (i >= 0) S.dishes[i] = x; else S.dishes.push(x);
    if (!save()) return;
    recompute();
    // Gerichte, die diese Komponente nutzen, bekommen einen Verlaufseintrag, falls sich ihre Kennzeichnung ändert
    S.dishes.forEach(function (o) {
      if (o.id === x.id || !results[o.id]) return;
      var rr = results[o.id], h = o.hist && o.hist[o.hist.length - 1];
      if (h && (h.a.join() !== rr.a.join() || h.p.join() !== rr.p.join())) { o.hist.push({ at: Date.now(), a: rr.a, p: rr.p, via: x.name }); o.updated = Date.now(); }
    });
    save();
    editing = null; tab = "dishes"; render();
    toast(isNew ? "Angelegt" : "Gespeichert");
  }
  function loadDemo() {
    if (!guard()) return;
    var dr = { id: uid(), name: "Hausdressing", cat: "Sonstiges", base: true, text: "3 EL Weißweinessig\n1 TL Dijon-Senf\n1 TL Honig\n6 EL Rapsöl\nSalz, Pfeffer", refs: [], over: {}, note: "", created: Date.now(), hist: [] };
    var dishes = [dr,
      { id: uid(), name: "Wiener Schnitzel mit Kartoffelsalat", cat: "Hauptgericht", base: false, text: "4 Kalbsschnitzel\n100 g Weizenmehl\n2 Eier\n150 g Semmelbrösel\nButterschmalz zum Ausbacken\n800 g festkochende Kartoffeln\n1 Zwiebel\n250 ml Rinderbrühe\n2 EL Weißweinessig\n1 TL Senf\nSalz, Pfeffer\nZitrone", refs: [], over: {}, note: "", created: Date.now(), hist: [] },
      { id: uid(), name: "Gemischter Salat mit Hausdressing", cat: "Salat", base: false, text: "Blattsalat\nGurke\nKirschtomaten\n2 EL Sonnenblumenkerne", refs: [dr.id], over: {}, note: "", created: Date.now(), hist: [] },
      { id: uid(), name: "Kaiserschmarrn", cat: "Dessert", base: false, text: "200 g Mehl\n4 Eier\n300 ml Milch\n30 g Zucker\n40 g Butter\nRosinen\nPuderzucker\nApfelmus", refs: [], over: {}, note: "", created: Date.now(), hist: [] }];
    S.dishes = S.dishes.concat(dishes); recompute();
    S.dishes.forEach(function (o) { var r = results[o.id]; o.hist = [{ at: Date.now(), a: r.a, p: r.p }]; o.updated = Date.now(); });
    save(); render(); toast("Beispiele geladen");
  }

  // ---------- OCR ----------
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = d.createElement("script"); s.src = src; s.async = true; s.crossOrigin = "anonymous";
      s.onload = function () { res(); }; s.onerror = function () { s.remove(); rej(new Error("load")); };
      d.head.appendChild(s);
    });
  }
  function downscale(file) {
    return new Promise(function (res) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 2200, sc = Math.min(1, max / Math.max(img.width, img.height));
        var c = d.createElement("canvas"); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        var g = c.getContext("2d"); g.filter = "grayscale(1) contrast(1.25)"; g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(file); };
      img.src = url;
    });
  }
  function pickOcr(cb) {
    var inp = d.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.setAttribute("capture", "environment");
    if (!window.Tesseract) loadScript(CFG.tess).catch(function () {});
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      openDialog('<div class="dh"><h2>Text wird erkannt …</h2></div><div class="db"><div class="progress"><i id="ocrBar"></i></div><p class="muted small" id="ocrMsg" style="margin-top:8px">Texterkennung wird geladen (beim ersten Mal ca. 15 MB, danach offline).</p></div>');
      var bar = function (p, m) { var b = d.getElementById("ocrBar"); if (b) b.style.width = Math.round(p * 100) + "%"; if (m) { var t = d.getElementById("ocrMsg"); if (t) t.textContent = m; } };
      var worker;
      (window.Tesseract ? Promise.resolve() : loadScript(CFG.tess).catch(function () { return loadScript(CFG.tess); }))
        .then(function () {
          return window.Tesseract.createWorker("deu", 1, { logger: function (m) { if (m.status === "recognizing text") bar(.1 + m.progress * .9, "Erkenne Text … " + Math.round(m.progress * 100) + " %"); } }, { load_system_dawg: "0", load_freq_dawg: "0" });
        })
        .then(function (w) { worker = w; bar(.1, "Bild wird vorbereitet …"); return downscale(f); })
        .then(function (img) { return worker.recognize(img); })
        .then(function (out) {
          worker.terminate();
          var text = (out && out.data && out.data.text || "").trim();
          if (!text) throw new Error("empty");
          openDialog('<div class="dh"><h2>Erkannter Text</h2><p class="muted small">Bitte kontrollieren und ggf. korrigieren.</p></div><div class="db"><textarea id="ocrT" spellcheck="false">' + esc(text) + '</textarea></div><div class="df"><button class="btn sec" data-close>Verwerfen</button><button class="btn" id="ocrOk">Übernehmen</button></div>', function () {
            d.getElementById("ocrOk").onclick = function () { var v = d.getElementById("ocrT").value; closeDialog(); cb(v); };
          });
        })
        .catch(function (e) {
          if (worker) try { worker.terminate(); } catch (x) {}
          openDialog('<div class="dh"><h2>Keine Texterkennung möglich</h2></div><div class="db"><p>' + (e && e.message === "empty" ? "Auf dem Foto wurde kein Text gefunden. Bitte näher heran, gerade und bei gutem Licht fotografieren." : "Die Texterkennung konnte nicht geladen werden. Beim ersten Mal ist eine Internetverbindung nötig.") + '</p></div><div class="df"><button class="btn" data-close>OK</button></div>');
        });
    };
    inp.click();
  }
  function labelToLines(text) {
    var parts = E.splitLabel(text);
    if (parts.length < 2) return text.trim();
    return parts.filter(function (p) { return !p.trace; }).map(function (p) { return p.text; }).join("\n");
  }

  // ---------- Etikett prüfen ----------
  var checkText = "";
  function renderCheck() {
    $main.innerHTML = '<h1>Etikett prüfen</h1><div class="card"><p class="muted small" style="margin-top:0">Zutatenliste eines Fertigprodukts abfotografieren oder einfügen. AllergenCheck zeigt enthaltene Allergene und Spurenhinweise.</p>' +
      '<textarea id="cT" spellcheck="false" placeholder="Zutaten: Weizenmehl, Zucker, Palmfett, Haselnüsse, Magermilchpulver, Emulgator Lecithine (Soja), Salz. Kann Spuren von Erdnüssen enthalten.">' + esc(checkText) + "</textarea>" +
      '<div class="row" style="margin-top:8px"><button class="btn" id="cOcr">📷 Foto aufnehmen</button><button class="btn sec" id="cClr">Leeren</button></div></div><div id="cRes"></div>';
    var t = d.getElementById("cT");
    var run = debounce(function () { checkText = t.value; showCheck(); }, 200);
    t.oninput = run;
    d.getElementById("cOcr").onclick = function () { pickOcr(function (v) { t.value = checkText = v; showCheck(); }); };
    d.getElementById("cClr").onclick = function () { t.value = checkText = ""; showCheck(); };
    showCheck();
  }
  function showCheck() {
    var box = d.getElementById("cRes");
    if (!checkText.trim()) { box.innerHTML = ""; return; }
    E.setCustom(customEntries(true));
    var r = E.analyzeLabel(checkText);
    box.innerHTML = '<div class="card"><div class="row"><h2 class="grow" style="margin:0">Enthält</h2><div class="codes">' + chips(r.a, r.p, true) + "</div></div>" +
      (r.traces.length ? '<p style="margin-top:10px"><b>Spuren:</b> ' + r.traces.map(function (c) { return c + " " + esc(E.name(c)); }).join(", ") + ' <span class="muted small">(freiwillige Angabe, nicht kennzeichnungspflichtig)</span></p>' : "") +
      (r.unknown ? '<div class="notice">' + r.unknown + " Bestandteil(e) nicht erkannt – bitte selbst prüfen (Allergene sind auf Etiketten meist fett gedruckt).</div>" : "") +
      '<ul class="lines">' + r.items.map(function (l) {
        return '<li class="ln ' + l.status + '"><span class="dot"></span><div class="body"><div class="txt">' + esc(l.text) + (l.trace ? ' <span class="tag">Spuren</span>' : "") + '</div><div class="why">' + (l.matches.length ? l.matches.map(function (m) { return esc(m.name); }).join(", ") : "nicht erkannt") + '</div></div><div class="codes">' + chips(l.a, l.p) + "</div></li>";
      }).join("") + "</ul>" +
      '<div class="row" style="margin-top:12px"><input class="grow" type="text" id="cName" placeholder="Produktname, z. B. Hausmarke Nuss-Nougat-Creme"><button class="btn" id="cSave">Als eigene Zutat speichern</button></div>' +
      '<p class="muted small">Eigene Zutaten werden in allen Rezepten wiedererkannt und haben Vorrang vor der Standard-Datenbank.</p></div>';
    d.getElementById("cSave").onclick = function () {
      if (!guard()) return;
      var n = d.getElementById("cName").value.trim();
      if (!n) { toast("Bitte einen Produktnamen eingeben"); return; }
      S.custom = S.custom.filter(function (c) { return c.name.toLowerCase() !== n.toLowerCase(); });
      S.custom.push({ id: uid(), name: n, syn: "", a: E.union(r.a, r.p), p: [], src: checkText.slice(0, 2000), at: Date.now() });
      save(); recompute(); toast("„" + n + "“ gespeichert");
    };
  }

  // ---------- Gäste-Filter ----------
  var guestAvoid = [];
  function renderGuest() {
    var html = '<h1>Gäste-Auskunft</h1><div class="card"><p class="muted small" style="margin-top:0">Welche Allergene verträgt der Gast nicht?</p><div class="codelist" id="gSel">' +
      E.allergens().map(function (x) { var on = guestAvoid.indexOf(x.code) >= 0; return '<div class="toggle' + (on ? " on" : "") + '" data-c="' + x.code + '" role="checkbox" tabindex="0" aria-checked="' + on + '"><b>' + x.code + "</b>" + esc(x.name) + "</div>"; }).join("") +
      '</div></div><div id="gRes"></div>';
    $main.innerHTML = html;
    d.getElementById("gSel").onclick = function (e) {
      var t = e.target.closest(".toggle"); if (!t) return;
      var c = t.getAttribute("data-c"), i = guestAvoid.indexOf(c);
      if (i >= 0) guestAvoid.splice(i, 1); else guestAvoid.push(c);
      t.classList.toggle("on", i < 0); t.setAttribute("aria-checked", i < 0); fillGuest();
    };
    d.getElementById("gSel").onkeydown = function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.target.click(); } };
    fillGuest();
  }
  function fillGuest() {
    var box = d.getElementById("gRes"), list = sortedDishes(function (x) { return !x.base; });
    if (!list.length) { box.innerHTML = '<div class="card muted">Noch keine Gerichte angelegt.</div>'; return; }
    if (!guestAvoid.length) { box.innerHTML = '<p class="muted center">Allergene oben antippen – dann erscheinen die passenden Gerichte.</p>'; return; }
    var ok = [], ask = [], no = [];
    list.forEach(function (x) {
      var r = results[x.id] || { a: [], p: [] };
      var hitA = r.a.filter(function (c) { return guestAvoid.indexOf(c) >= 0; }), hitP = r.p.filter(function (c) { return guestAvoid.indexOf(c) >= 0; });
      if (hitA.length) no.push([x, r, hitA]); else if (hitP.length || r.unknown) ask.push([x, r, hitP]); else ok.push([x, r]);
    });
    function li(e) { return '<li class="item" data-id="' + e[0].id + '"><div class="grow"><div class="t">' + esc(e[0].name) + '</div><div class="s">' + esc(e[0].cat) + (e[1].unknown ? " · enthält nicht erkannte Zutaten" : "") + '</div></div><div class="codes">' + chips(e[1].a, e[1].p) + "</div></li>"; }
    box.innerHTML =
      '<div class="card"><h2 style="color:var(--ok)">Geeignet (' + ok.length + ')</h2><ul class="list">' + (ok.map(li).join("") || '<li class="muted">Keine</li>') + "</ul></div>" +
      (ask.length ? '<div class="card"><h2 style="color:var(--warn)">Nur nach Rückfrage in der Küche (' + ask.length + ')</h2><ul class="list">' + ask.map(li).join("") + "</ul></div>" : "") +
      '<details class="card"><summary><b>Nicht geeignet (' + no.length + ")</b></summary><ul class=\"list\">" + no.map(li).join("") + "</ul></details>" +
      '<p class="muted small">Hinweis: Berücksichtigt nur die kennzeichnungspflichtigen Hauptallergene der Rezepturen – keine Kreuzkontamination in der Küche. Bei schweren Allergien immer mit der Küche Rücksprache halten.</p>';
    box.onclick = function (e) { var l = e.target.closest(".item"); if (l) openEditor(l.getAttribute("data-id")); };
  }

  // ---------- Ausgabe ----------
  function menuDishes() { return sortedDishes(function (x) { return !x.base; }); }
  function renderExport() {
    var list = menuDishes(), open = list.filter(function (x) { var r = results[x.id]; return r && (r.unknown || r.cycle); });
    var ro = !canEdit();
    var html = '<h1>Ausgabe</h1>' +
      (open.length ? '<div class="notice bad">' + open.length + " Gericht(e) enthalten nicht erkannte Zutaten: " + open.map(function (x) { return esc(x.name); }).join(", ") + ". Bitte vor dem Ausdruck klären.</div>" : "") +
      (!S.biz.name ? '<div class="notice info">Tipp: Unter <b>Mehr → Betrieb</b> Name und Anschrift eintragen – sie erscheinen auf allen PDFs.</div>' : "") +
      '<div class="card"><h2>PDF-Dokumente</h2><div class="stack">' +
      pdfBtn("mtx", "Allergen-Matrix", "Tabelle aller Gerichte × 14 Allergene (Querformat) – für Küche und Service.") +
      pdfBtn("menu", "Speisekarte mit Kennzeichnung", "Gerichte nach Kategorie mit Buchstaben-Codes und Legende.") +
      pdfBtn("doc", "Dokumentation für die Lebensmittelkontrolle", "Rezepturen, erkannte Allergene, manuelle Festlegungen, Komponenten, Verlauf, Unterschriftsfeld.") +
      pdfBtn("sign", "Aushang „Allergeninformation“", "Hinweisschild für Gastraum/Theke mit Legende der 14 Allergene.") +
      '</div></div><div class="card"><h2>Tabelle</h2><p class="muted small">Matrix als CSV für Excel oder Kassensystem.</p><button class="btn sec" id="csv">CSV herunterladen</button></div>' +
      '<div class="card"><h2>Vorschau Matrix</h2><div class="mtx">' + matrixHtml(list) + "</div></div>";
    $main.innerHTML = html;
    d.querySelectorAll("[data-pdf]").forEach(function (b) {
      if (ro) b.disabled = true;
      b.onclick = function () { if (!guard()) return; makePdf(b.getAttribute("data-pdf")); };
    });
    d.getElementById("csv").onclick = function () { if (!guard()) return; exportCsv(); };
    if (ro) d.getElementById("csv").disabled = true;
  }
  function pdfBtn(k, t, s) { return '<div class="row"><div class="grow"><b>' + t + '</b><div class="muted small">' + s + '</div></div><button class="btn small" data-pdf="' + k + '">PDF</button></div>'; }
  function matrixHtml(list) {
    if (!list.length) return '<p class="muted">Noch keine Gerichte.</p>';
    var ord = E.ORDER.split("");
    return "<table><thead><tr><th>Gericht</th>" + ord.map(function (c) { return '<th title="' + esc(E.name(c)) + '">' + c + "</th>"; }).join("") + "</tr></thead><tbody>" +
      list.map(function (x) { var r = results[x.id] || { a: [], p: [] }; return "<tr><td>" + esc(x.name) + "</td>" + ord.map(function (c) { return r.a.indexOf(c) >= 0 ? '<td class="x">X</td>' : r.p.indexOf(c) >= 0 ? '<td class="q" title="vorsorglich">X</td>' : "<td></td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>";
  }
  function exportCsv() {
    var ord = E.ORDER.split(""), rows = [["Gericht", "Kategorie"].concat(ord.map(function (c) { return c + " " + E.name(c); })).concat(["Codes"])];
    menuDishes().forEach(function (x) { var r = results[x.id]; rows.push([x.name, x.cat].concat(ord.map(function (c) { return r.codes.indexOf(c) >= 0 ? "X" : ""; })).concat([r.codes.join(",")])); });
    var csv = "﻿" + rows.map(function (r) { return r.map(function (v) { v = String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(";"); }).join("\r\n");
    download("allergenmatrix-" + stamp() + ".csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
  }

  // ---------- PDF ----------
  var jsPdfLoading = null;
  function getJsPdf() {
    if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
    jsPdfLoading = jsPdfLoading || loadScript("assets/jspdf.umd.min.js");
    return jsPdfLoading.then(function () { return window.jspdf.jsPDF; });
  }
  function pdfSafe(s) { return String(s == null ? "" : s).replace(/[„“”]/g, '"').replace(/[‚‘’]/g, "'").replace(/[^\x20-\x7E\xA0-\xFF–—€•]/g, ""); }
  function makePdf(kind) {
    getJsPdf().then(function (JsPDF) {
      var fn = { mtx: pdfMatrix, menu: pdfMenu, doc: pdfDoc, sign: pdfSign }[kind];
      var doc = fn(JsPDF);
      var names = { mtx: "allergenmatrix", menu: "speisekarte-allergene", doc: "allergen-dokumentation", sign: "aushang-allergene" };
      doc.save(names[kind] + "-" + stamp() + ".pdf");
    }).catch(function () { toast("PDF konnte nicht erzeugt werden"); });
  }
  function bizLine() { return pdfSafe([S.biz.name, S.biz.addr].filter(Boolean).join(" · ")); }
  function footer(doc, w, h) {
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
      doc.text(pdfSafe("Stand: " + fmtDate(Date.now()) + (S.biz.name ? " · " + S.biz.name : "") + " · erstellt mit AllergenCheck"), 14, h - 8);
      doc.text("Seite " + i + "/" + n, w - 14, h - 8, { align: "right" });
      doc.setTextColor(0);
    }
  }
  function legend(doc, x, y, w, cols) {
    var all = E.allergens(), per = Math.ceil(all.length / cols), cw = w / cols;
    doc.setFontSize(8.5);
    all.forEach(function (a, i) {
      var cx = x + Math.floor(i / per) * cw, cy = y + (i % per) * 4.6;
      doc.setFont("helvetica", "bold"); doc.text(a.code, cx, cy);
      doc.setFont("helvetica", "normal"); doc.text(pdfSafe(a.name), cx + 5, cy);
    });
    return y + per * 4.6;
  }
  function pdfMatrix(JsPDF) {
    var doc = new JsPDF({ orientation: "landscape", unit: "mm", format: "a4" }), W = 297, H = 210, ord = E.ORDER.split("");
    var list = menuDishes(), nameW = W - 28 - ord.length * 12, y;
    function head() {
      doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text("Allergeninformation", 14, 16);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(bizLine() || "Kennzeichnung nach LMIV Anhang II", 14, 22);
      y = 30; doc.setFillColor(45, 106, 62); doc.rect(14, y - 5, W - 28, 8, "F"); doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
      doc.text("Gericht", 16, y); ord.forEach(function (c, i) { doc.text(c, 14 + nameW + i * 12 + 6, y, { align: "center" }); });
      doc.setTextColor(0); doc.setFont("helvetica", "normal"); y += 8;
    }
    head();
    list.forEach(function (x, k) {
      var r = results[x.id], lines = doc.splitTextToSize(pdfSafe(x.name), nameW - 4), rh = Math.max(7, lines.length * 4 + 3);
      if (y + rh > H - 45) { doc.addPage(); head(); }
      if (k % 2) { doc.setFillColor(242, 246, 240); doc.rect(14, y - 4.5, W - 28, rh, "F"); }
      doc.setFontSize(9); doc.text(lines, 16, y);
      doc.setFont("helvetica", "bold");
      ord.forEach(function (c, i) { if (r.codes.indexOf(c) >= 0) { doc.setTextColor(184, 85, 22); doc.text("X", 14 + nameW + i * 12 + 6, y, { align: "center" }); } });
      doc.setTextColor(0); doc.setFont("helvetica", "normal");
      doc.setDrawColor(220); doc.line(14, y - 4.5 + rh, W - 14, y - 4.5 + rh); y += rh;
    });
    if (y > H - 45) { doc.addPage(); y = 20; }
    legend(doc, 14, H - 36, W - 28, 4);
    footer(doc, W, H);
    return doc;
  }
  function pdfMenu(JsPDF) {
    var doc = new JsPDF({ unit: "mm", format: "a4" }), W = 210, H = 297, y = 24;
    doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.text(pdfSafe(S.biz.name || "Speisekarte"), W / 2, y, { align: "center" }); y += 7;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(pdfSafe(S.biz.name ? "Speisekarte" : ""), W / 2, y, { align: "center" }); y += 10;
    var lastCat = null;
    menuDishes().forEach(function (x) {
      var r = results[x.id];
      if (y > H - 70) { doc.addPage(); y = 20; }
      if (x.cat !== lastCat) { lastCat = x.cat; y += 3; doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(45, 106, 62); doc.text(pdfSafe(x.cat), 20, y); doc.setTextColor(0); y += 7; }
      doc.setFont("helvetica", "normal"); doc.setFontSize(11);
      var codes = r.codes.length ? r.codes.join(", ") : "";
      var lines = doc.splitTextToSize(pdfSafe(x.name), W - 70);
      doc.text(lines, 20, y);
      if (codes) { doc.setFontSize(9); doc.setTextColor(184, 85, 22); doc.text(codes, W - 20, y, { align: "right" }); doc.setTextColor(0); }
      y += lines.length * 5 + 2.5;
    });
    y = Math.max(y + 6, H - 60);
    if (y > H - 50) { doc.addPage(); y = H - 60; }
    doc.setDrawColor(200); doc.line(20, y, W - 20, y); y += 6;
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text("Allergene (Kennzeichnung nach LMIV):", 20, y); y += 5;
    legend(doc, 20, y, W - 40, 2);
    footer(doc, W, H);
    return doc;
  }
  function pdfDoc(JsPDF) {
    var doc = new JsPDF({ unit: "mm", format: "a4" }), W = 210, H = 297, y = 20, L = 16, R = W - 16;
    function need(h) { if (y + h > H - 18) { doc.addPage(); y = 18; } }
    function txt(s, size, style, indent, color) {
      doc.setFont("helvetica", style || "normal"); doc.setFontSize(size || 9.5);
      if (color) doc.setTextColor(color[0], color[1], color[2]);
      var lines = doc.splitTextToSize(pdfSafe(s), R - L - (indent || 0));
      need(lines.length * size * 0.42 + 1);
      doc.text(lines, L + (indent || 0), y); y += lines.length * (size || 9.5) * 0.42 + 1.2;
      doc.setTextColor(0);
    }
    txt("Allergen-Dokumentation", 17, "bold");
    txt("Schriftliche Dokumentation der kennzeichnungspflichtigen Allergene gemäß LMIV Art. 44 / Anhang II", 9, "normal", 0, [90, 90, 90]);
    y += 2;
    txt("Betrieb: " + (S.biz.name || "—") + (S.biz.addr ? ", " + S.biz.addr : ""), 10);
    txt("Verantwortlich: " + (S.biz.resp || "—") + (S.biz.phone ? " · Tel. " + S.biz.phone : ""), 10);
    txt("Stand: " + fmtDateTime(Date.now()) + " · " + S.dishes.length + " Einträge", 10);
    y += 3;
    var all = sortedDishes();
    all.sort(function (a, b) { return (a.base === b.base ? 0 : a.base ? 1 : -1); });
    all.forEach(function (x) {
      var r = results[x.id];
      need(22);
      doc.setDrawColor(45, 106, 62); doc.setLineWidth(0.4); doc.line(L, y, R, y); y += 5;
      txt(x.name + (x.base ? "  (Komponente)" : "  · " + x.cat), 12, "bold");
      txt("Allergene: " + (r.codes.length ? r.codes.map(function (c) { return c + " " + E.name(c); }).join(", ") : "keine der 14 Hauptallergene"), 10, "bold", 0, [184, 85, 22]);
      if (r.p.length) txt("davon vorsorglich (Herkunft je nach Produkt): " + r.p.join(", "), 8.5, "normal", 0, [120, 90, 0]);
      r.lines.forEach(function (l) {
        var c = E.union(l.eff.a, l.eff.p);
        var tag = l.ref ? "Komponente: " : "";
        var note = l.manual ? " [manuell festgelegt]" : l.status === "unknown" ? " [NICHT ERKANNT]" : "";
        txt("• " + tag + l.text + "  —  " + (c.length ? c.join(", ") : "–") + note, 9, "normal", 3);
      });
      if (x.note) txt("Notiz: " + x.note, 8.5, "italic", 3, [90, 90, 90]);
      var h = (x.hist || []).slice(-4);
      if (h.length) txt("Verlauf: " + h.map(function (e) { return fmtDate(e.at) + ": " + (E.union(e.a, e.p).join(",") || "–") + (e.via ? " (über " + e.via + ")" : ""); }).join(" | "), 8, "normal", 3, [110, 110, 110]);
      y += 2;
    });
    need(40); y += 8;
    txt("Die Angaben beruhen auf den hinterlegten Rezepturen und Produktinformationen der Lieferanten. Sie wurden mit Softwareunterstützung erstellt und vom Betrieb geprüft. Kreuzkontaminationen sind nicht berücksichtigt.", 8.5, "normal", 0, [90, 90, 90]);
    y += 16; need(12);
    doc.setDrawColor(0); doc.setLineWidth(0.2); doc.line(L, y, L + 70, y); doc.line(R - 70, y, R, y); y += 4;
    doc.setFontSize(8); doc.text("Ort, Datum", L, y); doc.text("Unterschrift Verantwortliche/r", R - 70, y);
    footer(doc, W, H);
    return doc;
  }
  function pdfSign(JsPDF) {
    var doc = new JsPDF({ unit: "mm", format: "a4" }), W = 210, H = 297;
    doc.setFillColor(45, 106, 62); doc.rect(0, 0, W, 60, "F");
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(30); doc.text("Allergeninformation", W / 2, 32, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(12); doc.text("Information about allergens", W / 2, 44, { align: "center" });
    doc.setTextColor(0); doc.setFontSize(14);
    var t = doc.splitTextToSize("Unsere Speisen und Getränke können Zutaten enthalten, die Allergien oder Unverträglichkeiten auslösen. Informationen über die 14 kennzeichnungspflichtigen Hauptallergene erhalten Sie gerne bei unserem Personal. Eine schriftliche Übersicht liegt zur Einsicht bereit.", W - 50);
    doc.text(t, 25, 82);
    doc.setFontSize(11); doc.setTextColor(90);
    doc.text(doc.splitTextToSize("Please ask our staff for information about the 14 major allergens contained in our dishes. A written list is available on request.", W - 50), 25, 82 + t.length * 6.5 + 4);
    doc.setTextColor(0);
    var y = 150; doc.setFontSize(12);
    E.allergens().forEach(function (a, i) {
      var cx = i < 7 ? 25 : 112, cy = y + (i % 7) * 12;
      doc.setFillColor(224, 113, 43); doc.roundedRect(cx, cy - 6, 9, 9, 2, 2, "F");
      doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.text(a.code, cx + 4.5, cy + 0.2, { align: "center" });
      doc.setTextColor(0); doc.setFont("helvetica", "normal"); doc.text(pdfSafe(a.name), cx + 13, cy);
    });
    if (S.biz.name) { doc.setFontSize(12); doc.setFont("helvetica", "bold"); doc.text(pdfSafe(S.biz.name), W / 2, H - 22, { align: "center" }); }
    return doc;
  }

  // ---------- Mehr ----------
  function renderMore() {
    var st = licState(), l = st.lic || {};
    var licHtml;
    if (st.mode === "active" || st.mode === "grace") licHtml = '<div class="notice ' + (st.mode === "active" ? "ok" : "") + '">' + (l.plan === "year" ? "Jahresabo" : "Monatsabo") + " · gültig bis " + fmtDate(st.until) + (st.mode === "grace" ? " – abgelaufen, noch " + GRACE_DAYS + " Tage Kulanz" : "") + '</div><p class="small muted">Code: ' + esc(l.token) + " · zuletzt geprüft " + (l.checked_at ? fmtDateTime(l.checked_at) : "–") + "</p>";
    else if (st.mode === "trial") licHtml = '<div class="notice info">Kostenlose Testphase: noch <b>' + st.left + " Tag" + (st.left === 1 ? "" : "e") + "</b> (bis " + fmtDate(st.until) + ').</div><p class="small">Danach 12 € im Monat oder 119 € im Jahr – Zahlung per Rechnung, keine automatische Abbuchung.</p>';
    else licHtml = '<div class="notice bad">' + (st.mode === "revoked" ? "Lizenz gesperrt." : st.mode === "expired" ? "Abo abgelaufen (" + fmtDate(st.until) + ")." : "Testphase beendet.") + " Die App ist im Nur-Lesen-Modus.</div>";
    var persisted = '<span id="pst">wird geprüft …</span>';
    $main.innerHTML = '<h1>Mehr</h1>' +
      '<div class="card"><h2>Lizenz</h2>' + licHtml +
      '<label for="mTok">Lizenzcode</label><div class="row"><input class="grow" type="text" id="mTok" autocomplete="off" spellcheck="false" placeholder="AC-XXXXX-XXXXX-XXXXX" value="' + esc(l.token || "") + '"><button class="btn" id="mAct">' + (l.token ? "Prüfen" : "Aktivieren") + "</button></div>" +
      '<div id="mMsg"></div><p class="small" style="margin-top:10px"><a href="kaufen.html">Abo abschließen oder verlängern →</a></p></div>' +
      '<div class="card"><h2>Betrieb</h2><p class="muted small" style="margin-top:0">Erscheint auf Speisekarte, Matrix und Dokumentation.</p>' +
      field("bName", "Name des Betriebs", S.biz.name) + field("bAddr", "Anschrift", S.biz.addr) + field("bResp", "Verantwortliche Person", S.biz.resp) + field("bPhone", "Telefon", S.biz.phone) +
      '<button class="btn" id="bSave" style="margin-top:12px">Speichern</button></div>' +
      '<div class="card"><h2>Eigene Zutaten (' + S.custom.length + ')</h2><p class="muted small" style="margin-top:0">Produkte und Hausbezeichnungen mit festen Allergenen. Haben Vorrang vor der Standard-Datenbank.</p><ul class="list" id="cl">' +
      S.custom.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "de"); }).map(function (c) { return '<li class="item" data-id="' + c.id + '"><div class="grow"><div class="t">' + esc(c.name) + '</div><div class="s">' + esc(c.syn || "") + '</div></div><div class="codes">' + chips(c.a, c.p) + "</div></li>"; }).join("") +
      '</ul><button class="btn sec" id="cAdd" style="margin-top:8px">+ Eigene Zutat</button></div>' +
      '<div class="card"><h2>Datensicherung</h2><p class="small">Ihre Daten liegen <b>nur auf diesem Gerät</b>. Bitte regelmäßig sichern – z. B. per Mail an sich selbst oder in die Cloud – und so auch auf ein neues Gerät übertragen.</p>' +
      '<div class="row"><button class="btn" id="bk">Sicherung herunterladen</button><button class="btn sec" id="rs">Sicherung einspielen</button></div>' +
      '<p class="small muted" style="margin-top:10px">Letzte Sicherung: ' + (S.backupAt ? fmtDateTime(S.backupAt) : "noch nie") + " · Dauerhafter Speicher: " + persisted + "</p></div>" +
      '<div class="card"><h2>Hinweise</h2><p class="small">AllergenCheck unterstützt Sie bei der Kennzeichnung – die Verantwortung für richtige Angaben bleibt beim Betrieb. Prüfen Sie Fertigprodukte immer anhand des Etiketts; Rezepturänderungen der Lieferanten werden nicht automatisch erkannt.</p>' +
      '<p class="small"><a href="impressum.html">Impressum</a> · <a href="datenschutz.html">Datenschutz</a> · <a href="agb.html">AGB</a> · <a href="mailto:kontakt@vaydena.de">Support</a></p><p class="small muted">Version ' + CFG.version + " · Datenbank " + E.keyCount() + " Begriffe</p></div>";

    d.getElementById("mAct").onclick = function () {
      var v = d.getElementById("mTok").value.trim().toUpperCase(), msg = d.getElementById("mMsg");
      if (!/^AC-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(v)) { msg.innerHTML = '<div class="notice bad">Format: AC-XXXXX-XXXXX-XXXXX</div>'; return; }
      msg.innerHTML = '<p class="muted small">Wird geprüft …</p>';
      checkToken(v, true).then(function (res) {
        renderChrome();
        if (res.ok) { toast("Lizenz aktiv – vielen Dank!"); renderMore(); }
        else { msg.innerHTML = '<div class="notice bad">' + esc(reasonText(res.reason)) + "</div>"; }
      });
    };
    d.getElementById("bSave").onclick = function () {
      S.biz = { name: val("bName"), addr: val("bAddr"), resp: val("bResp"), phone: val("bPhone") };
      save(); toast("Gespeichert");
    };
    d.getElementById("cAdd").onclick = function () { if (guard()) editCustom(null); };
    d.getElementById("cl").onclick = function (e) { var li = e.target.closest(".item"); if (li && guard()) editCustom(li.getAttribute("data-id")); };
    d.getElementById("bk").onclick = backup;
    d.getElementById("rs").onclick = restore;
    var pst = d.getElementById("pst");
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(function (p) { pst.textContent = p ? "ja" : "nein (Browser darf bei Platzmangel löschen – bitte sichern)"; }).catch(function () { pst.textContent = "unbekannt"; });
    else pst.textContent = "unbekannt";
  }
  function field(id, label, v) { return '<label for="' + id + '">' + label + '</label><input type="text" id="' + id + '" maxlength="160" value="' + esc(v || "") + '">'; }
  function val(id) { return d.getElementById(id).value.trim(); }
  function editCustom(id) {
    var c = id ? S.custom.filter(function (x) { return x.id === id; })[0] : { id: uid(), name: "", syn: "", a: [], p: [] };
    var sel = (c.a || []).slice();
    openDialog('<div class="dh"><h2>' + (id ? "Eigene Zutat" : "Neue eigene Zutat") + '</h2></div><div class="db"><label for="xn">Name</label><input type="text" id="xn" value="' + esc(c.name) + '" placeholder="z. B. Hausgewürz Grill">' +
      '<label for="xs">Weitere Schreibweisen (mit Komma getrennt)</label><input type="text" id="xs" value="' + esc(c.syn || "") + '" placeholder="z. B. Grillgewürz Haus, HG Grill">' +
      '<label>Enthaltene Allergene</label><div class="codelist" id="xc">' + E.allergens().map(function (x) { return '<div class="toggle' + (sel.indexOf(x.code) >= 0 ? " on" : "") + '" data-c="' + x.code + '"><b>' + x.code + "</b>" + esc(x.name) + "</div>"; }).join("") + "</div></div>" +
      '<div class="df">' + (id ? '<button class="btn danger" id="xd">Löschen</button>' : "") + '<button class="btn sec" data-close>Abbrechen</button><button class="btn" id="xo">Speichern</button></div>', function () {
        d.getElementById("xc").onclick = function (e) { var t = e.target.closest(".toggle"); if (!t) return; var k = t.getAttribute("data-c"), i = sel.indexOf(k); if (i >= 0) sel.splice(i, 1); else sel.push(k); t.classList.toggle("on", i < 0); };
        d.getElementById("xo").onclick = function () {
          var n = d.getElementById("xn").value.trim(); if (!n) { toast("Bitte Namen eingeben"); return; }
          c.name = n; c.syn = d.getElementById("xs").value.trim(); c.a = E.sortCodes(sel); c.p = []; c.at = Date.now();
          S.custom = S.custom.filter(function (x) { return x.id !== c.id; }).concat([c]);
          save(); recompute(); closeDialog(); renderMore(); toast("Gespeichert");
        };
        var del = d.getElementById("xd");
        if (del) del.onclick = function () { S.custom = S.custom.filter(function (x) { return x.id !== c.id; }); save(); recompute(); closeDialog(); renderMore(); toast("Gelöscht"); };
      });
  }
  function backup() {
    S.backupAt = Date.now(); save();
    var blob = new Blob([JSON.stringify({ app: "allergencheck", v: 1, exported: new Date().toISOString(), data: S }, null, 1)], { type: "application/json" });
    download("allergencheck-sicherung-" + stamp() + ".json", blob);
    renderMore();
  }
  function restore() {
    var inp = d.createElement("input"); inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var j; try { j = JSON.parse(rd.result); } catch (e) { toast("Datei ist keine gültige Sicherung"); return; }
        var data = j && j.app === "allergencheck" && j.data;
        if (!data || !Array.isArray(data.dishes)) { toast("Datei ist keine AllergenCheck-Sicherung"); return; }
        confirmDlg("Sicherung vom " + esc(j.exported ? fmtDateTime(Date.parse(j.exported)) : "?") + " mit " + data.dishes.length + " Einträgen einspielen? <b>Die aktuellen Daten auf diesem Gerät werden ersetzt.</b>", "Einspielen", function () {
          var created = S.created;
          S = data; S.custom = S.custom || []; S.biz = S.biz || blank().biz; S.created = Math.min(created || Date.now(), S.created || Date.now());
          save(); recompute(); renderMore(); toast("Sicherung eingespielt");
        }, true);
      };
      rd.readAsText(f);
    };
    inp.click();
  }

  // ---------- Start ----------
  function boot() {
    S = load();
    trialStart();
    fetch("assets/data/zutaten.json").then(function (r) { return r.json(); }).then(function (data) {
      E.init(data);
      recompute();
      ready = true;
      var k = "";
      try {
        var u = new URL(location.href), g = u.searchParams.get("go");
        k = u.searchParams.get("k") || "";
        if (g && /^(dishes|check|guest|export|more)$/.test(g)) tab = g;
        if (k) { u.searchParams.delete("k"); history.replaceState(null, "", u.pathname + u.search); tab = "more"; }
      } catch (e) {}
      renderChrome(); render();
      if (k) { d.getElementById("mTok").value = k.trim().toUpperCase(); d.getElementById("mAct").click(); }
      else maybeRecheck();
    }).catch(function () {
      $main.innerHTML = '<div class="notice bad">Die Zutaten-Datenbank konnte nicht geladen werden. Bitte einmal online öffnen.</div>';
    });
    window.addEventListener("online", maybeRecheck);
    d.addEventListener("visibilitychange", function () { if (!d.hidden) { renderChrome(); maybeRecheck(); } });
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
  }
  boot();
})();
