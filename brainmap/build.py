"""build.py - walk the tiered memory stores and emit the brain-map graph.

The graph is derived, never authoritative: the Markdown files are the store
and this is a view, rebuilt on every request and safe to throw away.
Frontmatter parsing, link resolution and ageing are delegated to memtool.py
so the memory schema keeps exactly one reader.

    python build.py                          # live ~/.claude, JSON to stdout
    python build.py --source <snapshot repo> # a claude-env style checkout
    python build.py --out data/brain.json

Node:  {id, kind, label, area, layer, path, note, changed, ...}
Link:  {s, t, kind}
Kinds: root, doc, index, project, memory (hot), detail (cold), skill.
Layer: 0 root, 1 always-in-context (indexes, project CLAUDE.md), 2 hot, 3 cold.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HOME = Path.home()
MEMTOOL = HOME / ".claude" / "skills" / "memory-system" / "memtool.py"


def _load_memtool(path: Path):
    if not path.is_file():
        sys.exit(f"memtool.py not found at {path}; the memory-system skill is required")
    spec = importlib.util.spec_from_file_location("memtool", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mt = _load_memtool(MEMTOOL)

# Only these file types become nodes, and so only these can ever be served by
# the viewer's read-only file route. settings.json and friends carry secrets.
NODE_SUFFIXES = {".md", ".py"}
NOTE_MAX = 320
TILDE_PATH = re.compile(r"~/\.claude/([A-Za-z0-9_./-]+\.(?:md|py))")
PROJECT_PATH = re.compile(r"~/projects/([A-Za-z0-9_.-]+)")
SUBJECT_FILES = re.compile(r"(\d+) file\(s\)(?: \(([^)]*)\))?")


def slug(path: Path) -> str:
    """Claude Code's per-project store name for a directory."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------

@dataclass
class Source:
    key: str
    label: str
    root_md: Path                       # the centre node
    global_store: Path
    project_stores: Path
    skills: Path
    claude_dirs: tuple                  # where a ~/.claude/<rest> mention resolves
    projects_dir: Path | None = None    # project CLAUDE.md files (live only)
    store_prefix: str = ""              # keep project stores whose slug starts with this
    activity_repo: Path | None = None   # snapshot repo; its commit log is the pulse

    def resolve_claude(self, rest: str) -> Path | None:
        for base in self.claude_dirs:
            p = base / rest
            if p.is_file():
                return p
        return None


def live_source() -> Source:
    claude = HOME / ".claude"
    projects = HOME / "projects"
    snap = projects / "claude-env-surrey"
    return Source(
        key="live", label="live ~/.claude",
        root_md=claude / "CLAUDE.md",
        global_store=claude / "memory",
        project_stores=claude / "projects",
        skills=claude / "skills",
        claude_dirs=(claude,),
        projects_dir=projects if projects.is_dir() else None,
        store_prefix=slug(projects),
        activity_repo=snap if (snap / ".git").exists() else None,
    )


def snapshot_source(repo: Path, machine: str | None = None, key: str | None = None) -> Source:
    """A claude-env style checkout: memory/, projects/<slug>/memory, skills/,
    machines/<user>/CLAUDE.md. A repo holding several machines is narrowed to
    one, by default the one with the most project stores."""
    repo = repo.resolve()
    machines = sorted(d.name for d in (repo / "machines").glob("*") if (d / "CLAUDE.md").is_file())
    if not machines:
        raise ValueError(f"{repo} has no machines/<user>/CLAUDE.md; not a claude-env checkout")
    if machine is None:
        def n_stores(m):
            return sum(1 for d in (repo / "projects").glob(f"C--Users-{m}-*") if (d / "memory").is_dir())
        machine = max(machines, key=n_stores)
    if machine not in machines:
        raise ValueError(f"machine {machine!r} not in {machines}")
    mdir = repo / "machines" / machine
    return Source(
        key=key or f"{repo.name}:{machine}", label=f"{repo.name} snapshot ({machine})",
        root_md=mdir / "CLAUDE.md",
        global_store=repo / "memory",
        project_stores=repo / "projects",
        skills=repo / "skills",
        claude_dirs=(repo, mdir),
        store_prefix=f"C--Users-{machine}-projects",
        activity_repo=repo if (repo / ".git").exists() else None,
    )


