"""
Bunkforces backend (optional).

The frontend is fully functional on its own: it talks to the public Codeforces
API directly from the browser (CORS-enabled, no API key) for the problem list,
statistics and per-user solved sets.

This small FastAPI app exists only for the ONE thing the browser can't do:
fetch full problem *statements*. Codeforces problem pages sit behind Cloudflare
and don't send CORS headers, so a browser can't read them. This server fetches
them from your own machine/IP and parses them into clean JSON.

Notes on Cloudflare:
  Codeforces problem pages are protected by Cloudflare's bot challenge. A plain
  request from a datacenter IP is usually blocked (HTTP 403). From your own
  residential IP it often works. If it still gets blocked, paste your browser's
  Codeforces cookies (see README) so requests use your logged-in session.

Run:
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000
Then open http://localhost:8000
"""

import os
import re
import json
import time
import pathlib

import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# --------------------------------------------------------------------------- #
# Paths / config
# --------------------------------------------------------------------------- #
HERE = pathlib.Path(__file__).resolve().parent
FRONTEND_DIR = HERE.parent                 # project root holds index.html
CACHE_DIR = HERE / "cache"
CACHE_DIR.mkdir(exist_ok=True)

CF_BASE = "https://codeforces.com"

# Optional: your Codeforces cookies to get past Cloudflare reliably.
# Provide via env var BUNKFORCES_CF_COOKIE or a file backend/cf_cookie.txt.
def _load_cookie() -> str:
    env = os.environ.get("BUNKFORCES_CF_COOKIE", "").strip()
    if env:
        return env
    f = HERE / "cf_cookie.txt"
    if f.exists():
        return f.read_text(encoding="utf-8").strip()
    return ""

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://codeforces.com/problemset",
}

app = FastAPI(title="Bunkforces backend", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _absolutize(soup: BeautifulSoup) -> None:
    """Rewrite protocol-relative / root-relative asset URLs to absolute."""
    for tag, attr in (("img", "src"), ("a", "href")):
        for node in soup.find_all(tag):
            v = node.get(attr)
            if not v:
                continue
            if v.startswith("//"):
                node[attr] = "https:" + v
            elif v.startswith("/"):
                node[attr] = CF_BASE + v


def _inner_html_without_title(node) -> str:
    """Return inner HTML of a spec block, dropping its .section-title header."""
    if node is None:
        return ""
    clone = BeautifulSoup(str(node), "html.parser")
    title = clone.find(class_="section-title")
    if title:
        title.decompose()
    # unwrap the outer wrapper div, keep its children
    wrapper = clone.find(True)
    return wrapper.decode_contents() if wrapper else clone.decode_contents()


def _pre_text(pre) -> str:
    """Extract sample I/O text, honoring Codeforces' per-line divs and <br>."""
    lines = pre.find_all("div", class_="test-example-line")
    if lines:
        return "\n".join(l.get_text() for l in lines).strip("\n")
    for br in pre.find_all("br"):
        br.replace_with("\n")
    return pre.get_text().strip("\n")


def _looks_blocked(html: str) -> bool:
    markers = ("Just a moment", "cf-challenge", "Cloudflare", "Attention Required",
               "Enable JavaScript and cookies to continue")
    return any(m in html for m in markers)


def _parse_statement(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    stmt = soup.find(class_="problem-statement")
    if stmt is None:
        return {"available": False, "reason": "no-statement"}

    _absolutize(stmt)

    header = stmt.find(class_="header")
    title = ""
    time_limit = memory_limit = ""
    if header:
        t = header.find(class_="title")
        if t:
            title = re.sub(r"^[A-Z]\d*\.\s*", "", t.get_text(strip=True))
        tl = header.find(class_="time-limit")
        ml = header.find(class_="memory-limit")
        if tl:
            time_limit = tl.get_text(" ", strip=True).replace("time limit per test", "").strip()
        if ml:
            memory_limit = ml.get_text(" ", strip=True).replace("memory limit per test", "").strip()

    # The legend is the first direct child <div> of .problem-statement that has
    # no class attribute (it sits right after .header).
    legend_html = ""
    for child in stmt.find_all("div", recursive=False):
        if not child.get("class"):
            legend_html = child.decode_contents()
            break

    input_spec = _inner_html_without_title(stmt.find(class_="input-specification"))
    output_spec = _inner_html_without_title(stmt.find(class_="output-specification"))
    note_html = _inner_html_without_title(stmt.find(class_="note"))

    examples = []
    sample = stmt.find(class_="sample-tests")
    if sample:
        inputs = sample.find_all(class_="input")
        outputs = sample.find_all(class_="output")
        for i in range(min(len(inputs), len(outputs))):
            ip = inputs[i].find("pre")
            op = outputs[i].find("pre")
            examples.append({
                "input": _pre_text(ip) if ip else "",
                "output": _pre_text(op) if op else "",
            })

    return {
        "available": True,
        "title": title,
        "timeLimit": time_limit,
        "memoryLimit": memory_limit,
        "statementHtml": legend_html,
        "inputHtml": input_spec,
        "outputHtml": output_spec,
        "examples": examples,
        "noteHtml": note_html,
    }


def _fetch_html(contest_id: int, index: str):
    cookie = _load_cookie()
    headers = dict(BROWSER_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    urls = [
        f"{CF_BASE}/problemset/problem/{contest_id}/{index}",
        f"{CF_BASE}/contest/{contest_id}/problem/{index}",
    ]
    last_status = None
    for url in urls:
        try:
            r = requests.get(url, headers=headers, timeout=20)
            last_status = r.status_code
            if r.status_code == 200 and not _looks_blocked(r.text):
                return r.text, None
        except requests.RequestException as e:
            last_status = str(e)
    return None, last_status


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    return {"ok": True, "hasCookie": bool(_load_cookie())}


@app.get("/api/statement/{contest_id}/{index}")
def statement(contest_id: int, index: str):
    index = index.upper()
    cache_file = CACHE_DIR / f"stmt_{contest_id}_{index}.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            if data.get("available"):
                return data
        except Exception:
            pass

    html, status = _fetch_html(contest_id, index)
    if html is None:
        return JSONResponse(
            {"available": False, "reason": "blocked", "status": status,
             "hint": "Cloudflare blocked the fetch. Add your CF cookie (see README)."},
        )

    data = _parse_statement(html)
    if data.get("available"):
        data["fetchedAt"] = int(time.time())
        try:
            cache_file.write_text(json.dumps(data), encoding="utf-8")
        except Exception:
            pass
    return data


@app.get("/api/problemset")
def problemset():
    """Optional cached proxy of the CF problem list (for offline convenience)."""
    cache_file = CACHE_DIR / "problemset.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 86400:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    r = requests.get(f"{CF_BASE}/api/problemset.problems", headers=BROWSER_HEADERS, timeout=30)
    data = r.json()
    try:
        cache_file.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass
    return data


# Serve the frontend (must be mounted last so /api/* wins).
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")
