# Memory organization: truth, volatility and metadata

A record of a design discussion about how the tiered memory system should
treat time, truth and metadata, what was decided, what was changed, and a
recipe another agent can follow to apply the same decisions to a memory
system of the same design.

- Discussion and changes: 2026-09-27, during an unattended memory
  maintenance run (`/memory-consolidate --auto`) and the conversation it
  prompted.
- Scope: the memory system's conventions, not the brain map viewer. The
  viewer shows the result (section 5).
- Specific memories are described by category, not by name: several of them
  record security-relevant facts about the owner's devices and accounts.

---

## 1. The outcome in brief

1. **Facts do not expire by date.** A fact is true or false; age never makes
   it false. A review date only prompts a check of whether the world changed.
   Permanent facts get `volatility: stable` (no review date at all), and
   time-bound facts are written as dated observations so they stay true.
2. **No new metadata fields.** Truth value, provenance, importance and use
   counts were considered as frontmatter fields and rejected. Importance is
   expressed by **placement** (which tier, and whether it is promoted to an
   always-loaded rule). Provenance and truth value are expressed in the
   **wording** of the fact.
3. **Unattended runs write only what the parser already assumes.** A missing
   `tier` defaults to `hot`, so backfilling it is mechanical. `volatility` is
   a judgement, so unset labels stay as warnings for an interactive run.
4. **Every edit keeps the review clock.** A file's mtime (and the harness's
   `metadata.modified` stamp, where present) is when the fact was last
   checked. Relabelling or rewording must restore it.

---

## 2. The memory system in brief

Enough context to read the rest; the rebuild spec (`brainmap-spec.md`,
section 2) has the full contract.

| Tier | What | Loaded |
|---|---|---|
| 1 | root `CLAUDE.md`, project `CLAUDE.md`, the `MEMORY.md` indexes (one line per fact) | every session |
| 2 | hot facts, one per file, at most 50 body lines | when recalled |
| 3 | cold detail under `cold/`, no size limit | when a hot fact points at it |

Frontmatter: `name`, `description`, and a `metadata` block with `type`
(user, feedback, project, reference), `tier` (hot or cold, default hot),
`volatility` (default evolving), `links`, `cold`, and a harness-stamped
`modified`.

| volatility | re-check after | meant for |
|---|---|---|
| stable | never | physics, device and platform properties, decisions and their reasons |
| evolving | 90 days | project phase, toolchain versions, architecture in motion |
| volatile | 30 days | the current task, next steps, live addresses and state |

A helper tool (`memtool.py`) parses frontmatter, lints the stores, computes
ages and lists facts past their re-check date. Age is `metadata.modified` if
present, else the file's mtime, which makes mtime the system's review clock.

---

## 3. The discussion

### 3.1 "Facts don't go stale based on date alone"

The maintenance run reported eleven facts with no `volatility` label and
described the missing judgement as "how quickly each fact goes stale". The
user's correction: *facts don't go stale based on date alone; some remain
true in perpetuity, whether we remember them or not.*

On inspection the schema already had the right class (`stable`, never
re-checked), and even the other classes only prompt a check; nothing is ever
deleted for age. What was wrong:

- **The vocabulary.** "Goes stale", "rots", "expires" frame age as decay,
  which invites deleting or "refreshing" facts that are still true.
- **The default.** An unlabelled fact is treated as `evolving`, so a
  permanent fact with no label gets a 90-day re-check it does not need.
- **Present-tense writing.** "Uptime has been 18% ever since" can become
  false without anyone editing it. "Uptime was 18% when diagnosed in July"
  cannot.

### 3.2 Memories carry metadata

The user then pointed at biological memory: each memory is the fact plus
metadata (is it true or false, how reliable is its source, how important is
it, how durable should it be), all shaped by natural selection. The
neuroscience has names for most of these:

| Tag | Biological mechanism (as discussed) | This schema |
|---|---|---|
| Truth value | accepting a claim is automatic, tagging it false takes effort, and the "false" tag is the part most easily lost (Gilbert) | missing; negative facts are prose |
| Provenance | source monitoring: where a memory came from is stored with it, and misattribution drives false memories (Johnson) | missing; partly covered by quoting what the user said |
| Importance | arousal decides what is consolidated; synaptic tagging and capture | missing |
| Durability | consolidation, spacing, and reconsolidation (recall makes a memory editable again) | `volatility`, loosely |
| Accessibility | forgetting tracks how likely a memory is to be needed again, not whether it is true (Anderson and Schooler) | `tier` |
| Retrieval cue | | `description` |
| Associations | | `links` and `[[wikilinks]]` |
| Use count | | missing |

