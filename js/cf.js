/* ==========================================================================
   Bunkforces — Codeforces data layer
   Fetches the public Codeforces API directly from the browser (CORS-enabled,
   no API key). Caches the problem set in localStorage for offline use.
   The optional FastAPI backend is only used to enrich full statements.
   ========================================================================== */
(function (global) {
  "use strict";

  var API = "https://codeforces.com/api/";
  var CACHE_KEY = "bf.problemset.v1";
  var CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  // Backend base URL. When the frontend is served by the FastAPI app (hosted or
  // local) this is same-origin (""), so all backend calls are RELATIVE. Only a
  // page opened straight off disk (file://) or on localhost probes a local port.
  var backendBase = null;      // resolved: null = none, "" = same origin, or a URL
  var detectPromise = null;    // cached detection promise (avoids re-checks/races)

  function problemUrl(contestId, index) {
    return "https://codeforces.com/problemset/problem/" + contestId + "/" + index;
  }
  function problemId(contestId, index) {
    return contestId + "-" + index;
  }

  function divisionsOf(name) {
    var set = [];
    name = name || "";
    if (/educational/i.test(name)) set.push("edu");
    if (/div\.?\s*1\b/i.test(name)) set.push("1");
    if (/div\.?\s*2\b/i.test(name)) set.push("2");
    if (/div\.?\s*3\b/i.test(name)) set.push("3");
    if (/div\.?\s*4\b/i.test(name)) set.push("4");
    return set;
  }

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // ---- Problem set (problemset.problems + contest.list) --------------------
  function fetchFresh() {
    return Promise.all([
      fetchJson(API + "problemset.problems"),
      fetchJson(API + "contest.list?gym=false"),
    ]).then(function (res) {
      var ps = res[0], cl = res[1];
      if (ps.status !== "OK") throw new Error("problemset: " + (ps.comment || "error"));

      // contestId -> divisions[]
      var divMap = {};
      if (cl.status === "OK") {
        cl.result.forEach(function (c) { divMap[c.id] = divisionsOf(c.name); });
      }

      // contestId-index -> solvedCount
      var solveMap = {};
      ps.result.problemStatistics.forEach(function (s) {
        solveMap[problemId(s.contestId, s.index)] = s.solvedCount;
      });

      var problems = ps.result.problems
        .filter(function (p) { return p.contestId != null && p.index; })
        .map(function (p) {
          var id = problemId(p.contestId, p.index);
          return {
            id: id,
            contestId: p.contestId,
            index: p.index,
            name: p.name,
            type: p.type,
            points: p.points || null,
            rating: p.rating || null,
            tags: p.tags || [],
            divisions: divMap[p.contestId] || [],
            solvedCount: solveMap[id] || 0,
            url: problemUrl(p.contestId, p.index),
          };
        });

      return { fetchedAt: Date.now(), problems: problems };
    });
  }

  function loadProblemset(forceRefresh) {
    return new Promise(function (resolve, reject) {
      if (!forceRefresh) {
        try {
          var raw = localStorage.getItem(CACHE_KEY);
          if (raw) {
            var cached = JSON.parse(raw);
            if (cached && cached.problems && cached.problems.length) {
              var fresh = Date.now() - cached.fetchedAt < CACHE_TTL;
              resolve({ data: cached, fromCache: true, stale: !fresh });
              // Refresh in background if stale, but don't block.
              if (!fresh) {
                fetchFresh().then(function (d) {
                  try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
                }).catch(function () {});
              }
              return;
            }
          }
        } catch (e) { /* fall through to network */ }
      }
      fetchFresh().then(function (d) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
        resolve({ data: d, fromCache: false, stale: false });
      }).catch(reject);
    });
  }

  // ---- Solved problems for a handle ---------------------------------------
  function loadSolved(handle) {
    if (!handle) return Promise.resolve(null);
    return fetchJson(API + "user.status?handle=" + encodeURIComponent(handle))
      .then(function (d) {
        if (d.status !== "OK") throw new Error(d.comment || "bad handle");
        var solved = {};
        d.result.forEach(function (sub) {
          if (sub.verdict === "OK" && sub.problem && sub.problem.contestId) {
            solved[problemId(sub.problem.contestId, sub.problem.index)] = true;
          }
        });
        return solved;
      });
  }

  // ---- Filtering + picking -------------------------------------------------
  function matches(p, f) {
    // rating
    if (p.rating == null) {
      if (!f.includeUnrated) return false;
    } else {
      if (p.rating < f.ratingMin || p.rating > f.ratingMax) return false;
    }
    // divisions
    if (f.divisions && f.divisions.length) {
      var hit = p.divisions.some(function (d) { return f.divisions.indexOf(d) !== -1; });
      if (!hit) return false;
    }
    // index range (compare leading letter)
    var letter = (p.index[0] || "").toUpperCase();
    if (letter < f.indexMin || letter > f.indexMax) return false;
    // tags
    if (f.tags && f.tags.length) {
      if (f.tagMode === "all") {
        var all = f.tags.every(function (t) { return p.tags.indexOf(t) !== -1; });
        if (!all) return false;
      } else {
        var any = f.tags.some(function (t) { return p.tags.indexOf(t) !== -1; });
        if (!any) return false;
      }
    }
    // min solve count
    if (f.minSolved && p.solvedCount < f.minSolved) return false;
    // solved status
    if (f.solvedMode && f.solvedMode !== "all" && f.solved) {
      var isSolved = !!f.solved[p.id];
      if (f.solvedMode === "solved" && !isSolved) return false;
      if (f.solvedMode === "unsolved" && isSolved) return false;
    }
    return true;
  }

  function candidates(problems, f) {
    return problems.filter(function (p) { return matches(p, f); });
  }

  // Fisher–Yates pick of n unique problems from the candidate pool,
  // excluding any ids already present.
  function pick(pool, n, excludeIds) {
    var exclude = {};
    (excludeIds || []).forEach(function (id) { exclude[id] = true; });
    var avail = pool.filter(function (p) { return !exclude[p.id]; });
    for (var i = avail.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = avail[i]; avail[i] = avail[j]; avail[j] = t;
    }
    return avail.slice(0, n);
  }

  function pickOne(pool, excludeIds) {
    var r = pick(pool, 1, excludeIds);
    return r.length ? r[0] : null;
  }

  // ---- Backend detection + statement fetch --------------------------------
  function backendCandidates() {
    var isHttp = location.protocol === "http:" || location.protocol === "https:";
    if (isHttp) {
      // Hosted (Railway, etc.) or served locally: ALWAYS use the same origin,
      // relative — never a hardcoded host. On localhost only, also try the
      // default dev port in case the static server and API run separately.
      var host = location.hostname;
      if (host === "localhost" || host === "127.0.0.1") {
        return ["", "http://localhost:8000", "http://127.0.0.1:8000"];
      }
      return [""];
    }
    // Opened straight off disk (file://): look for a local backend.
    return ["http://localhost:8000", "http://127.0.0.1:8000"];
  }

  function detectBackend() {
    if (detectPromise) return detectPromise;
    var candidates = backendCandidates();
    var i = 0;
    function tryNext() {
      if (i >= candidates.length) { backendBase = null; return null; }
      var base = candidates[i++];
      return fetch(base + "/api/health", { cache: "no-store" })
        .then(function (r) {
          // A static host answering every path with index.html would return 200
          // HTML — require real JSON so we don't mistake that for a backend.
          var ct = (r.headers.get("content-type") || "");
          if (!r.ok || ct.indexOf("application/json") === -1) return Promise.reject();
          return r.json();
        })
        .then(function () { backendBase = base; return base; })
        .catch(function () { return tryNext(); });
    }
    detectPromise = Promise.resolve().then(tryNext);
    return detectPromise;
  }

  function hasBackend() { return backendBase !== null; }

  function tryStatement(base, contestId, index) {
    return fetch(base + "/api/statement/" + contestId + "/" + index, { cache: "no-store" })
      .then(function (r) {
        // Reject non-JSON (e.g. a static host returning index.html) so we don't
        // treat an HTML fallback page as a valid statement response.
        var ct = r.headers.get("content-type") || "";
        if (!r.ok || ct.indexOf("application/json") === -1) return Promise.reject();
        return r.json();
      });
  }

  // Fetch a statement by hitting the API directly (relative, same-origin when
  // hosted). No separate health gate — if the backend is there the call
  // succeeds; if not, we degrade to header + QR.
  function fetchStatement(contestId, index) {
    var candidates = backendBase !== null ? [backendBase] : backendCandidates();
    var i = 0;
    function tryNext() {
      if (i >= candidates.length) return { available: false, reason: "no-backend" };
      var base = candidates[i++];
      return tryStatement(base, contestId, index)
        .then(function (data) { backendBase = base; return data; })
        .catch(function () { return tryNext(); });
    }
    return Promise.resolve().then(tryNext);
  }

  global.BF = global.BF || {};
  global.BF.CF = {
    loadProblemset: loadProblemset,
    loadSolved: loadSolved,
    candidates: candidates,
    pick: pick,
    pickOne: pickOne,
    matches: matches,
    detectBackend: detectBackend,
    hasBackend: hasBackend,
    fetchStatement: fetchStatement,
    problemUrl: problemUrl,
    problemId: problemId,
  };
})(window);
