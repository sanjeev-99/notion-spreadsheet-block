# notion-spreadsheet-block

A 10×10 spreadsheet as a Notion **custom block**. Each cell holds a literal or a
formula; two tabs show computed **Values** and raw **Formulas**.

Notion has a database block (typed columns, no cross-cell computation) and an
HTML table block (no computation at all). This fills the gap.

`SUM AVERAGE MIN MAX COUNT IF ROUND ABS CONCAT`, arithmetic and comparison
operators, `A1` references, `A1:B3` ranges, `$`-absolute references that
translate correctly on copy/paste, cycle detection, and Excel-compatible
operator precedence. Cell contents live in a Notion database you own, one row
per non-empty cell, so computed values are visible to rollups, exports and
search.

---

## Requirements

- **Node ≥ 22** and **npm ≥ 10.9.2**.
- The **`ntn` CLI** (`npm install -g @notionhq/ntn`, then `ntn --version`).
  Built against `ntn` 0.22.x.
- A Notion workspace with **custom blocks enabled**. Custom blocks are in
  private alpha and currently require a Business or Enterprise workspace that
  Notion has enabled the alpha for — see
  [Limitations](#limitations). If `ntn workers deploy` rejects the custom block
  capability, your workspace does not have it yet.

## Setup

### 1. Clone, install, verify

```shell
git clone https://github.com/sanjeev-99/notion-spreadsheet-block.git
cd notion-spreadsheet-block
npm install

npm test        # formula engine tests
npm run check   # type-check worker + block
```

### 2. Connect the CLI to your workspace

```shell
ntn login
```

This opens a browser to authorize the CLI. Confirm you landed in the right
place — `ntn workers list` should succeed and show the workers in that
workspace.

### 3. Deploy the worker

```shell
ntn workers deploy
```

The first deploy creates the worker and writes a `workers.json` holding your
workspace and worker ids. **That file is gitignored on purpose** — it is
per-installation, not part of the source.

Deploying builds the block (`npx vite build` inside `blocks/spreadsheet`) and
uploads the static bundle. There is no server half and no environment variables
or secrets to push: the block runs entirely in the browser, and it talks to
Notion through the host bridge using the *viewer's* permissions.

Confirm the capability registered:

```shell
ntn workers capabilities list
```

### 4. Create the backing database

**Notion never creates this for you.** Add a database anywhere in your
workspace with exactly these four properties:

| Property | Type | Holds |
| --- | --- | --- |
| `Cell` | Title | The cell reference, e.g. `A1` |
| `Raw` | Text | What the user typed — a literal or a formula |
| `Value` | Text | The computed result, or an error token |
| `Block ID` | Text | Which block instance the row belongs to |

Property **names** must match; the block binds by name. Leave the database
empty — the block writes its own rows.

> One database can back several sheets (`Block ID` keeps them apart), but see
> [One database, or one per sheet?](#one-database-or-one-per-sheet) — the
> practical ceiling is about 9 sheets, and one database per sheet is the safe
> default.

### 5. Insert the block

On any Notion page, type `/spreadsheet` and pick it from the slash menu. The
command is registered by the worker and appears for any workspace member the
worker is shared with, once the deploy has landed. (`/custom` also lists every
custom block available to you.)

### 6. Bind the data source

A custom block does not initialize until every data source it declares is
bound. Use the block's **Connect data** control to point the `cells` slot at
the database from step 4.

That is the whole install. Type into a cell and it saves.

### Upgrading

```shell
git pull && npm install && ntn workers deploy
```

Deployed blocks pick up the new bundle. Bindings and data are untouched — the
`cells` schema is unchanged across versions, which is deliberate: adding a
declared property would force every already-bound block to be re-bound before
it would initialize again. See
[the `#sheet` row](#layout-and-formatting-the-sheet-row) for how layout and
formatting avoid new properties for exactly this reason.

---

## Architecture

There is no server in the request path. A custom block runs in a sandboxed
iframe whose CSP limits network access to the block's own origin, so the formula
engine is bundled and evaluates in the browser. The worker half
(`src/index.ts`) exists only to declare how the block is built and what data
source schema it expects — it has no `execute` handler and cannot be run with
`ntn workers exec`.

```
src/index.ts                     worker.customBlock() — build + schema declaration
blocks/spreadsheet/src/
  index.tsx                      mounts <NotionCustomBlock> (host handshake, auto-resize)
  App.tsx                        tabs, formula bar, clear + error actions, selection
  Grid.tsx                       the 10x10 grid, edit mode and keyboard handling
  FormulaBar.tsx                 raw text of the selected cell, always editable
  selection.ts                   cell / whole-row / whole-column selection
  useCells.ts                    the ONLY module that talks to the Notion host
  engine/                        pure formula engine — no Notion or React imports
src/data/worker_cells.json       fixture rows for the local dev shell
test/engine.test.ts              engine tests, run under node --test
```

## Editing

Editing follows Excel, not a plain web form. **Selecting a cell does not make it
editable** — a selected cell keeps showing its computed result, and the formula
bar shows the raw text behind it. You enter edit mode explicitly:

| Action | Effect |
| --- | --- |
| Type a character | Opens the cell and **replaces** its contents |
| `F2` / `Enter` / double-click | Opens the cell to **amend**, caret at the end |
| Formula bar | Edits the raw text in place, never replacing |
| `Delete` / `Backspace` | Clears the selection |
| `Shift` + arrows / click | Extends the selection into a rectangle |
| `Cmd/Ctrl` + `C` / `X` / `V` | Copy, cut, paste — see below |
| Arrows / `Tab` / `Enter` | Navigate (arrows move the caret while editing) |
| `Escape` | Abandons the edit |

This is what stops a formula being clobbered: entering edit mode always loads
the cell's **raw** text, so a cell displaying `255` opens as `=SUM(B2:C2)`. Both
tabs are editable — Formulas is a different view of the same grid, not a
read-only inspector.

**Drag** across cells, or **shift-click** / **shift-arrow**, to select a
rectangle. Clicking a row or column header selects the whole line; the toolbar
then offers to clear it. Selection is rectangular only — there is deliberately no
non-contiguous multi-select, because a clipboard has no way to represent one
(Excel refuses the same operation).

Two details make the gesture work, and both are easy to break:

- The grid's focus handler resets the selection only when focus lands on a cell
  the selection does **not** cover. Without that guard, focusing a range's own
  corner looks like a click elsewhere and collapses the range the moment it is
  made — which silently disabled range selection entirely until it was fixed.
- Cells that are not being edited set `user-select: none`, so dragging across
  the grid does not start a native text selection inside each input.

### Copy, cut and paste

`Cmd/Ctrl+C`, `X` and `V` operate on the selection. The clipboard carries **raw
text as TSV**, so a formula survives the round trip and pasting into Excel or
Sheets carries the formula rather than the number it displayed.

Pasting a block copied from *this* grid **translates its formulas** by the offset
moved, exactly as a spreadsheet does — `=B2*$C$1` copied from D2 down to D3
becomes `=B3*$C$1`. A `$` pins the half it precedes:

| Written | Copied one row down, one column right |
| --- | --- |
| `A1` | `B2` |
| `$A1` | `$A2` |
| `A$1` | `B$1` |
| `$A$1` | `$A$1` |

A reference pushed off the grid becomes `#REF!` in the pasted formula, which is
why the tokenizer reads error literals — the language has to parse its own
output back.

Text pasted from **another application** has no origin to measure an offset
from, so its formulas are taken exactly as written rather than being shifted.
Pasted blocks are clipped at the visible edge; they never wrap or grow the grid.

The rewrite works on the token stream, splicing only reference tokens, so the
author's spacing, capitalisation and redundant parentheses survive. Cell
references themselves normalise to uppercase, as they do in Excel.

> Formatting is **not** carried by copy/paste — only cell contents. Paste is one
> write per cell, so a large block is a lot of round trips. Clearing is sparse-aware, so only cells that actually hold
something cost a request. A chip in the toolbar counts cells currently in error
and jumps between them.

## Storage

Persistence is the bound `cells` data source, **one row per non-empty cell**:

| Cell | Raw | Value | Block ID |
| --- | --- | --- | --- |
| A1 | `Region` | `Region` | `<block uuid>` |
| B2 | `120` | `120` | `<block uuid>` |
| D2 | `=SUM(B2:C2)` | `255` | `<block uuid>` |

- **`raw`** is exactly what the user typed. **`value`** is the debounced computed
  result, stored so formula output is visible in Notion itself (rollups,
  exports, search). The block always renders from `raw`, so a stale `value` is
  cosmetic.
- **Cell type is inferred, never stored.** A leading `=` is a formula; otherwise
  a successful numeric parse is a number; otherwise text.
- **`blockId`** scopes rows to one block instance, so several sheets can share a
  backing database. `useDataSource` has no filter option, so the block fetches
  every row and filters client-side.
- `value` is `rich_text` rather than `number` because a cell may compute to a
  string or to an error token.

### Layout and formatting: the `#sheet` row

Column widths, row heights, how much of the grid is shown, and per-cell
bold/italic/colour all live in **one extra row** of the same database, with
`Cell = "#sheet"` and a compact JSON blob in `Raw`:

```json
{"c":{"0":140},"r":{"2":40},"v":[7,4],"f":{"A1":"bcr","B2":"igo"}}
```

This deliberately avoids new properties. A declared property that existing
databases lack would force **every already-deployed block to be re-bound** before
it would initialize again; a reserved row costs nothing, because `useCells`
already skips rows whose `Cell` is not a valid reference.

The price is Notion's 2000-character `rich_text` cap, which is why the blob uses
single-letter keys and token strings (`"bcr"` = bold, red text) rather than
readable names — spelling colours out came to 4679 characters for a fully
formatted grid, against 1579 encoded. `serializeSheetMeta` reports its length and
the block **refuses to write** rather than let Notion truncate the blob and
corrupt every cell's formatting at once.

Collapsing the grid (say to 4×7) hides cells but **keeps their data**, and the
engine still evaluates the full 10×10 — so a formula referencing a hidden cell
keeps working. Only formatting is pruned on collapse, since it would otherwise
sit in the blob unseen and unremovable.

### One database, or one per sheet?

**Notion never creates the database for you.** The block only *declares* the
`cells` schema; when someone inserts the block they bind that slot to a data
source they pick or create, and the block does not initialize until they do. So
every instance is bound by hand, and may share a database or not.

**Sharing is safe** — `blockId` scopes rows, so instances never see each other's
cells.

> **Duplicating a page or block has not been tested.** A copied block should get
> a new block id, which would leave it showing an empty sheet while the
> original's rows stay put under the old id. Since there is no per-block state
> store, `blockId` is the only handle available — verify this before relying on
> duplication.

## Formula language

`SUM AVERAGE MIN MAX COUNT IF ROUND ABS CONCAT`, the operators
`+ - * / ^` and `= <> < <= > >=`, `A1` references and `A1:B3` ranges.

References may be written `A1`, `$A1`, `A$1` or `$A$1`. The `$` makes **no
difference to what a formula computes** — it only decides which halves move when
the formula is copied elsewhere. Ranges may be spaced (`A1 : A3`).

Percentages work both as literals and as an operator: a cell containing `5%`
holds `0.05` but still **reads** as `5%`, and `=100*(1+5%)` is `105`. There is
nowhere to store a number format, so a percentage literal's own text is its
format — which is why a *formula* returning `0.05` displays `0.05`, not `5%`.
Nothing recorded that it was a percentage.

Three deliberate Excel/Sheets compatibilities that differ from ordinary
programming-language semantics:

- `^` is right-associative — `2^3^2` is 512.
- Unary minus binds **tighter** than `^` — `-2^2` is 4, not −4.
- `%` is **postfix percent, never modulo**, and binds tighter than everything —
  `2^3%` is `2^0.03`. Use the `MOD` function if modulo is ever needed (it is not
  implemented today).

Aggregates skip non-numeric text rather than erroring, so a range that includes
a header label still sums. `IF` is lazy, so `=IF(B1=0, "n/a", A1/B1)` does not
produce a `#DIV/0!`.

Errors are values and propagate to dependents: `#REF!`, `#CYCLE!`, `#DIV/0!`,
`#NAME?`, `#VALUE!`, `#ERROR!`.

Cycles are detected by the evaluator re-entering a cell that is already being
computed, which is what a circular reference *is* — so there is no separate
graph-colouring pass.

## Development

```shell
npm test               # engine tests (node --test, native type stripping)
npm run check          # type-check worker + block
ntn customblocks dev   # mock Notion host at http://localhost:9873
```

The formula engine under `blocks/spreadsheet/src/engine/` imports neither React
nor the Notion SDK, so it is testable as plain functions — that is where new
functions and operators should go, with a case in `test/engine.test.ts`.

In the dev shell, use **Connect data** to bind the `cells` slot to the
"Spreadsheet cells" source before the block will render — a block does not
initialize until every declared data source is bound. The fixture rows use the
shell's constant block id (`dev-shell-block`); one row deliberately carries a
different id to prove instance scoping.

The shell reads `src/data/*.json` once at spin-up — restart it to pick up edits.

### The dev shell cannot update existing rows

**Editing a pre-existing cell always fails locally with `page not found`. This
is a limitation of the mock host, not of this block** — do not spend time
debugging it.

The shell's mock supplies only an `onQuery` handler. For writes it falls back to
a built-in page registry that is populated *only by pages created during the
session*. Fixture rows arrive through the query path and are never registered,
so `updatePage` (which backs both editing and clearing a cell) misses the
registry and errors. Creating a new cell works, because `createPage` is what
populates that registry in the first place.

So locally you can exercise: rendering, formula evaluation, both tabs, keyboard
handling, selection, the failure banner, and creating new cells. **Editing and
clearing existing cells can only be verified against real Notion**, after
`ntn workers deploy`.

When a write is rejected the block keeps your text, underlines the cell, and
offers a retry — it never silently reverts an edit.

## Limitations

- **Private alpha.** Deployed blocks may break as Notion makes
  non-backwards-compatible SDK changes. Requires a Business/Enterprise
  workspace with the alpha enabled.
- **No batch writes.** Each changed cell is its own API round-trip. Value
  writeback is debounced 1s and diffed against what the row already holds so a
  cascade is one burst rather than one write per keystroke.
- **Last-write-wins.** Two people editing the same block concurrently will
  clobber each other. No locking or conflict UI.
- **A rejected write is surfaced, not swallowed.** The cell keeps its text, gets
  a wavy underline, and a banner offers a retry. Reloading the page before a
  successful retry does lose that text.
- **Notion's Cmd+Z will not undo a cell edit** — there is no in-block undo.
- **999-row query cap**, so one backing database holds ~9 full sheets. Beyond
  that the block locks editing rather than risk duplicate rows. One database per
  sheet is the safe default.
- **`rich_text` caps at 2000 characters** per cell.
- The backing database is user-visible and user-editable; rows whose `Cell` is
  not a valid ref are ignored rather than treated as an error.
- Writes use the **viewer's** permissions, so a read-only collaborator gets a
  read-only sheet without any extra code.

## Troubleshooting

**The block never renders / shows a loading state forever.** The `cells` data
source is not bound. A custom block does not initialize until every declared
data source has a binding — use **Connect data** on the block.

**`/spreadsheet` is not in the slash menu.** The command is registered at
deploy time, so `ntn workers deploy` must have succeeded; check
`ntn workers capabilities list`. It only appears for members the worker is
shared with, and only in the workspace you deployed to.

**Editing works in real Notion but fails locally with `page not found`.** Known
dev-shell limitation, explained in full
[above](#the-dev-shell-cannot-update-existing-rows) — not a bug in the block.

**Editing is locked with a warning about database size.** The bound database
crossed the 999-row query cap. Move this sheet to its own database.

**Cells show the wrong value after editing outside the block.** The block
renders from `Raw` and recomputes; `Value` is a written-back copy. Editing
`Value` directly in the Notion database does nothing lasting — edit `Raw`, or
edit in the block.

## Contributing

Issues and pull requests are welcome. Please run `npm test` and
`npm run check` before opening a PR, and add an engine test for any change to
formula behaviour.

## License

[MIT](LICENSE) © Sanjeev Bhalla.

Not affiliated with or endorsed by Notion Labs, Inc.
