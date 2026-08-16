import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

// ── Custom block: 10x10 spreadsheet ───────────────────────────
// A sandboxed iframe app served by Notion. There is no server half: the block's
// CSP limits network access to its own origin, so the formula engine is bundled
// and runs entirely in the browser. This worker exists only to declare how the
// block is built and what data source schema it expects.
//
// Persistence is the bound data source, one row per NON-EMPTY cell:
//
//   Cell | Raw         | Value | Block ID
//   A1   | 10          | 10    | <block uuid>
//   A2   | 32          | 32    | <block uuid>
//   A3   | =SUM(A1:A2) | 42    | <block uuid>
//
// `raw` is exactly what the user typed; `value` is the debounced computed
// result, so formula output is visible in Notion itself (rollups, exports,
// search). Cell type is inferred, never stored — a leading "=" means formula,
// otherwise a successful numeric parse means number, otherwise string.
//
// `value` is rich_text rather than number because a cell may compute to a
// string ("Revenue") or to an error token (#REF!, #CYCLE!, #DIV/0!).
//
// `blockId` scopes rows to one block instance so several sheets can share a
// single backing database. useDataSource has no filter option, so the block
// fetches all rows and filters on this client-side.
worker.customBlock("spreadsheet", {
	path: "./blocks/spreadsheet",
	command: "npx vite build",
	output: "dist",
	version: 1,
	slashCommand: "spreadsheet",
	dataSources: {
		cells: {
			name: "Spreadsheet cells",
			description:
				"Backing store for the spreadsheet block — one row per non-empty cell.",
			icon: { type: "emoji", emoji: "🧮" },
			properties: {
				cell: {
					name: "Cell",
					description: "Cell reference, e.g. A1",
					type: "title",
				},
				raw: {
					name: "Raw",
					description: "What the user typed: a literal or a formula",
					type: "rich_text",
				},
				value: {
					name: "Value",
					description: "Computed result, or an error token",
					type: "rich_text",
				},
				blockId: {
					name: "Block ID",
					description: "Owning block instance — scopes rows to one sheet",
					type: "rich_text",
				},
			},
		},
	},
})