The Anderson and Schooler point is the user's rule seen from biology:
forgetting optimizes the cost of retrieval, not truth. The fact stays true;
only its accessibility fades. The schema already separates the two:
`tier` is accessibility, `volatility` is whether the world can change it.

A `provenance` field (user-stated, observed, inferred) and a `salience` field
(cost of getting it wrong) were proposed as candidates.

### 3.3 What would extra metadata cost?

The user asked to weigh the context burden against the kind of work done
together (long engineering sessions heavy in file reads, logs and tool
output). Measured on the store at the time:

| Item | Size | When paid |
|---|---|---|
| Always-loaded tier 1 (root and project `CLAUDE.md`, both indexes) | about 4,200 tokens | every session |
| Frontmatter per memory file | about 80 tokens | only when that fact is recalled |
| One more field line | about 7 tokens | per recalled file |
| A typical file read, log or agent report | thousands of tokens | constantly |

So tokens were not the problem. The real costs:

1. **Metadata only helps where recall is decided, and that is the index.** A
   salience tag in frontmatter is seen only after the file is already open.
   To steer recall it would have to be on the index line, which every
   session pays for.
2. **Upkeep.** Every field is a judgement at write time, and every unset
   field becomes a lint warning an unattended run cannot resolve. The eleven
   unlabelled facts were exactly that: one field, one worklist. Four more
   fields would be four more worklists.
3. **Use counts need writes on read.** Counting recalls turns every read
   into a file write, and on a machine that snapshots its memory, each write
   into a commit.

### 3.4 The decision

No schema change. Encode the same properties in ways already paid for:

- **Salience by placement**, which is also what biology does (importance
  decides accessibility, not a separate label):
  - facts whose violation is costly or irreversible (data loss, security,
    money) become rules in the relevant `CLAUDE.md`, which is always loaded,
    each with its reason;
  - useful facts get an index line;
  - evidence and long history go to cold storage.
- **Provenance and truth value in the wording**: "the user said on
  <date>", "observed in <source> on <date>", "inferred from <evidence>",
  "X does **not** work, because Y (tried <date>)". It costs nothing extra
  and loads with the fact.
- **Durability** stays `volatility`, applied with the rule in 3.1.
- **No use counts.**

---

## 4. What was implemented (2026-09-27)

1. **Unattended maintenance run** across nine stores: no errors, no index
   drift, no orphans, nothing overdue. It backfilled the missing `tier: hot`
   on eleven facts in four project stores, keeping each file's mtime, after
   confirming the snapshot backup had a fresh, pushed commit (the undo). It
   deleted nothing and left the eleven missing `volatility` labels as
   warnings. The run, what it left for an interactive run, and the next due
   dates went into the global index's footer.
2. **A global feedback memory, "facts don't expire by date"**, with its index
   line under Preferences, so every session on the machine follows the rule
   (content in recipe step R1).
3. **Six `volatility` labels in one project store**, approved by the user
   before being applied: five `stable` (a device firmware property, a
   hosting-platform behaviour, a working lesson, a hardware fault history,
   and a measured platform limit) and one `evolving` (a service whose
   network address is assigned by DHCP and can change).
4. **Three present-tense passages rewritten as dated observations** in the
   fault history, so the fact could be `stable`: "sustained ever since"
   became "still the rate when diagnosed in July 2026"; "the device has two
   uploaders" became "as of 13 July 2026 the device had two uploaders"; a
   paragraph on current tooling and data location became "As of 2026-09-27:
   ...". Same facts; none of those lines can become false now. Every file
   kept its mtime and its `modified` stamp.
5. **Salience by placement, already in effect:** earlier in the same session
   a costly-mistake fact (a storage volume that holds the only copy of a
   dataset) had been made a rule in that project's `CLAUDE.md`.

Result: that project's store linted clean with nothing due for review.

Left open, for an interactive run (as of 2026-09-27):

- five unlabelled facts in three other project stores;
- one hot fact at 55 lines, over the 50-line budget (the dated wording added
  two lines), whose supporting detail should move to a cold file;
