/* ==========================================================================
   Bunkforces — Local persistence (notes, statuses, saved problem sets)
   Everything lives in the browser. No account, no server.
   ========================================================================== */
(function (global) {
  "use strict";

  var K_NOTES = "bf.notes.v1";     // { [problemId]: { note, status, updatedAt } }
  var K_SETS = "bf.sets.v1";       // { [name]: { name, savedAt, filters, problems:[] } }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  // ---- Notes + status (per problem, independent of which set it's in) ------
  function getNote(id) {
    var notes = read(K_NOTES, {});
    return notes[id] || { note: "", status: "todo" };
  }
  function setNote(id, patch) {
    var notes = read(K_NOTES, {});
    var cur = notes[id] || { note: "", status: "todo" };
    notes[id] = Object.assign(cur, patch, { updatedAt: Date.now() });
    write(K_NOTES, notes);
    return notes[id];
  }
  function allNotes() { return read(K_NOTES, {}); }

  // ---- Saved problem sets --------------------------------------------------
  function listSets() {
    var sets = read(K_SETS, {});
    return Object.keys(sets).map(function (k) { return sets[k]; })
      .sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
  }
  function saveSet(name, filters, problems) {
    name = (name || "").trim();
    if (!name) name = "Untitled set";
    var sets = read(K_SETS, {});
    sets[name] = {
      name: name,
      savedAt: Date.now(),
      filters: filters || {},
      problems: (problems || []).map(function (p) {
        // store enough to fully rebuild the set without re-fetching
        return {
          id: p.id, contestId: p.contestId, index: p.index, name: p.name,
          type: p.type, points: p.points, rating: p.rating, tags: p.tags,
          divisions: p.divisions, solvedCount: p.solvedCount, url: p.url,
        };
      }),
    };
    write(K_SETS, sets);
    return sets[name];
  }
  function getSet(name) { return read(K_SETS, {})[name] || null; }
  function deleteSet(name) {
    var sets = read(K_SETS, {});
    delete sets[name];
    write(K_SETS, sets);
  }

  // ---- Export / import -----------------------------------------------------
  function exportAll() {
    return {
      _app: "bunkforces",
      _version: 1,
      exportedAt: new Date().toISOString(),
      notes: read(K_NOTES, {}),
      sets: read(K_SETS, {}),
    };
  }
  function importAll(obj, mode) {
    // mode: "merge" (default) | "replace"
    if (!obj || obj._app !== "bunkforces") throw new Error("Not a Bunkforces export file.");
    var counts = { notes: 0, sets: 0 };
    if (mode === "replace") {
      write(K_NOTES, obj.notes || {});
      write(K_SETS, obj.sets || {});
      counts.notes = Object.keys(obj.notes || {}).length;
      counts.sets = Object.keys(obj.sets || {}).length;
      return counts;
    }
    var notes = read(K_NOTES, {});
    Object.keys(obj.notes || {}).forEach(function (id) {
      var incoming = obj.notes[id];
      var cur = notes[id];
      // Newer wins on conflict.
      if (!cur || (incoming.updatedAt || 0) >= (cur.updatedAt || 0)) {
        notes[id] = incoming; counts.notes++;
      }
    });
    write(K_NOTES, notes);

    var sets = read(K_SETS, {});
    Object.keys(obj.sets || {}).forEach(function (name) {
      sets[name] = obj.sets[name]; counts.sets++;
    });
    write(K_SETS, sets);
    return counts;
  }

  global.BF = global.BF || {};
  global.BF.Store = {
    getNote: getNote, setNote: setNote, allNotes: allNotes,
    listSets: listSets, saveSet: saveSet, getSet: getSet, deleteSet: deleteSet,
    exportAll: exportAll, importAll: importAll,
  };
})(window);