# --------------------------------------------------------------------------
# graph
# --------------------------------------------------------------------------

def _iso(t: dt.datetime) -> str:
    return t.replace(microsecond=0).isoformat()


def _mtime(p: Path) -> str:
    return _iso(dt.datetime.fromtimestamp(p.stat().st_mtime))


def _clip(s: str) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= NOTE_MAX else s[: NOTE_MAX - 3] + "..."


def _first_para(md: str, heading: str | None = None) -> str:
    """First prose paragraph, optionally the one under a given heading."""
    _, body = mt.parse_frontmatter(md)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    lines = body.splitlines()
    if heading:
        idx = next((i for i, ln in enumerate(lines) if ln.strip().lower() == heading.lower()), None)
        if idx is None:
            return ""
        lines = lines[idx + 1:]
    para = []
    for ln in lines:
        s = ln.strip()
        if s.startswith("#") and para:
            break
        if not s or s.startswith(("#", "|", "```", "---", "@")):
            if para:
                break
            continue
        para.append(s)
    return _clip(" ".join(para))


class Graph:
    # When two files point at each other more than one way, the stronger
    # structural edge wins the drawn line.
    RANK = {"import": 6, "loads": 5, "index": 4, "lists": 4, "detail": 3,
            "skill": 2, "ref": 2, "scope": 1, "related": 0}

    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple, str] = {}
        self.by_path: dict[str, str] = {}

    def add(self, id_: str, **kw) -> dict:
        n = self.nodes.get(id_)
        if n is None:
            n = self.nodes[id_] = {"id": id_, "flags": []}
        n.update({k: v for k, v in kw.items() if v is not None})
        if kw.get("path"):
            self.by_path[str(Path(kw["path"]).resolve()).lower()] = id_
        return n

    def link(self, s: str, t: str, kind: str):
        if s == t or s not in self.nodes or t not in self.nodes:
            return
        key = tuple(sorted((s, t)))
        old = self.edges.get(key)
        if old is None or self.RANK[kind] > self.RANK[old[2]]:
            self.edges[key] = (s, t, kind)

    def node_for_path(self, p: Path) -> str | None:
        return self.by_path.get(str(p.resolve()).lower())


def _health(m, now) -> tuple[str, int | None]:
    hl = mt.HALF_LIFE.get(m.volatility)
    if hl is None:
        return "stable", None
    age = m.age_days(now)
    if age > hl:
        return "overdue", age - hl
    return ("due" if age >= 0.75 * hl else "fresh"), age - hl


def _add_store(g: Graph, store, area: str, index_id: str | None, now,
               global_names: dict | None) -> None:
    """Hot and cold files of one store, their index edges and their links."""
    names = store.by_name()
    indexed = store.indexed_names()
    for m in store.mems:
        hot = m.tier == "hot"
        health, over = _health(m, now)
        n = g.add(
            f"{area}:{m.key}", kind="memory" if hot else "detail", label=m.name,
            area=area, layer=2 if hot else 3, path=str(m.path),
            note=_clip(m.description), changed=_iso(m.modified),
            type=m.type or None, tier=m.tier, volatility=m.volatility,
            age=m.age_days(now), health=health, overdue=over,
            lines=len(m.body.splitlines()),
        )
        if health == "overdue":
            n["flags"].append(f"past {m.volatility} half-life by {over} d")
        if hot and m.key not in indexed:
            n["flags"].append("not in MEMORY.md")
        if hot and n["lines"] > mt.HOT_MAX_LINES:
            n["flags"].append(f"over {mt.HOT_MAX_LINES} lines")

    for key in sorted(indexed):
        tgt = names.get(key)
        if tgt is None:
            if index_id:
                g.nodes[index_id]["flags"].append(f"dead entry: {key}")
            continue
        if index_id:
            g.link(index_id, f"{area}:{tgt.key}", "index")

    for m in store.mems:
        src = f"{area}:{m.key}"
        cold_keys = {mt.norm(t) for t in m.cold}
        for t in m.cold:
            tgt = names.get(mt.norm(t))
            if tgt is None:
                g.nodes[src]["flags"].append(f"broken cold pointer: {t}")
            else:
                g.link(src, f"{area}:{tgt.key}", "detail")
        for t in sorted(set(m.links + m.wikilinks)):
            k = mt.norm(t)
            if k in cold_keys:
                continue
            tgt = names.get(k)
            if tgt is not None:
                g.link(src, f"{area}:{tgt.key}", "related")
            elif global_names and k in global_names:
                g.link(src, f"global:{global_names[k].key}", "related")
            else:
                g.nodes[src]["flags"].append(f"broken link: {t}")