- one link to a fact that was never written;
- the memory-system skill's own documentation still calls volatility "how
  fast it rots", which contradicts the rule (recipe step R2). **Resolved
  2026-09-28** in the memory system's source repository and redeployed: the
  four skills, the helper tool's help text and the constellation viewer now
  speak of a re-check interval (the constant is `RECHECK_DAYS`, with the old
  `HALF_LIFE` kept as an alias); consolidation gained a DATE verb; the design
  record gained rows for the rule and for the no-new-fields decision.

---

## 5. Where the brain map shows this

The viewer's review-health colouring comes straight from `volatility`: a
permanent fact left unlabelled shows as `due` or `overdue` after 90 days,
which is noise. Labelling it `stable` shows it as stable permanently.

Consistent with the rule, the pages' live-update diff ignores age, health
and the half-life flag (`brainmap-spec.md` 6.5): those move with the clock,
and a moving clock is not a change to the memory.

---

## 6. Recipe

For an agent applying these decisions to a memory system of this design.
It describes what to do and how to check it; it contains no code to copy.

### R0. Ground rules

- **The review clock is sacred.** Never let an edit made during maintenance
  change a file's mtime or its `modified` stamp. Record both before editing
  and restore them after.
- **Have an undo first.** Before editing any memory, confirm the backup of
  the stores is current (for a snapshot repository: a fresh pushed commit
  and no blocked commits).
- **Unattended runs write only what the parser already assumes.** Backfilling
  `tier: hot` is safe because a missing tier already means hot. Choosing a
  `volatility`, rewording a fact, demoting a file to cold or deleting
  anything is a judgement: propose it and wait for the user.

### R1. Adopt the rule as a global memory

Write one hot `feedback` memory in the global store, `volatility: stable`,
and add its line to the global index (under preferences). Its content:

- **The rule:** facts do not go stale by date; some remain true in
  perpetuity whether or not anyone remembers them. Record when and in what
  context the user said it.
- **Why:** a review date is only a prompt to check whether the world
  changed; it says nothing about the fact. Treating age as decay invites
  deleting or "refreshing" things that are still true.
- **How to apply:** never describe memories as expiring, rotting or going
  stale; say "due for a re-check", and only for facts about mutable present
  state. Default permanent facts (device and platform properties, decisions
  and their reasons, physics, anything dated) to `stable`. Reserve
  `evolving` and `volatile` for undated claims about current state. Write
  time-bound facts as dated observations.

Lint the global store; expect no errors or warnings for the new file.

### R2. Fix the vocabulary in the schema documentation

