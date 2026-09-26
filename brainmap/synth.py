"""synth.py - deterministic, memory-shaped synthetic graphs for load testing.

Same node/link schema as build.py, so every renderer can be pushed past what
the real stores hold. Nothing here is real data: labels say so, and no node
has a path, so the file route has nothing to serve.

Shape: one root, a global store, a skills fan, and many project stores whose
sizes follow a heavy-tailed (Pareto) distribution, like real ones. Each
project has a CLAUDE.md node and a MEMORY.md index over its hot facts; some
hot facts have cold detail; related links are mostly local with a few
cross-project and global ones.
"""

from __future__ import annotations

import datetime as dt
import random
from dataclasses import dataclass
from functools import lru_cache

VOLATILITY = (("stable", None), ("evolving", 90), ("volatile", 30))
TYPES = ("project", "project", "project", "reference", "feedback", "user")
WORDS = ("fpga", "timing", "dma", "axi", "clock", "adc", "sensor", "driver", "board", "boot",
         "firmware", "rtos", "irq", "phy", "mac", "pcb", "power", "fault", "test", "ci",
         "matlab", "hdl", "filter", "dsp", "bram", "ddr", "uart", "spi", "i2c", "usb")


@dataclass(frozen=True)
class Synthetic:
    n: int

    @property
    def key(self) -> str:
        return f"synthetic-{self.n}"

    @property
    def label(self) -> str:
        return f"synthetic {self.n:,} nodes"


def _health(rng: random.Random, now: dt.datetime):
    vol, hl = rng.choices(VOLATILITY, weights=(4, 5, 1))[0]
    age = int(rng.expovariate(1 / 60))
    changed = now - dt.timedelta(days=age, minutes=rng.randrange(1440))
    if hl is None:
        return vol, changed, age, "stable", None
    over = age - hl
    health = "overdue" if over > 0 else "due" if age >= 0.75 * hl else "fresh"
    return vol, changed, age, health, over


@lru_cache(maxsize=4)
def generate(n: int, seed: int = 7) -> dict:
    rng = random.Random(seed * 1_000_003 + n)
    now = dt.datetime.now().replace(microsecond=0)
    nodes, links = [], []

    def node(id_, kind, label, area, layer, **kw):
        nodes.append({"id": id_, "kind": kind, "label": label, "area": area, "layer": layer,
                      "path": None, "flags": [], **kw})

    def mem(id_, label, area, hot):
        vol, changed, age, health, over = _health(rng, now)
        node(id_, "memory" if hot else "detail", label, area, 2 if hot else 3,
             note=f"Synthetic {'hot fact' if hot else 'cold detail'} in {area}.",
             changed=changed.isoformat(), type=rng.choice(TYPES), tier="hot" if hot else "cold",
             volatility=vol, age=age, health=health, overdue=over)

    node("root", "root", "CLAUDE.md", "core", 0, note="Synthetic root.", changed=now.isoformat())
    node("global:index", "index", "global/MEMORY.md", "global", 1, note="Synthetic global index.")
    links.append(("root", "global:index", "import"))
    n_global = max(4, n // 150)
    for i in range(n_global):
        mem(f"global:g{i}", f"global-{rng.choice(WORDS)}-{i}", "global", True)
        links.append(("global:index", f"global:g{i}", "index"))
    for i in range(min(40, 6 + n // 500)):
        node(f"skill:s{i}", "skill", f"/skill-{i}", "skills", 2, note="Synthetic skill.")
        links.append(("root", f"skill:s{i}", "skill"))

    budget = n - len(nodes)
    n_proj = max(6, min(600, budget // 60))
    weights = [rng.paretovariate(1.3) for _ in range(n_proj)]
    total = sum(weights)
    projects = []
    for p in range(n_proj):
        area = f"proj-{p:03d}"
        pid = f"project:{area}"
        node(pid, "project", area, area, 1, note=f"Synthetic project {p}.")
        links.append(("global:g0", pid, "lists"))
        iid = f"{area}:index"
        node(iid, "index", f"{area}/MEMORY.md", area, 1, note="Synthetic project index.")
        links.append((pid, iid, "loads"))
        size = max(2, int(budget * weights[p] / total) - 2)
        hot = []
        for i in range(size):
            if hot and rng.random() < 0.15:
                cid = f"{area}:c{i}"
                mem(cid, f"{area}-detail-{i}", area, False)
                links.append((rng.choice(hot), cid, "detail"))
            else:
                hid = f"{area}:h{i}"
                mem(hid, f"{area}-{rng.choice(WORDS)}-{rng.choice(WORDS)}-{i}", area, True)
                links.append((iid, hid, "index"))
                # Preferential attachment inside the project gives hubs.
                for _ in range(rng.choice((0, 1, 1, 2, 3))):
                    if hot:
                        links.append((hid, hot[min(len(hot) - 1, int(rng.expovariate(0.3)))] if rng.random() < 0.5
                                      else rng.choice(hot), "related"))
                hot.append(hid)
        projects.append(hot)

    all_hot = [h for hot in projects for h in hot]
    for _ in range(len(all_hot) // 25):
        a, b = rng.choice(all_hot), rng.choice(all_hot)
        links.append((a, b, "related"))
    for _ in range(len(all_hot) // 40):
        links.append((rng.choice(all_hot), f"global:g{rng.randrange(n_global)}", "related"))

    seen, out = set(), []
    for s, t, k in links:
        key = (s, t) if s < t else (t, s)
        if s != t and key not in seen:
            seen.add(key)
            out.append({"s": s, "t": t, "kind": k})

    days = []
    for d in range(180, -1, -1):
        day = (now - dt.timedelta(days=d)).date().isoformat()
        runs = rng.choice((0, 0, 0, 1, 1, 2, 3, 5))
        if runs:
            days.append({"day": day, "runs": runs, "files": runs * rng.randrange(1, 40), "cats": ["memory"]})

    return {
        "meta": {"source": f"synthetic-{n}", "label": f"synthetic {n:,} nodes", "built": now.isoformat(),
                 "root": None, "nodes": len(nodes), "links": len(out), "synthetic": True,
                 "last_snapshot": now.isoformat(), "activity_repo": None},
        "nodes": nodes,
        "links": out,
        "activity": days,
    }


if __name__ == "__main__":
    import sys
    for n in map(int, sys.argv[1:] or ["2000"]):
        g = generate(n)
        print(g["meta"]["label"], g["meta"]["nodes"], "nodes", g["meta"]["links"], "links")