def _activity(repo: Path | None) -> tuple[list, str | None]:
    """Snapshot commits by day: the Stop hook's heartbeat."""
    if repo is None:
        return [], None
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "log", "-n", "2000", "--format=%aI%x09%s"],
            capture_output=True, text=True, encoding="utf-8", timeout=15, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return [], None
    days: dict[str, dict] = {}
    last = None
    for line in out.splitlines():
        when, _, subject = line.partition("\t")
        if not when:
            continue
        last = last or when
        d = days.setdefault(when[:10], {"day": when[:10], "runs": 0, "files": 0, "cats": set()})
        d["runs"] += 1
        m = SUBJECT_FILES.search(subject)
        if m:
            d["files"] += int(m.group(1))
            if m.group(2):
                d["cats"].update(c.strip() for c in m.group(2).split(","))
    rows = [dict(v, cats=sorted(v["cats"])) for _, v in sorted(days.items())]
    return rows, last


def build(src: Source) -> dict:
    now = dt.datetime.now()
    g = Graph()

    # -- tier 1: the root and what it points at --------------------------------
    root_text = src.root_md.read_text(encoding="utf-8", errors="replace") if src.root_md.is_file() else ""
    g.add("root", kind="root", label="CLAUDE.md", area="core", layer=0,
          path=str(src.root_md), changed=_mtime(src.root_md) if src.root_md.is_file() else None,
          note=_clip("Global instructions, always in context. " + _first_para(root_text, "## Who I am")))

    gstore = mt.Store(src.global_store, "global") if src.global_store.is_dir() else None
    if gstore is not None:
        idx = gstore.index_path
        g.add("global:index", kind="index", label="global/MEMORY.md", area="global", layer=1,
              path=str(idx) if idx.is_file() else str(src.global_store),
              changed=_mtime(idx) if idx.is_file() else None,
              note=f"Global memory index: {len(gstore.hot())} hot, {len(gstore.cold())} cold. "
                   f"@imported by CLAUDE.md, so it loads in every session "
                   f"({gstore.index_loaded_lines()}/100 lines).")
        g.link("root", "global:index", "import")
        _add_store(g, gstore, "global", "global:index", now, None)
    gnames = gstore.by_name() if gstore else {}

    # -- skills ----------------------------------------------------------------
    if src.skills.is_dir():
        for d in sorted(src.skills.iterdir()):
            sk = d / "SKILL.md"
            if not sk.is_file():
                continue
            fm, _ = mt.parse_frontmatter(sk.read_text(encoding="utf-8", errors="replace"))
            name = str(fm.get("name") or d.name)
            g.add(f"skill:{name}", kind="skill", label=f"/{name}", area="skills", layer=2,
                  path=str(sk), changed=_mtime(sk), note=_clip(fm.get("description") or ""))
            g.link("root", f"skill:{name}", "skill")

    # -- projects --------------------------------------------------------------
    listing = gnames.get("projects")
    listing_text = listing.body if listing is not None else ""
    listed = {}
    for row in listing_text.splitlines():
        m = PROJECT_PATH.search(row)
        if m and row.lstrip().startswith("|"):
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            listed[m.group(1)] = _clip(cells[-1].replace("**", "")) if cells else ""

    dir_by_slug = {}
    if src.projects_dir is not None:
        for d in src.projects_dir.iterdir():
            if d.is_dir():
                dir_by_slug[slug(d)] = d

    def project_name(s: str) -> str:
        if s in dir_by_slug:
            return dir_by_slug[s].name
        if s == src.store_prefix:
            return "~/projects"
        if src.store_prefix and s.startswith(src.store_prefix + "-"):
            return s[len(src.store_prefix) + 1:]
        return s

    projects: dict[str, dict] = {}
    if src.project_stores.is_dir():
        for d in sorted(src.project_stores.iterdir()):
            mem = d / "memory"
            if not mem.is_dir() or (src.store_prefix and not d.name.startswith(src.store_prefix)):
                continue
            store = mt.Store(mem, d.name)
            if store.mems or store.index_text().strip():
                projects[project_name(d.name)] = {"store": store}
    if src.projects_dir is not None:
        for name in listed:
            if (src.projects_dir / name).is_dir():
                projects.setdefault(name, {"store": None})

    for name in sorted(projects, key=str.lower):
        store = projects[name]["store"]
        pid = f"project:{name}"
        cmd = src.projects_dir / name / "CLAUDE.md" if src.projects_dir else None
        if cmd is not None and cmd.is_file():
            text = cmd.read_text(encoding="utf-8", errors="replace")
            note = listed.get(name) or _first_para(text, "## What this is") or _first_para(text)
            g.add(pid, kind="project", label=name, area=name, layer=1, path=str(cmd),
                  changed=_mtime(cmd), note=note)
        else:
            g.add(pid, kind="project", label=name, area=name, layer=1,
                  path=str(store.path) if store else None,
                  note=listed.get(name) or "Project memory store (no CLAUDE.md in this source).")
            g.nodes[pid]["dir"] = True
        if listing is not None and name in listed:
            g.link("global:projects", pid, "lists")
        else:
            g.link("root", pid, "scope")
        if store is None:
            continue
        iid = None
        if store.index_path.is_file():
            iid = f"{name}:index"
            g.add(iid, kind="index", label=f"{name}/MEMORY.md", area=name, layer=1,
                  path=str(store.index_path), changed=_mtime(store.index_path),
                  note=f"Project memory index: {len(store.hot())} hot, {len(store.cold())} cold. "
                       f"Auto-loaded when a session starts in {name} "
                       f"({store.index_loaded_lines()}/200 lines).")
            g.link(pid, iid, "loads")
        _add_store(g, store, name, iid, now, gnames)
        if iid is None:
            for m in store.hot():
                g.link(pid, f"{name}:{m.key}", "loads")

    # -- files the root mentions by path ---------------------------------------
    for rest in sorted(set(TILDE_PATH.findall(root_text))):
        p = src.resolve_claude(rest)
        if p is None or p.suffix not in NODE_SUFFIXES:
            continue
        nid = g.node_for_path(p)
        if nid is None:
            nid = f"doc:{rest}"
            text = p.read_text(encoding="utf-8", errors="replace") if p.suffix == ".md" else ""
            g.add(nid, kind="doc", label=p.name, area="core", layer=1, path=str(p),
                  changed=_mtime(p), note=_first_para(text) or f"~/.claude/{rest}")
        g.link("root", nid, "ref")

    activity, last = _activity(src.activity_repo)
    nodes = list(g.nodes.values())
    for n in nodes:
        n.setdefault("path", None)
        if n["path"]:
            n["rel"] = n["path"].replace(str(HOME), "~").replace("\\", "/")
    links = [{"s": s, "t": t, "kind": k} for (s, t, k) in g.edges.values()]
    return {
        "meta": {
            "source": src.key, "label": src.label, "built": _iso(now),
            "root": str(src.root_md), "nodes": len(nodes), "links": len(links),
            "last_snapshot": last,
            "activity_repo": str(src.activity_repo) if src.activity_repo else None,
        },
        "nodes": nodes,
        "links": links,
        "activity": activity,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="live", help="'live' or a claude-env style checkout")
    ap.add_argument("--machine", help="which machines/<user> of a snapshot checkout")
    ap.add_argument("--out", help="write here instead of stdout")
    a = ap.parse_args(argv)
    src = live_source() if a.source == "live" else snapshot_source(Path(a.source), a.machine)
    data = build(src)
    text = json.dumps(data, indent=1, ensure_ascii=False)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text + "\n", encoding="utf-8")
        m = data["meta"]
        print(f"{m['label']}: {m['nodes']} nodes, {m['links']} links -> {a.out}")
    else:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
