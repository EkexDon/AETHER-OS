/* AETHER-OS site search — dependency-free, works from file:// and any
   static host. The index is loaded by search-index.js, which assigns
   window.AETHER_SEARCH_INDEX = [{ t, u, f, g, x }] (title, url, folder,
   tags, text). Press "/" to focus, ↑/↓ to move, Enter to open, Esc to close. */
(function () {
  "use strict";
  var input = document.getElementById("site-search-input");
  var box = document.getElementById("site-search-results");
  if (!input || !box) return;
  var root = document.body.getAttribute("data-root") || "";
  var index = [];
  var active = -1;
  var results = [];

  function load() {
    var raw = window.AETHER_SEARCH_INDEX;
    if (!Array.isArray(raw)) return;
    index = raw.map(function (e) {
      return {
        entry: e,
        title: String(e.t || "").toLowerCase(),
        tags: (e.g || []).join(" ").toLowerCase(),
        folder: String(e.f || "").toLowerCase(),
        text: String(e.x || "").toLowerCase()
      };
    });
  }

  function score(item, terms) {
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      var s = 0;
      if (item.title.indexOf(term) === 0) s += 12;
      else if (item.title.indexOf(term) > -1) s += 8;
      if (item.tags.indexOf(term) > -1) s += 5;
      if (item.folder.indexOf(term) > -1) s += 2;
      if (item.text.indexOf(term) > -1) s += 1;
      if (s === 0) return 0;
      total += s;
    }
    return total;
  }

  function excerpt(text, term) {
    var lower = text.toLowerCase();
    var at = term ? lower.indexOf(term) : -1;
    if (at < 0) return text.slice(0, 96);
    var start = Math.max(0, at - 36);
    return (start > 0 ? "…" : "") + text.slice(start, start + 96);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function render(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    clear(box);
    active = -1;
    if (!terms.length) {
      box.hidden = true;
      results = [];
      return;
    }
    results = index
      .map(function (item) { return { item: item, s: score(item, terms) }; })
      .filter(function (r) { return r.s > 0; })
      .sort(function (a, b) { return b.s - a.s || a.item.title.localeCompare(b.item.title); })
      .slice(0, 12)
      .map(function (r) { return r.item.entry; });
    if (!results.length) {
      var empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No notes match “" + query + "”";
      box.appendChild(empty);
    }
    results.forEach(function (entry, i) {
      var a = document.createElement("a");
      a.className = "search-result";
      a.href = root + entry.u;
      a.id = "search-result-" + i;
      a.setAttribute("role", "option");
      var title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = entry.t;
      var meta = document.createElement("span");
      meta.className = "search-result-meta";
      meta.textContent = (entry.f ? entry.f + " · " : "") + excerpt(String(entry.x || ""), terms[0]);
      a.appendChild(title);
      a.appendChild(meta);
      box.appendChild(a);
    });
    box.hidden = false;
  }

  function select(i) {
    var items = box.querySelectorAll(".search-result");
    if (!items.length) return;
    active = (i + items.length) % items.length;
    for (var k = 0; k < items.length; k++) {
      items[k].setAttribute("aria-selected", k === active ? "true" : "false");
    }
    input.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", function () { render(input.value); });
  input.addEventListener("focus", function () { if (input.value) render(input.value); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); select(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(active - 1); }
    else if (e.key === "Enter") {
      var target = results[active > -1 ? active : 0];
      if (target) { e.preventDefault(); window.location.href = root + target.u; }
    } else if (e.key === "Escape") {
      input.value = "";
      render("");
      input.blur();
    }
  });
  document.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName) || "";
    if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      input.focus();
    }
  });
  document.addEventListener("click", function (e) {
    if (!box.contains(e.target) && e.target !== input) box.hidden = true;
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
