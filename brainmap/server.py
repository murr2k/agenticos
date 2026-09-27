"""server.py - read-only local server for the brain map.

Stdlib only. Binds to loopback (or a private address such as a Tailscale IP),
never a public one. Serves four pages over the same data (/ canvas 2D,
/gpu sigma.js WebGL, /3d 3d-force-graph WebGL, /orbit instanced three.js
orbital disc), their static files, and four GET routes:

    GET /api/sources            the configured sources
    GET /api/brain?src=KEY      the current graph of that source
    GET /api/version?src=KEY    its content version, for the pages to poll
    GET /api/file?src=KEY&id=N  the text of node N's file, only if N is in that graph

Each source's graph is built once and kept. A watcher thread rebuilds it when
the Claude Code hooks rewrite their marker file (~/.claude/memory.signal),
when a stat walk of the store finds a changed name, size or mtime, and at
least hourly so ages follow the clock. A rebuild whose content hash is
unchanged is discarded, so the version moves only when the graph does.

Nothing is ever written to the stores. No cookies, no login, no third-party
JavaScript. With --log the server writes only its own rotating log file.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import ipaddress
import json
import logging
import logging.handlers
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import build
import synth

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
DEFAULT_PORT = 8770          # ~/.claude/port-registry.md
FILE_MAX = 512 * 1024
TAILSCALE = ipaddress.ip_network("100.64.0.0/10")
LOG_BYTES, LOG_KEEP = 1024 * 1024, 3   # rotating log: 1 MB x 3 files
# Live refresh. The marker is the hooks' fast path; the stat walk is the
# safety net for changes no hook saw (another editor, a git pull, a sync).
SIGNAL = build.HOME / ".claude" / "memory.signal"
TICK_S = 0.5                 # marker check
WALK_S = 5.0                 # stat walk of every built source
SETTLE_S = 0.4               # a change opens this window; one rebuild covers all of it
AGE_S = 3600.0               # rebuild at least this often so ages and health follow the clock
log = logging.getLogger("brainmap")
# Pinned, because Windows' mimetypes reads the registry, which can map .js to
# text/plain; with nosniff set, the browser would then refuse to run it.
TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml"}

# worker-src blob: is for graphology's ForceAtlas2, which starts its layout
# worker from a blob URL of its own (same-origin) code. The three style hashes
# are the exact <style> blocks 3d-force-graph 1.80.0 injects (.graph-info-msg,
# .float-tooltip-kap, .scene-nav-info); re-hash them if that bundle changes.
STYLE_HASHES = ("'sha256-0/4q5IwejFb2zgHlQwwtwmGHS8ZbXE1kmz/TkRFlZ7M=' "
                "'sha256-9xjtvxMT1ApHlgn9ohbh2FNfvK5Tqtzy94BjfXBeMSY=' "
                "'sha256-yfc2FhpkFR0EAy3T+zDsaAFGXSP9B3ELNvaJKDzNhkk='")
# Inline import maps (the orbit page maps the bare specifier "three" to the
# vendored ES modules) are allowed by the hash of their exact text, taken from
# the pages at startup so it can never drift from the file.
IMPORTMAP = re.compile(r'<script type="importmap">(.*?)</script>', re.S)


def _importmap_hashes() -> str:
    hashes = []
    for page in sorted(STATIC.glob("*.html")):
        for body in IMPORTMAP.findall(page.read_text(encoding="utf-8")):
            digest = hashlib.sha256(body.encode("utf-8")).digest()
            hashes.append("'sha256-" + base64.b64encode(digest).decode() + "'")
    return " ".join(hashes)


CSP = ("default-src 'none'; script-src 'self' " + _importmap_hashes() + "; "
       "style-src 'self' " + STYLE_HASHES + "; "
       "img-src 'self' data: blob:; "
       "connect-src 'self'; font-src 'self'; worker-src 'self' blob:; base-uri 'none'; "
       "form-action 'none'; frame-ancestors 'none'")
PAGES = {"/": "index.html", "/index.html": "index.html", "/gpu": "gpu.html", "/3d": "3d.html",
         "/orbit": "orbit.html"}


def _static_files() -> dict[str, Path]:
    """Every servable static file, fixed at startup. No path is ever joined
    from the request, so traversal has nothing to work with."""
    return {"/static/" + p.relative_to(STATIC).as_posix(): p
            for p in STATIC.rglob("*") if p.is_file()}


# -- the current graph of each source, and what keeps it current ---------------------

def _now() -> str:
    return dt.datetime.now().replace(microsecond=0).isoformat()


def _content_hash(g: dict) -> str:
    """The version: a hash of what the pages draw. meta (build time, counts)
    is left out, so a rebuild that changes nothing keeps its version, across
    server restarts too."""
    text = json.dumps([g["nodes"], g["links"], g.get("activity")], sort_keys=True,
                      ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Built:
    graph: dict
    body: bytes                  # the graph as JSON, encoded once per version
    version: str
    built: str                   # when this content was first built


class Entry:
    """One source's current graph. Requests read whatever is current and never
    wait for a rebuild, except the very first one."""

    def __init__(self, src):
        self.src = src
        self.cur: Built | None = None      # swapped whole, so readers never see half an update
        self.lock = threading.Lock()
        self.fp = None                     # stat fingerprint the current build was made from
        self.checked = None                # time of the last rebuild, changed or not
        self.error = None                  # why the last rebuild failed, if it did
        self.at = 0.0                      # monotonic time of the last rebuild
        self.due = None                    # monotonic time a pending rebuild runs
        self.why = ""

    @property
    def synthetic(self) -> bool:
        return isinstance(self.src, synth.Synthetic)

    def get(self) -> Built:
        if self.cur is None:
            with self.lock:
                if self.cur is None:
                    self._rebuild("first request")
        return self.cur

    def schedule(self, now: float, why: str, delay: float = SETTLE_S) -> None:
        if self.due is None:
            self.due, self.why = now + delay, why

    def rebuild(self, why: str) -> None:
        with self.lock:
            self._rebuild(why)

    def _rebuild(self, why: str) -> None:
        t0 = time.perf_counter()
        # Fingerprint first: a file that changes while the build runs then
        # shows up as a difference on the next walk instead of being lost.
        fp = None if self.synthetic else build.fingerprint(self.src)
        try:
            g = synth.generate(self.src.n) if self.synthetic else build.build(self.src)
        except Exception as e:
            self.fp, self.at, self.checked = fp, time.monotonic(), _now()
            self.error = f"{type(e).__name__}: {e}"
            log.exception("%s: rebuild failed (%s)", self.src.key, why)
            if self.cur is None:
                raise
            return
        self.fp, self.at, self.checked, self.error = fp, time.monotonic(), _now(), None
        version = _content_hash(g)
        ms = (time.perf_counter() - t0) * 1000
        if self.cur is not None and version == self.cur.version:
            log.debug("%s: unchanged (%s, %.0f ms)", self.src.key, why, ms)
            return
        g["meta"]["version"] = version
        body = json.dumps(g, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.cur = Built(g, body, version, g["meta"]["built"])
        log.info("%s: version %s (%s): %d nodes, %d links, %.0f ms",
                 self.src.key, version, why, len(g["nodes"]), len(g["links"]), ms)


def _mark(path: Path):
    """The marker's size and mtime. Only stat, never open: the hooks rewrite
    it, and on Windows an open handle here could make their write fail."""
    try:
        st = os.stat(path)
        return st.st_size, st.st_mtime_ns
    except OSError:
        return None


class Watcher(threading.Thread):
    """Keeps every built source current. Builds live at startup, so the first
    page load is instant; other sources join once something asks for them."""

    def __init__(self, entries: dict, signal: Path):
        super().__init__(name="watcher", daemon=True)
        self.entries, self.signal = entries, signal
        self.mark = _mark(signal)
        self.walked = time.monotonic()

    def run(self):
        try:
            self.entries["live"].get()
        except Exception:
            pass                            # logged; the first request will retry
        while True:
            time.sleep(TICK_S)
            try:
                self.tick()
            except Exception:
                log.exception("watcher tick failed")

    def tick(self):
        now = time.monotonic()
        mark = _mark(self.signal)
        signalled = mark != self.mark
        self.mark = mark
        walk = now - self.walked >= WALK_S
        if walk:
            self.walked = now
        for e in self.entries.values():
            if e.cur is None or e.synthetic:
                continue
            if e.due is None:
                if signalled:
                    e.schedule(now, "signal")
                elif walk and build.fingerprint(e.src) != e.fp:
                    e.schedule(now, "files changed")
                elif now - e.at >= AGE_S:
                    e.schedule(now, "clock", 0)
            if e.due is not None and now >= e.due:
                why, e.due = e.why, None
                e.rebuild(why)


class Handler(BaseHTTPRequestHandler):
    server_version = "brainmap"
    sys_version = ""
    entries: dict[str, Entry] = {}     # source key -> its current graph
    statics: dict[str, Path] = {}
    allowed_hosts: set[str] = set()

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def log_request(self, code="-", size="-"):
        # Every open tab polls /api/version every few seconds; logging each
        # answer would rotate the real log away within hours.
        if code == 200 and self.path.startswith("/api/version"):
            return
        super().log_request(code, size)

    # -- plumbing -------------------------------------------------------------
    def _send(self, status: int, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, msg: str):
        self._json({"error": msg}, status)

    def _entry(self, q) -> Entry | None:
        key = (q.get("src") or ["live"])[0]
        return self.entries.get(key)

    def _current(self, q) -> Built | None:
        """The source's current graph, or None after answering the error."""
        e = self._entry(q)
        if e is None:
            self._error(404, "unknown source")
            return None
        try:
            return e.get()
        except Exception as ex:
            self._error(500, f"could not build the graph: {type(ex).__name__}: {ex}")
            return None

    # -- routes ---------------------------------------------------------------
    def do_GET(self):
        # DNS-rebinding guard: a hostile page that points its own name at
        # 127.0.0.1 still sends its own Host header.
        if self.headers.get("Host", "").lower() not in self.allowed_hosts:
            return self._error(HTTPStatus.FORBIDDEN, "unexpected Host header")
        url = urlsplit(self.path)
        q = parse_qs(url.query)
        path = url.path

        if path in PAGES:
            return self._send(200, (STATIC / PAGES[path]).read_bytes(), "text/html; charset=utf-8")
        if path in self.statics:
            p = self.statics[path]
            ctype = TYPES.get(p.suffix) or mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            return self._send(200, p.read_bytes(), ctype)
        if path == "/api/sources":
            return self._json([{"key": k, "label": e.src.label} for k, e in self.entries.items()])
        if path == "/api/brain":
            cur = self._current(q)
            if cur is not None:
                self._send(200, cur.body, "application/json; charset=utf-8")
            return None
        if path == "/api/version":
            cur = self._current(q)
            if cur is not None:
                e = self._entry(q)
                self._json({"src": e.src.key, "version": cur.version, "built": cur.built,
                            "checked": e.checked, "error": e.error})
            return None
        if path == "/api/file":
            nid = (q.get("id") or [""])[0]
            if self._entry(q) is None or not nid:
                return self._error(404, "unknown source or node")
            cur = self._current(q)
            if cur is None:
                return None
            node = next((n for n in cur.graph["nodes"] if n["id"] == nid), None)
            if node is None or not node.get("path"):
                return self._error(404, "no such node")
            p = Path(node["path"])
            # The node's path and, if it is a link, what it points at.
            if not p.is_file() or p.suffix not in build.NODE_SUFFIXES or p.resolve().suffix not in build.NODE_SUFFIXES:
                return self._error(404, "node has no readable file")
            data = p.read_bytes()[:FILE_MAX]
            return self._json({"id": nid, "path": node["rel"],
                               "truncated": p.stat().st_size > FILE_MAX,
                               "text": data.decode("utf-8", errors="replace")})
        return self._error(404, "no such route")

    do_HEAD = do_GET

    def _refuse(self):
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "read-only")

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _refuse


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that is already
    # listening, and the two then split the traffic. Ask for exclusive use so a
    # second instance fails fast and can hand over to the first.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        # The default prints to stderr, which does not exist under pythonw.
        log.exception("request from %s failed", client_address)


