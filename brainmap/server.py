"""server.py - read-only local server for the brain map.

Stdlib only. Binds to loopback (or a private address such as a Tailscale IP),
never a public one. Serves four pages over the same data (/ canvas 2D,
/gpu sigma.js WebGL, /3d 3d-force-graph WebGL, /orbit instanced three.js
orbital disc), their static files, and three GET routes:

    GET /api/sources            the configured sources
    GET /api/brain?src=KEY      the graph, rebuilt from the Markdown on each call
    GET /api/file?src=KEY&id=N  the text of node N's file, only if N is in that graph

Nothing is ever written. No cookies, no login, no third-party JavaScript.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import mimetypes
import re
import sys
import webbrowser
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


class Handler(BaseHTTPRequestHandler):
    server_version = "brainmap"
    sys_version = ""
    sources: dict = {}             # key -> build.Source | synth.Synthetic
    statics: dict[str, Path] = {}
    allowed_hosts: set[str] = set()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

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

    def _source(self, q):
        key = (q.get("src") or ["live"])[0]
        return self.sources.get(key)

    @staticmethod
    def _graph(src) -> dict:
        return synth.generate(src.n) if isinstance(src, synth.Synthetic) else build.build(src)

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
            return self._json([{"key": k, "label": s.label} for k, s in self.sources.items()])
        if path == "/api/brain":
            src = self._source(q)
            if src is None:
                return self._error(404, "unknown source")
            return self._json(self._graph(src))
        if path == "/api/file":
            src = self._source(q)
            nid = (q.get("id") or [""])[0]
            if src is None or not nid:
                return self._error(404, "unknown source or node")
            node = next((n for n in self._graph(src)["nodes"] if n["id"] == nid), None)
            if node is None or not node.get("path"):
                return self._error(404, "no such node")
            p = Path(node["path"])
            if not p.is_file() or p.suffix not in build.NODE_SUFFIXES:
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
    a = ap.parse_args(argv)
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
            print(f"skipping snapshot {spec}: {e}", file=sys.stderr)
            continue
        sources.setdefault(s.key, s)
    for n in filter(None, (x.strip() for x in a.synthetic.split(","))):
        s = synth.Synthetic(int(n))
        sources[s.key] = s

    Handler.sources = sources
    Handler.statics = _static_files()
    Handler.allowed_hosts = {f"{h}:{a.port}" for h in {a.host, "127.0.0.1", "localhost"}}

    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    url = f"http://{a.host}:{a.port}/"
    print(f"brain map on {url}  sources: {', '.join(sources)}")
    if a.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
