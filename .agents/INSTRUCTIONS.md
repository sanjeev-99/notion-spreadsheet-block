# Repository Guidelines

Agent guidance for `notion-spreadsheet-block`. `AGENTS.md` and `CLAUDE.md` are
symlinks to this file — edit it here, not through a symlink.

This repo declares exactly **one** capability: a `worker.customBlock()`. There
are no syncs, tools, automations, webhooks or OAuth connections, and there is no
reason to add any. If a task seems to call for one, that is a signal to
re-read the problem, not to scaffold a new capability.

Read `README.md` before changing behaviour. It documents the design decisions
that are easy to undo by accident, and most of them have a comment in the code
pointing back at it.

## Project structure

```
src/index.ts                     worker.customBlock() — build + schema declaration
blocks/spreadsheet/src/
  index.tsx                      mounts <NotionCustomBlock> (host handshake)
  App.tsx                        tabs, formula bar, toolbar actions, selection
  Grid.tsx                       the 10x10 grid, edit mode, keyboard handling
  FormulaBar.tsx                 raw text of the selected cell
  selection.ts                   cell / whole-row / whole-column selection
  clipboard.ts                   TSV copy, cut, paste
  sheetMeta.ts                   the "#sheet" row: widths, heights, formatting
  useCells.ts                    the ONLY module that talks to the Notion host
  engine/                        pure formula engine — no Notion or React imports
src/data/worker_cells.json       fixture rows for the local dev shell
test/*.test.ts                   node --test, no framework
```

Generated and untracked: `dist/`, `blocks/spreadsheet/dist/`, `node_modules/`,
`.dev-shell/`, and `workers.json` (per-installation CLI config — never commit
it, it holds workspace and worker ids).

## Custom block capability

`worker.customBlock()` declares a front-end web app that Notion serves in a
sandboxed iframe. It is a build/deploy-time capability with **no `execute`
handler**, so it cannot be run with `ntn workers exec`. Two SDK surfaces:

- `@notionhq/workers` — declares how the block is built and what data-source
  schemas it expects (`src/index.ts`).
- `@notionhq/custom-blocks` — lets the iframe frontend talk to the Notion host
  at runtime (`useCells.ts`, `index.tsx`).

Both live in the single root `package.json`; the block frontend shares it and
its `node_modules`. **Do not create a second `package.json` inside
`blocks/spreadsheet`.**

The block's CSP limits network access to its own origin, so everything —
including the formula engine — is bundled and runs in the browser. Do not
reach for a network call; there is nowhere to call.

Consult the installed packages for the current client API, since it is still
moving: `node_modules/@notionhq/custom-blocks/docs/` and the package READMEs.

### Declaring the block

`path` points at a buildable directory relative to the worker root; `command`
and `output` override the default `npm run build` / `dist`:

```ts
worker.customBlock("spreadsheet", {
  path: "./blocks/spreadsheet",
  command: "npx vite build",
  output: "dist",
  version: 1,
  slashCommand: "spreadsheet",
  dataSources: { /* ... */ },
})
```

`slashCommand` registers `/spreadsheet` in Notion's slash menu at deploy time,
for members the worker is shared with. A leading slash is optional.

### Data-source schemas

`dataSources` declares the schema a block *expects*. It does **not** bind the
block to a concrete database — whoever inserts the block picks or creates one,
and the block does not initialize until every declared slot is bound. Schema
keys and property keys are author-defined; the block reads them with
`useDataSource("cells")`.

Property types use Public API names (`title`, `rich_text`, `number`, `select`,
`status`, `date`, `checkbox`, `relation`, …).

> **Adding a property to `dataSources` is a breaking change.** Every
> already-deployed, already-bound block would stop initializing until someone
> re-bound it by hand. This is why layout and per-cell formatting are packed
> into a reserved `#sheet` row instead of new properties — see the README.
> Treat the four-property schema as frozen.

## Invariants worth knowing before you edit

- **`engine/` imports neither React nor the Notion SDK.** Keep it that way; it
  is what makes the formula language testable as plain functions.
- **`useCells.ts` is the only module that talks to the host.** Notion calls
  belong there, not in components.
- **The grid renders from `raw`, never from `value`.** `value` is a
  debounced write-back so results are visible to Notion rollups and search; a
  stale one is cosmetic.
- **`blockId` scopes rows** so several sheets can share one database.
  `useDataSource` cannot filter and caps at 999 rows, so the block watches
  `hasMore` and locks editing rather than risk creating duplicate rows.
- **`serializeSheetMeta` refuses to write** past Notion's 2000-character
  `rich_text` cap. Do not "fix" that by truncating — truncation corrupts every
  cell's formatting at once.
- Excel compatibility in the engine is deliberate and tested: right-associative
  `^`, unary minus binding tighter than `^`, postfix `%` that is never modulo.

## Build, test, develop

Node >= 22 and npm >= 10.9.2 (see `engines`).

```shell
npm test               # engine, selection, sheetMeta, translate (node --test)
npm run check          # type-check worker and block, no emit
npm run build          # compile src/ to dist/
ntn customblocks dev   # mock Notion host at http://localhost:9873
ntn workers deploy     # build the block and publish
```

Custom blocks are exercised in the dev shell, **not** with `ntn workers exec`.
Add a case to `test/` for any change to formula or clipboard behaviour — that
is where regressions are cheap to catch.

**The dev shell cannot update pre-existing rows.** Editing a fixture cell
always fails locally with `page not found`; its mock only registers pages
created during the session. This is a limitation of the mock host, not a bug —
do not debug it. Editing and clearing existing cells can only be verified
against real Notion after a deploy.

To inspect the backing database from the CLI, query the **data source** id, not
the database id:

```shell
ntn datasources resolve <database-id>   # database id -> data source ids
ntn datasources query <data-source-id>
```

A 404 from `query` usually means you passed a database id; `resolve` it first.

## Coding style

- TypeScript with `strict`; keep types explicit when shaping I/O.
- **Tabs** for indentation. Capability keys in lowerCamelCase.
- Comments explain *why*, especially where a decision looks arbitrary — several
  behaviours here read as bugs until you know the constraint behind them.

## Commits and PRs

- Messages use `feat(scope): ...` / `fix(scope): ...`, or version bumps.
- Run `npm test` and `npm run check` before opening a PR.
- Describe the change, list the commands run, and update `README.md` when
  behaviour changes.