def _setup_logging(path: str | None) -> None:
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        h = logging.handlers.RotatingFileHandler(path, maxBytes=LOG_BYTES, backupCount=LOG_KEEP, encoding="utf-8")
    elif sys.stderr is not None:
        h = logging.StreamHandler(sys.stderr)
    else:                           # pythonw without --log: stay silent, never crash
        h = logging.NullHandler()
    h.setFormatter(logging.Formatter("%(asctime)s  %(levelname)s  %(message)s"))
    log.addHandler(h)
    log.setLevel(logging.INFO)


def _brainmap_at(url: str) -> bool:
    """Is a brain map already answering at this address?"""
    try:
        with urllib.request.urlopen(url + "api/sources", timeout=2) as r:
            return isinstance(json.loads(r.read()), list)
    except (OSError, ValueError):
        return False


def _check_bind(host: str) -> None:
    if host == "localhost":
        return
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        sys.exit(f"--host must be an IP address or 'localhost', got {host!r}")
    if ip.is_unspecified:
        sys.exit("refusing to bind every interface; pass a loopback or private address")
    if not (ip.is_loopback or ip.is_private or ip in TAILSCALE):
        sys.exit(f"refusing to bind public address {host}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--snapshot", action="append", default=[], metavar="PATH[@MACHINE]",
                    help="add a claude-env style checkout as a source (repeatable)")
    ap.add_argument("--open", action="store_true", help="open the page in the default browser once listening")
    ap.add_argument("--synthetic", default="2000,10000,50000", metavar="N[,N...]",
                    help="synthetic load-test sources by node count ('' for none)")
    ap.add_argument("--no-auto", action="store_true",
                    help="do not auto-add ~/projects/claude-env as a source")
    ap.add_argument("--log", metavar="FILE", help="log to a rotating file instead of stderr")
    ap.add_argument("--signal", metavar="FILE", default=str(SIGNAL),
                    help="marker the Claude Code hooks rewrite when memory may have changed")
    a = ap.parse_args(argv)
    _setup_logging(a.log)
    _check_bind(a.host)

    sources = {"live": build.live_source()}
    snaps = list(a.snapshot)
    legacy = build.HOME / "projects" / "claude-env"
    if not a.no_auto and (legacy / "machines").is_dir():
        snaps.insert(0, str(legacy))
    for spec in snaps:
        path, _, machine = spec.partition("@")
        try:
            s = build.snapshot_source(Path(path), machine or None)
        except ValueError as e:
            log.warning("skipping snapshot %s: %s", spec, e)
            continue
        sources.setdefault(s.key, s)
    for n in filter(None, (x.strip() for x in a.synthetic.split(","))):
        s = synth.Synthetic(int(n))
        sources[s.key] = s

    Handler.entries = {k: Entry(s) for k, s in sources.items()}
    Handler.statics = _static_files()
    Handler.allowed_hosts = {f"{h}:{a.port}" for h in {a.host, "127.0.0.1", "localhost"}}

    url = f"http://{a.host}:{a.port}/"
    try:
        httpd = Server((a.host, a.port), Handler)
    except OSError as e:
        # Usually the autostarted instance already owns the port: hand over to
        # it rather than fail. Extra options on this command line are ignored.
        if _brainmap_at(url):
            log.info("brain map already running on %s; not starting a second one", url)
            if a.open:
                webbrowser.open(url)
            return 0
        log.error("cannot bind %s: %s", url, e)
        return 1
    log.info("brain map on %s  sources: %s", url, ", ".join(sources))
    Watcher(Handler.entries, Path(a.signal)).start()     # only once we own the port
    if a.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