Find every place the memory system's own documentation, skill texts and tool
help describe volatility or the re-check in decay terms ("rots", "goes
stale", "expires", "freshness") and reword them as re-check terms:
"volatility is how soon a fact should be re-checked against the world";
"due for a re-check" rather than "stale". Keep command names that users type
(a `stale` subcommand can stay; its help text should say "past their
re-check date").

### R3. Inventory

Run the lint and list every fact with no `volatility` (and no `tier`). Also
list facts past their re-check date, over-budget hot files and dangling
links, since the same interactive run usually clears them.

### R4. Classify each unlabelled fact

For each fact, read the body, then ask:

1. **Could the world change so that a sentence in this fact, as written,
   becomes false without anyone editing it?** If no, it is `stable`.
2. If yes: **can those sentences be rewritten with a date so the answer
   becomes no, without losing what the fact is for?** If yes, plan the
   rewrite (R5) and classify it `stable`.
3. Otherwise it describes live state: `evolving` if it changes on a scale of
   months (a DHCP-assigned address, a project phase, a toolchain version),
   `volatile` if on a scale of days or weeks (the current task, next steps).

Typical results:

| Kind of fact | Label |
|---|---|
| a device's or platform's inherent behaviour | stable |
| a decision and its reason | stable |
| a lesson or working rule | stable |
| a history or diagnosis, with dates | stable |
| a measurement, stated with when it was measured | stable |
| where a service currently runs, its current address, the deployed version | evolving |
| what is being worked on, what comes next | volatile |

### R5. Rewrite present-state claims as dated observations

Only where R4 said so, and only with approval. Patterns:

- "X, sustained ever since" becomes "X, still the case when <observed or
  diagnosed> in <month year>".
- "The device has N of Y" becomes "As of <date> the device had N of Y".
- A paragraph describing current tooling or locations becomes "As of
  <date>: ..." with its verbs in the past tense where they describe that
  moment.

The facts must not change: same numbers, same names, same conclusions.
Expect the file to grow a line or two; if that pushes a hot file over its
line budget, note it for demotion rather than trimming content.

### R6. Propose, then wait

Present a table: fact, proposed label, one-line reason, and any rewording.
Mark conditional proposals ("stable once these lines are dated"). Apply
nothing until the user approves; apply exactly what was approved.

### R7. Apply with the clock preserved

For each approved fact:

1. Record the file's access and modification times (nanoseconds) and the
   `modified` stamp if present.
2. Read it as UTF-8 bytes, note its line-ending style, and work on a copy
   normalised to line feeds.
3. Match the frontmatter block at the top of the file. Refuse (and report)
   if there is none, if the field already exists, or if the anchor line is
   missing (insert `tier` after `type`, `volatility` after `tier`).
4. Insert the new line immediately after its anchor with the anchor's
   indentation. Leave every other frontmatter line, including `modified`,
   byte-for-byte unchanged.
5. Apply each approved rewording only if its original passage occurs exactly
   once in the body; otherwise stop and report.
6. Restore the original line-ending style and write the file.
7. Set the recorded access and modification times back, then verify the
   mtime equals the recorded value exactly.

Editing through a script rather than the harness's own write tool also keeps
the harness from restamping `modified`; if your harness restamps on every
write, restore the stamp in step 4 as well.

### R8. Verify

- Lint the store: the labelled facts no longer warn; no new errors.
- Re-check list: nothing newly due, since `stable` facts never are.
- For every touched file: mtime unchanged, and `modified` unchanged where it
  existed.
- Links: no new dangling links; index drift: none.
- If a viewer such as the brain map is running, the relabelled facts' health
  changes to stable without anything else moving.

### R9. Salience by placement

Look for facts whose violation would be costly or irreversible: data loss
(the only copy of something), security (credentials, exposure), money, or
hardware damage. For each:

- add a rule to the relevant `CLAUDE.md` (project, or root if it is
  machine-wide) that states the constraint and its reason, so it is in
  context in every session where it matters;
- keep the memory for the detail and evidence, and link the two in wording;
- when the underlying object changes (a renamed volume, a moved database),
  update the rule, since it is loaded every session.

Everything else: useful facts get an index line; evidence and long history
go to cold files that a hot fact points at.

### R10. Provenance and truth value in the wording

When writing or reworking a memory:

- say where it came from: "the user said on <date>", "observed in <logs or
  tool> on <date>", "inferred from <evidence>"; quote the user for
  preferences and corrections;
- state negative facts explicitly and with their reason: "X does not work
  because Y (tried <date>)", never just the absence of X;
- date anything time-bound (R5).

### R11. Before adding any new metadata field

Add a field only if all of these hold:

1. it changes a decision made at the index line (recall is decided there;
   a tag seen only after opening the file cannot steer recall);
2. it can be set at write time without leaving a backlog, or it has a
   default the parser can apply mechanically;
3. it needs no write when the memory is read.

Measure the cost where you are: add up the bytes of every always-loaded file
(root and project instructions, every imported or auto-loaded index) and
divide by about 4 for tokens; average the frontmatter size over the memory
files; and remember that an index-line addition is paid every session, a
frontmatter addition only per recall. On the reference store: about 4,200
tokens always loaded, about 80 per frontmatter, about 7 per extra field.

Truth value, provenance, salience and use counts each fail at least one test,
which is why they are handled by R9 and R10 instead.

### R12. Record the run

In the global index's footer: the date, what was changed (counts), what was
left for an interactive run, and the next due dates for unattended and
interactive runs. Tell the user what needs their judgement, briefly.

---

## 7. Acceptance

- The global rule memory exists, is indexed, and lints clean.
- The schema documentation no longer describes facts as rotting or expiring.
- Every approved label is applied, every touched file's mtime and `modified`
  stamp are unchanged, and the store lints with no volatility warnings for
  those facts.
- Reworded facts state the same facts as before, with dates.
- Costly-mistake facts appear as rules, with reasons, in the relevant
  instructions file.
- No new frontmatter field was added without passing R11.
- The run is recorded in the global index footer.
