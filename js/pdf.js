/* ==========================================================================
   Bunkforces — PDF / print builder
   Builds a clean, ink-friendly print document into #printRoot and triggers the
   browser's native "Save as PDF". Math is rendered with MathJax (loaded lazily,
   only when full statements are requested). Falls back to header + QR cards
   when statements aren't available (no backend / Cloudflare-blocked).
   ========================================================================== */
(function (global) {
  "use strict";

  var mathjaxLoading = null;

  function loadMathJax() {
    if (global.MathJax && global.MathJax.typesetPromise) return Promise.resolve();
    if (mathjaxLoading) return mathjaxLoading;
    mathjaxLoading = new Promise(function (resolve) {
      global.MathJax = {
        tex: {
          // Codeforces only ever uses $$$...$$$ (inline). Defining a $$$$$$
          // display delimiter overlaps it and makes MathJax miscount offsets on
          // adjacent math ($$$a$$$$$$b$$$) — the "splitText offset" crash. So we
          // define ONLY the inline delimiter.
          inlineMath: [["$$$", "$$$"]],
          displayMath: [],
          processEscapes: true,
        },
        svg: { fontCache: "none" },
        options: { skipHtmlTags: ["script", "noscript", "style", "textarea"] },
        startup: {
          ready: function () {
            global.MathJax.startup.defaultReady();
            resolve();
          },
        },
      };
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
      s.async = true;
      s.onerror = function () { resolve(); }; // degrade: raw $$$ text stays
      document.head.appendChild(s);
    });
    return mathjaxLoading;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Render math block-by-block so one malformed statement (e.g. MathJax's
  // "splitText offset larger than node length") can't abort the whole PDF.
  // A block that fails to typeset simply keeps its raw $$$ text; every other
  // block still renders, and the PDF is always produced.
  function typesetMath(root) {
    var MJ = global.MathJax;
    if (!MJ || !MJ.typesetPromise) return Promise.resolve();
    var nodes = Array.prototype.slice.call(
      root.querySelectorAll(".pp-statement, .pp-io, .pp-meta")
    );
    if (!nodes.length) nodes = [root];
    return nodes.reduce(function (chain, node) {
      return chain.then(function () {
        return MJ.typesetPromise([node]).catch(function () {
          // Discard any half-rendered math on this node and move on.
          try { if (MJ.typesetClear) MJ.typesetClear([node]); } catch (e) {}
        });
      });
    }, Promise.resolve()).catch(function () {});
  }

  function qrDataUrl(text) {
    try {
      var qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      return qr.createDataURL(4, 8);
    } catch (e) { return null; }
  }

  function metaLine(p) {
    var bits = [];
    bits.push("Contest " + p.contestId);
    if (p.rating != null) bits.push("Rating " + p.rating);
    if (p.solvedCount) bits.push(p.solvedCount.toLocaleString() + " solved");
    if (p.divisions && p.divisions.length) {
      bits.push(p.divisions.map(function (d) { return d === "edu" ? "Edu" : "Div " + d; }).join("/"));
    }
    if (p.tags && p.tags.length) bits.push(p.tags.join(", "));
    return bits.map(esc).join('<span class="sep">•</span>');
  }

  function scratchBlock(opts) {
    if (!opts.scratch || opts.scratch === "none" || !opts.scratchLines) return "";
    var h = (parseFloat(opts.scratchLines) * 1.6).toFixed(1) + "em";
    return '<div class="pp-scratch ' + esc(opts.scratch) + '" style="--scratch-h:' + h + '"></div>';
  }

  function examplesBlock(p) {
    var st = p.statement;
    if (!st || !st.examples || !st.examples.length) return "";
    var rows = st.examples.map(function (ex, i) {
      return '<tr><td>' + esc(ex.input) + '</td><td>' + esc(ex.output) + '</td></tr>';
    }).join("");
    return '<div class="pp-examples"><div class="pp-section-title">Examples</div>' +
      '<table><thead><tr><th>Input</th><th>Output</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function statementBlock(p) {
    var st = p.statement;
    if (!st || !st.available) {
      return '<div class="pp-unavailable">Full statement not embedded here — scan the QR code or open the problem URL to read it.</div>';
    }
    var html = "";
    if (st.timeLimit || st.memoryLimit) {
      html += '<div class="pp-meta">';
      if (st.timeLimit) html += "time limit: " + esc(st.timeLimit);
      if (st.timeLimit && st.memoryLimit) html += '<span class="sep">•</span>';
      if (st.memoryLimit) html += "memory limit: " + esc(st.memoryLimit);
      html += "</div>";
    }
    if (st.statementHtml) html += '<div class="pp-statement">' + st.statementHtml + "</div>";
    if (st.inputHtml) html += '<div class="pp-io"><div class="pp-section-title">Input</div>' + st.inputHtml + "</div>";
    if (st.outputHtml) html += '<div class="pp-io"><div class="pp-section-title">Output</div>' + st.outputHtml + "</div>";
    return html;
  }

  function noteBlock(p) {
    var st = p.statement;
    if (!st || !st.available || !st.noteHtml) return "";
    return '<div class="pp-io"><div class="pp-section-title">Note</div>' + st.noteHtml + "</div>";
  }

  function problemBlock(p, opts) {
    var qrHtml = "";
    if (opts.qr) {
      var d = qrDataUrl(p.url);
      if (d) qrHtml = '<div class="pp-qr"><img src="' + d + '" alt="QR"></div>';
    }
    var full = opts.mode === "full";
    var body = full ? statementBlock(p) : "";
    if (full && opts.examples) body += examplesBlock(p);
    if (full) body += noteBlock(p);

    var noBreak = full ? "" : " no-break";

    return '<article class="print-problem' + noBreak + '">' +
      '<div class="pp-head"><div class="pp-headline">' +
        '<div class="pp-num"><span class="idx">' + esc(p.index) + '</span>. ' + esc(p.name) + '</div>' +
        '<div class="pp-meta">' + metaLine(p) + '</div>' +
        '<div class="pp-url">' + esc(p.url) + '</div>' +
      '</div>' + qrHtml + '</div>' +
      body +
      scratchBlock(opts) +
      '</article>';
  }

  // Ensure statements are present for full mode (fetches missing ones).
  function ensureStatements(problems, opts) {
    if (opts.mode !== "full") return Promise.resolve();
    var need = problems.filter(function (p) { return !p.statement; });
    if (!need.length) return Promise.resolve();
    var done = 0, total = need.length;
    if (opts.onProgress) opts.onProgress(0, total);
    return Promise.all(need.map(function (p) {
      return BF.CF.fetchStatement(p.contestId, p.index).then(function (st) {
        p.statement = st || { available: false };
        done++;
        if (opts.onProgress) opts.onProgress(done, total);
      });
    }));
  }

  function generate(problems, opts) {
    opts = opts || {};
    var root = document.getElementById("printRoot");

    return ensureStatements(problems, opts).then(function () {
      var title = opts.title || "Bunkforces set";
      var header = '<div class="print-title">' +
        '<img class="pp-logo" src="bunkforces%20logo.png" alt="Bunkforces">' +
        '<h1>' + esc(title) + '</h1>' +
        '<div class="sub">' + problems.length + ' problems • Codeforces • generated with Bunkforces</div>' +
        '<div class="sub">aritro.is-a.dev &middot; x.com/silicognition</div></div>';
      var body = problems.map(function (p) { return problemBlock(p, opts); }).join("");
      // Repeating per-page footer via the <tfoot> table technique: a
      // table-footer-group is reprinted at the bottom of every page (page 1
      // included) AND reserves its space so content never overlaps it. This is
      // the reliable cross-page footer method in print (position:fixed drops
      // the footer from the first page in Chromium).
      var footer = 'Set generated by Bunkforces, built by Aritro "sortira" Shome';
      root.innerHTML =
        '<table class="print-wrap"><tfoot><tr><td>' +
          '<div class="print-footer">' + footer + '</div>' +
        '</td></tr></tfoot><tbody><tr><td>' +
          '<div class="print-doc">' + header + body + '</div>' +
        '</td></tr></tbody></table>';

      // Apply page/font/margin variables (read by print.css).
      var docEl = document.documentElement;
      docEl.style.setProperty("--print-font", (opts.font || 10) + "pt");
      docEl.style.setProperty("--print-margin", (opts.margin || 12) + "mm");

      var needsMath = opts.mode === "full" && /\$\$\$/.test(root.textContent || "");
      var ready = needsMath
        ? loadMathJax().then(function () { return typesetMath(root); }).catch(function () {})
        : Promise.resolve();

      return ready.then(function () {
        return new Promise(function (resolve) {
          function after() {
            window.removeEventListener("afterprint", after);
            resolve();
          }
          window.addEventListener("afterprint", after);
          // Give the browser a tick to lay out embedded SVGs/images.
          setTimeout(function () { window.print(); }, 120);
        });
      });
    });
  }

  global.BF = global.BF || {};
  global.BF.PDF = { generate: generate, qrDataUrl: qrDataUrl };
})(window);
