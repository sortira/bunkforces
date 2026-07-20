/* ==========================================================================
   Bunkforces — application controller
   Wires the neumorphic UI to the data layer, storage and PDF builder.
   ========================================================================== */
(function (global) {
  "use strict";

  var STATUS_LABELS = {
    todo: "To-do", thinking: "Thinking",
    solved: "Solved on paper", implemented: "Implemented",
  };

  var state = {
    problems: [],       // full CF problem list
    tagList: [],        // unique tags
    selectedTags: {},   // { tag: true }
    solved: null,       // { id: true } or null
    currentSet: [],     // picked problem objects (with .statement cached)
    ready: false,
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = {};

  // ---- utilities -----------------------------------------------------------
  var toastTimer;
  function toast(msg, isError) {
    var t = el.toast;
    t.textContent = msg;
    t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, isError ? 4500 : 2600);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- theme ---------------------------------------------------------------
  function themeGlyph(t) { return t === "dark" ? "○" : "●"; } // ○ / ●
  function initTheme() {
    var saved = localStorage.getItem("bf.theme") || "light";
    document.documentElement.setAttribute("data-theme", saved);
    el.themeToggle.textContent = themeGlyph(saved);
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("bf.theme", next);
    el.themeToggle.textContent = themeGlyph(next);
  }

  // ---- dual range ----------------------------------------------------------
  function syncRange() {
    var min = parseInt(el.ratingMin.value, 10);
    var max = parseInt(el.ratingMax.value, 10);
    if (min > max) {
      // push the thumb being dragged past the other
      if (document.activeElement === el.ratingMin) { max = min; el.ratingMax.value = max; }
      else { min = max; el.ratingMin.value = min; }
    }
    el.ratingMinLabel.textContent = min;
    el.ratingMaxLabel.textContent = max;
    var lo = (min - 800) / (3500 - 800) * 100;
    var hi = (max - 800) / (3500 - 800) * 100;
    el.ratingFill.style.left = lo + "%";
    el.ratingFill.style.width = (hi - lo) + "%";
  }

  // ---- index letter selects ------------------------------------------------
  function populateIndexSelects() {
    var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    letters.forEach(function (L) {
      el.indexMin.add(new Option(L, L));
      el.indexMax.add(new Option(L, L));
    });
    el.indexMin.value = "A";
    el.indexMax.value = "Z";
  }

  // ---- tags ----------------------------------------------------------------
  function buildTagList() {
    var counts = {};
    state.problems.forEach(function (p) {
      p.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    state.tagList = Object.keys(counts).sort();
    state.tagCounts = counts;
  }
  function renderSelectedTags() {
    el.selectedTags.innerHTML = "";
    Object.keys(state.selectedTags).sort().forEach(function (t) {
      var chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.innerHTML = '<span class="t"></span><span class="x" title="remove">✕</span>';
      chip.querySelector(".t").textContent = t;
      chip.querySelector(".x").addEventListener("click", function () {
        delete state.selectedTags[t];
        renderSelectedTags();
      });
      el.selectedTags.appendChild(chip);
    });
  }
  function renderTagDropdown() {
    var q = (el.tagSearch.value || "").toLowerCase().trim();
    var matches = state.tagList.filter(function (t) {
      return !state.selectedTags[t] && (!q || t.indexOf(q) !== -1);
    }).slice(0, 60);
    if (!matches.length) {
      el.tagDropdown.innerHTML = '<div class="tag-empty">no matching tags</div>';
    } else {
      el.tagDropdown.innerHTML = matches.map(function (t) {
        return '<button type="button" class="tag-opt" data-tag="' + esc(t) + '">' +
          esc(t) + ' <span style="opacity:.5">(' + state.tagCounts[t] + ')</span></button>';
      }).join("");
    }
    el.tagDropdown.hidden = false;
  }
  function hideTagDropdown() { el.tagDropdown.hidden = true; }
  function addTag(t) {
    if (!t) return;
    state.selectedTags[t] = true;
    el.tagSearch.value = "";
    renderSelectedTags();
    renderTagDropdown();
  }

  // ---- filter collection ---------------------------------------------------
  function activeDivisions() {
    return Array.prototype.slice.call(el.divisions.querySelectorAll(".active"))
      .map(function (b) { return b.getAttribute("data-div"); });
  }
  function activeSolvedMode() {
    var b = el.solvedFilter.querySelector(".active");
    return b ? b.getAttribute("data-solved") : "all";
  }
  function collectFilters() {
    return {
      count: Math.max(1, parseInt(el.count.value, 10) || 1),
      ratingMin: parseInt(el.ratingMin.value, 10),
      ratingMax: parseInt(el.ratingMax.value, 10),
      includeUnrated: el.includeUnrated.checked,
      divisions: activeDivisions(),
      indexMin: el.indexMin.value,
      indexMax: el.indexMax.value,
      tags: Object.keys(state.selectedTags),
      tagMode: (document.querySelector('input[name="tagMode"]:checked') || {}).value || "any",
      minSolved: parseInt(el.minSolved.value, 10) || 0,
      solvedMode: activeSolvedMode(),
      solved: state.solved,
    };
  }
  function applyFilters(filters) {
    if (!filters) return;
    if (filters.ratingMin != null) { el.ratingMin.value = filters.ratingMin; }
    if (filters.ratingMax != null) { el.ratingMax.value = filters.ratingMax; }
    if (filters.count != null) el.count.value = filters.count;
    if (filters.includeUnrated != null) el.includeUnrated.checked = filters.includeUnrated;
    if (filters.indexMin) el.indexMin.value = filters.indexMin;
    if (filters.indexMax) el.indexMax.value = filters.indexMax;
    if (filters.minSolved != null) el.minSolved.value = filters.minSolved;
    // divisions
    Array.prototype.forEach.call(el.divisions.children, function (b) {
      b.classList.toggle("active", (filters.divisions || []).indexOf(b.getAttribute("data-div")) !== -1);
    });
    // solved mode
    Array.prototype.forEach.call(el.solvedFilter.children, function (b) {
      b.classList.toggle("active", b.getAttribute("data-solved") === (filters.solvedMode || "all"));
    });
    // tags
    state.selectedTags = {};
    (filters.tags || []).forEach(function (t) { state.selectedTags[t] = true; });
    renderSelectedTags();
    syncRange();
  }

  // ---- problem cards -------------------------------------------------------
  function statusChips(p) {
    var note = BF.Store.getNote(p.id);
    return Object.keys(STATUS_LABELS).map(function (s) {
      return '<button class="status-chip' + (note.status === s ? " active" : "") +
        '" data-status="' + s + '">' + STATUS_LABELS[s] + "</button>";
    }).join("");
  }

  function cardHtml(p, i) {
    var note = BF.Store.getNote(p.id);
    var solvedBadge = state.solved && state.solved[p.id]
      ? '<span class="chip solved-badge">✓ solved</span>' : "";
    var chips = [];
    chips.push('<span class="chip index-chip">' + esc(p.index) + "</span>");
    if (p.rating != null) chips.push('<span class="chip rating">★ ' + p.rating + "</span>");
    (p.divisions || []).forEach(function (d) {
      chips.push('<span class="chip">' + (d === "edu" ? "Educational" : "Div " + d) + "</span>");
    });
    if (p.solvedCount) chips.push('<span class="chip">' + p.solvedCount.toLocaleString() + " solved</span>");
    (p.tags || []).forEach(function (t) { chips.push('<span class="chip">' + esc(t) + "</span>"); });

    var qr = BF.PDF.qrDataUrl(p.url);
    var qrHtml = qr ? '<div class="pc-qr"><img src="' + qr + '" alt="QR to problem"></div>' : "";

    return '<article class="problem-card" data-id="' + esc(p.id) + '">' +
      '<div class="pc-top"><div>' +
        '<div class="pc-title"><span class="pc-index">' + esc(p.index) + "</span>" +
          '<span class="pc-name"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
            esc(p.name) + "</a></span>" + solvedBadge + "</div>" +
        '<div class="pc-meta">' + chips.join("") + "</div>" +
      "</div>" +
      '<div class="pc-actions">' +
        '<button class="icon-btn act-reroll" title="Swap for another">↻</button>' +
        '<button class="icon-btn act-remove" title="Remove">✕</button>' +
      "</div></div>" +
      '<div class="pc-body"><div class="pc-notes-wrap">' +
        '<div class="pc-status">' + statusChips(p) + "</div>" +
        '<textarea class="pc-notes inset" placeholder="Approach, complexity guess, edge cases…">' +
          esc(note.note) + "</textarea>" +
      "</div>" + qrHtml + "</div>" +
    "</article>";
  }

  function renderSet() {
    el.setCount.textContent = state.currentSet.length + " problem" + (state.currentSet.length === 1 ? "" : "s");
    if (!state.currentSet.length) {
      el.problemList.innerHTML = "";
      el.emptyState.style.display = "";
      return;
    }
    el.emptyState.style.display = "none";
    el.problemList.innerHTML = state.currentSet.map(cardHtml).join("");
  }

  // ---- generate / reroll / remove -----------------------------------------
  function generate() {
    if (!state.ready) { toast("Problem set still loading…", true); return; }
    var f = collectFilters();
    var pool = BF.CF.candidates(state.problems, f);
    if (!pool.length) { toast("No problems match these filters — loosen them a bit.", true); return; }
    var picked = BF.CF.pick(pool, f.count, []);
    state.currentSet = picked;
    state.lastFilters = f;
    renderSet();
    if (picked.length < f.count) {
      toast("Only " + picked.length + " problems match — that's all there is.");
    } else {
      toast("Picked " + picked.length + " problems.");
    }
  }

  function rerollProblem(id) {
    var f = state.lastFilters || collectFilters();
    var pool = BF.CF.candidates(state.problems, f);
    var currentIds = state.currentSet.map(function (p) { return p.id; });
    var replacement = BF.CF.pickOne(pool, currentIds);
    if (!replacement) { toast("Nothing left to swap in.", true); return; }
    var idx = state.currentSet.findIndex(function (p) { return p.id === id; });
    if (idx !== -1) { state.currentSet[idx] = replacement; renderSet(); }
  }

  function removeProblem(id) {
    state.currentSet = state.currentSet.filter(function (p) { return p.id !== id; });
    renderSet();
  }

  // ---- sessions ------------------------------------------------------------
  function refreshSessionList() {
    var sets = BF.Store.listSets();
    el.sessionList.innerHTML = '<option value="">— load a saved set —</option>';
    sets.forEach(function (s) {
      var o = new Option(s.name + "  (" + s.problems.length + ")", s.name);
      el.sessionList.add(o);
    });
  }
  function saveSession() {
    if (!state.currentSet.length) { toast("Nothing to save yet.", true); return; }
    var name = (el.sessionName.value || "").trim() || "Untitled set";
    BF.Store.saveSet(name, state.lastFilters || collectFilters(), state.currentSet);
    refreshSessionList();
    el.sessionList.value = name;
    toast('Saved "' + name + '".');
  }
  function loadSession(name) {
    if (!name) return;
    var s = BF.Store.getSet(name);
    if (!s) return;
    state.currentSet = s.problems.slice();
    state.lastFilters = s.filters;
    el.sessionName.value = s.name;
    applyFilters(s.filters);
    renderSet();
    toast('Loaded "' + name + '".');
  }
  function deleteSession() {
    var name = el.sessionList.value;
    if (!name) { toast("Pick a saved set to delete.", true); return; }
    BF.Store.deleteSet(name);
    refreshSessionList();
    toast('Deleted "' + name + '".');
  }

  // ---- export / import -----------------------------------------------------
  function exportJson() {
    var data = BF.Store.exportAll();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bunkforces-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Exported notes & sets.");
  }
  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        var c = BF.Store.importAll(obj, "merge");
        refreshSessionList();
        renderSet();
        toast("Imported " + c.notes + " notes, " + c.sets + " sets.");
      } catch (e) { toast("Import failed: " + e.message, true); }
    };
    reader.readAsText(file);
  }

  // ---- PDF -----------------------------------------------------------------
  function downloadPdf() {
    if (!state.currentSet.length) { toast("Generate a set first.", true); return; }
    var opts = {
      font: el.pdfFont.value,
      margin: el.pdfMargin.value,
      mode: el.pdfMode.value,
      scratch: el.pdfScratch.value,
      scratchLines: el.pdfScratchLines.value,
      qr: el.pdfQr.checked,
      examples: el.pdfExamples.checked,
      title: (el.sessionName.value || "").trim() || "Bunkforces set",
      onProgress: function (done, total) {
        toast("Fetching statements… " + done + "/" + total);
      },
    };
    el.downloadPdf.classList.add("busy");
    if (opts.mode === "full") toast("Preparing full statements…");
    BF.PDF.generate(state.currentSet, opts).then(function () {
      el.downloadPdf.classList.remove("busy");
    }).catch(function (e) {
      el.downloadPdf.classList.remove("busy");
      toast("PDF failed: " + e.message, true);
    });
  }

  // ---- handle / solved -----------------------------------------------------
  function loadHandle() {
    var handle = (el.handle.value || "").trim();
    localStorage.setItem("bf.handle", handle);
    if (!handle) {
      state.solved = null;
      el.solvedHint.textContent = "(needs handle)";
      renderSet();
      return;
    }
    el.solvedHint.textContent = "(loading…)";
    BF.CF.loadSolved(handle).then(function (solved) {
      state.solved = solved;
      var n = Object.keys(solved).length;
      el.solvedHint.textContent = "(" + n + " solved by " + handle + ")";
      renderSet();
      toast(handle + ": " + n + " solved problems loaded.");
    }).catch(function (e) {
      state.solved = null;
      el.solvedHint.textContent = "(handle not found)";
      toast("Couldn't load '" + handle + "': " + e.message, true);
    });
  }

  // ---- wiring --------------------------------------------------------------
  function bindEvents() {
    el.themeToggle.addEventListener("click", toggleTheme);

    // stepper
    document.querySelectorAll(".step-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = $(btn.getAttribute("data-target"));
        var step = parseInt(btn.getAttribute("data-step"), 10);
        var v = (parseInt(target.value, 10) || 0) + step;
        v = Math.max(parseInt(target.min || "1", 10), Math.min(parseInt(target.max || "99", 10), v));
        target.value = v;
      });
    });

    // rating
    el.ratingMin.addEventListener("input", syncRange);
    el.ratingMax.addEventListener("input", syncRange);

    // division chips (toggle)
    el.divisions.addEventListener("click", function (e) {
      var b = e.target.closest(".filter-chip");
      if (b) b.classList.toggle("active");
    });
    // solved filter (single select)
    el.solvedFilter.addEventListener("click", function (e) {
      var b = e.target.closest(".filter-chip");
      if (!b) return;
      Array.prototype.forEach.call(el.solvedFilter.children, function (c) { c.classList.remove("active"); });
      b.classList.add("active");
    });

    // tags: search input opens a dropdown popover; picks become removable chips
    el.tagSearch.addEventListener("focus", renderTagDropdown);
    el.tagSearch.addEventListener("input", renderTagDropdown);
    el.tagSearch.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { hideTagDropdown(); return; }
      if (e.key === "Enter" && !el.tagDropdown.hidden) {
        var opt = el.tagDropdown.querySelector(".tag-opt");
        if (opt) { e.preventDefault(); addTag(opt.getAttribute("data-tag")); }
      }
    });
    el.tagDropdown.addEventListener("mousedown", function (e) {
      var opt = e.target.closest(".tag-opt");
      if (!opt) return;
      e.preventDefault(); // keep focus in the input
      addTag(opt.getAttribute("data-tag"));
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".tag-input-wrap")) hideTagDropdown();
    });

    el.generate.addEventListener("click", generate);

    el.handle.addEventListener("change", loadHandle);

    // session
    el.saveSession.addEventListener("click", saveSession);
    el.sessionList.addEventListener("change", function () { loadSession(el.sessionList.value); });
    el.deleteSession.addEventListener("click", deleteSession);

    // export/import
    el.exportJson.addEventListener("click", exportJson);
    el.importJson.addEventListener("click", function () { el.importFile.click(); });
    el.importFile.addEventListener("change", function () {
      if (el.importFile.files[0]) importJson(el.importFile.files[0]);
      el.importFile.value = "";
    });

    el.downloadPdf.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      downloadPdf();
    });

    // problem list delegation
    el.problemList.addEventListener("click", function (e) {
      var card = e.target.closest(".problem-card");
      if (!card) return;
      var id = card.getAttribute("data-id");
      if (e.target.closest(".act-reroll")) return rerollProblem(id);
      if (e.target.closest(".act-remove")) return removeProblem(id);
      var statusBtn = e.target.closest(".status-chip");
      if (statusBtn) {
        var s = statusBtn.getAttribute("data-status");
        BF.Store.setNote(id, { status: s });
        card.querySelectorAll(".status-chip").forEach(function (c) { c.classList.remove("active"); });
        statusBtn.classList.add("active");
      }
    });
    el.problemList.addEventListener("input", function (e) {
      if (e.target.classList.contains("pc-notes")) {
        var card = e.target.closest(".problem-card");
        BF.Store.setNote(card.getAttribute("data-id"), { note: e.target.value });
      }
    });
  }

  // ---- init ----------------------------------------------------------------
  function init() {
    [
      "themeToggle", "handle", "count", "ratingMin", "ratingMax", "ratingMinLabel",
      "ratingMaxLabel", "ratingFill", "includeUnrated", "divisions", "indexMin", "indexMax",
      "tagSearch", "tagDropdown", "selectedTags", "minSolved", "solvedFilter", "solvedHint", "generate",
      "datasetStatus", "sessionName", "saveSession", "sessionList", "deleteSession",
      "exportJson", "importJson", "importFile", "pdfPanel", "downloadPdf", "pdfFont",
      "pdfMargin", "pdfMode", "pdfScratch", "pdfScratchLines", "pdfQr",
      "pdfExamples", "setCount", "problemList", "emptyState", "toast",
    ].forEach(function (id) { el[id] = $(id); });

    initTheme();
    populateIndexSelects();
    syncRange();
    bindEvents();
    refreshSessionList();

    var savedHandle = localStorage.getItem("bf.handle");
    if (savedHandle) { el.handle.value = savedHandle; }

    BF.CF.detectBackend().then(function (base) {
      if (base !== null) toast("Backend connected — full statements available.");
    });

    el.datasetStatus.textContent = "Loading problem set…";
    BF.CF.loadProblemset().then(function (res) {
      state.problems = res.data.problems;
      state.ready = true;
      buildTagList();
      renderSelectedTags();
      var d = new Date(res.data.fetchedAt);
      el.datasetStatus.textContent = state.problems.length.toLocaleString() +
        " problems" + (res.fromCache ? " (cached " + d.toLocaleDateString() + ")" : " (fresh)");
      if (savedHandle) loadHandle();
    }).catch(function (e) {
      el.datasetStatus.textContent = "Failed to load problems.";
      toast("Couldn't reach Codeforces: " + e.message, true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }

  global.BF = global.BF || {};
  global.BF.app = { state: state, generate: generate };
})(window);
