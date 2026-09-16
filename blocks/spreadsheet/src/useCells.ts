/**
 * Persistence: the only module that talks to the Notion host.
 *
 * The bound `cells` data source holds one row per non-empty cell. This hook
 * turns those rows into a `RawGrid` the engine can evaluate, and turns cell
 * edits back into row writes.
 *
 * Two things drive the shape of this code:
 *
 *   - `useDataSource` has no filter, so every row of the bound source arrives
 *     and rows belonging to other block instances are dropped here.
 *   - There is no batch write. Each changed cell is its own round-trip, which
 *     is why `value` writeback is debounced and diffed rather than fired on
 *     every keystroke.
 */

import { pages } from "@notionhq/custom-blocks"
import type {
	NotionDataSourcePage,
	NotionPageId,
	NotionPagePropertyWriteMap,
} from "@notionhq/custom-blocks"
import { useBlockId, useDataSource } from "@notionhq/custom-blocks/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { type EvaluatedGrid, type RawGrid, evaluateGrid } from "./engine/evaluate.ts"
import { parseRef } from "./engine/refs.ts"
import {
	META_CELL_KEY,
	type SheetMeta,
	fitsInProperty,
	parseSheetMeta,
	serializeSheetMeta,
} from "./sheetMeta.ts"

/** How long to wait after the last edit before writing computed values back. */
const VALUE_WRITEBACK_DELAY_MS = 1000

/**
 * How long to wait before persisting layout and formatting. Dragging a column
 * edge emits a change per pointer move, so this must outlast a drag.
 */
const META_WRITEBACK_DELAY_MS = 700

/** The data source is fetched whole; 999 is the host's cap. */
const ROW_LIMIT = 999

const asText = (value: unknown): string =>
	value === undefined || value === null ? "" : String(value)

const richText = (content: string) => ({
	type: "rich_text" as const,
	rich_text: content ? [{ type: "text", text: { content } }] : [],
})

const title = (content: string) => ({
	type: "title" as const,
	title: content ? [{ type: "text", text: { content } }] : [],
})

type StoredRow = {
	item: NotionDataSourcePage
	raw: string
	value: string
}

export type CellsState = {
	/** Raw text per cell, local edits layered over what Notion has. */
	raws: RawGrid
	/** Computed values and display strings for the whole grid. */
	grid: EvaluatedGrid
	/** True until the first query response arrives. */
	isLoading: boolean
	/**
	 * The bound database holds more rows than one query returns, so this sheet's
	 * rows may be incomplete. Editing is unsafe while true — see `useCells`.
	 */
	truncated: boolean
	/** A query failure worth surfacing to the user. */
	error: string | undefined
	/**
	 * Cells whose write was rejected, keyed by ref, with the host's message. The
	 * typed text is still in `raws` — a rejected write never discards input.
	 */
	failures: Record<string, string>
	/** Commits a cell edit. Empty text deletes the row. */
	setCell: (ref: string, raw: string) => void
	/** Clears every cell in `refs` that actually holds something. */
	clearCells: (refs: string[]) => void
	/** Writes many cells at once, as a paste does. */
	setCells: (entries: Array<{ ref: string; raw: string }>) => void
	/** Re-attempts every write that previously failed. */
	retryFailed: () => void
	/** Column widths, row heights, visible size, and per-cell formatting. */
	meta: SheetMeta
	/** Applies layout or formatting. Takes effect at once, persists debounced. */
	setMeta: (next: SheetMeta) => void
}

export function useCells(): CellsState {
	const blockId = useBlockId()
	const {
		items,
		isLoading,
		hasMore,
		propertyIdsByKey,
		error: queryError,
	} = useDataSource("cells", {
		limit: ROW_LIMIT,
		filter:{ // Filter datasource by the id of the block
			and: [
					{
						key: "blockId",
						rich_text: {
							equals: blockId
						}
					}
			]
		}
	})

	// A newly created page does not appear in the query straight away. Without
	// remembering it, a second edit to the same cell before the refresh would see
	// no stored row and create a DUPLICATE. Entries are dropped once the query
	// catches up.
	const createdIds = useRef(new Map<string, NotionPageId>())
	const propertyIdsRef = useRef(propertyIdsByKey)
	propertyIdsRef.current = propertyIdsByKey

	/**
	 * Writes to a page the query has not returned yet. `pages.update` is keyed by
	 * raw Notion property ID rather than by our declared keys, hence the lookup —
	 * the key-aware helper only exists on rows the query gave us.
	 */
	const writeByPageId = useCallback(
		(pageId: NotionPageId, fields: { raw?: string; value?: string }) => {
			const ids = propertyIdsRef.current
			const properties: NotionPagePropertyWriteMap = {}

			if (fields.raw !== undefined && ids.raw) {
				properties[ids.raw] = { id: ids.raw, ...richText(fields.raw) }
			}
			if (fields.value !== undefined && ids.value) {
				properties[ids.value] = { id: ids.value, ...richText(fields.value) }
			}

			return pages.update({ pageId, properties })
		},
		[]
	)

	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [failures, setFailures] = useState<Record<string, string>>({})

	// Rows belonging to THIS block instance, keyed by cell ref. Rows for other
	// instances, and rows whose Cell property isn't a valid ref, are ignored
	// rather than treated as an error — the backing database is user-visible and
	// may well contain hand-edited junk.
	const rows = useMemo(() => {
		const byRef = new Map<string, StoredRow>()
		for (const item of items) {
			// if (asText(item.propertiesByKey.blockId) !== blockId) continue

			const ref = asText(item.propertiesByKey.cell).trim().toUpperCase()
			if (!parseRef(ref)) continue

			byRef.set(ref, {
				item,
				raw: asText(item.propertiesByKey.raw),
				value: asText(item.propertiesByKey.value),
			})
		}
		return byRef
	}, [items, blockId])

	// Layout and formatting live in one reserved row rather than in columns of
	// their own, so that adding them did not change the declared schema and force
	// every deployed block to be re-bound.
	const metaRow = useMemo(
		() =>
			items.find(
				(item) =>
					// asText(item.propertiesByKey.blockId) === blockId &&
					asText(item.propertiesByKey.cell).trim() === META_CELL_KEY
			),
		[items, blockId]
	)

	const storedMeta = useMemo(
		() => parseSheetMeta(metaRow ? asText(metaRow.propertiesByKey.raw) : ""),
		[metaRow]
	)

	const [metaDraft, setMetaDraft] = useState<SheetMeta | null>(null)
	const meta = metaDraft ?? storedMeta

	const metaRowRef = useRef(metaRow)
	metaRowRef.current = metaRow

	// Drop the draft once the query reports the same layout back, mirroring how
	// cell drafts settle.
	useEffect(() => {
		setMetaDraft((current) =>
			current !== null &&
			serializeSheetMeta(current) === serializeSheetMeta(storedMeta)
				? null
				: current
		)
	}, [storedMeta])

	useEffect(() => {
		if (metaDraft === null) return

		const serialized = serializeSheetMeta(metaDraft)
		if (!fitsInProperty(serialized)) {
			// Better to refuse than to let Notion truncate the blob and corrupt
			// every cell's formatting at once.
			setFailures((current) => ({
				...current,
				[META_CELL_KEY]:
					"too much layout and formatting to fit in one Notion property — reduce the number of coloured cells",
			}))
			return
		}

		const timer = setTimeout(() => {
			const existing = metaRowRef.current
			const pendingId = createdIds.current.get(META_CELL_KEY)

			// Only ever ONE metadata row per block: a second one would leave the
			// sheet's layout flipping between whichever the query returned last.
			const write = existing
				? existing.update({
						properties: { raw: richText(serialized), value: richText("layout") },
					})
				: pendingId
					? writeByPageId(pendingId, { raw: serialized, value: "layout" })
					: pages
							.create({
								parent: { type: "data_source_key", key: "cells" },
								properties: {
									cell: title(META_CELL_KEY),
									raw: richText(serialized),
									value: richText("layout"),
									blockId: richText(blockId),
								},
							})
							.then((created) => {
								if (created.status === "success") {
									createdIds.current.set(META_CELL_KEY, created.page.id)
								}
								return created
							})

			void write
				.then((result) => {
					setFailures((current) => {
						const failed = result.status === "error"
						if (failed) {
							return { ...current, [META_CELL_KEY]: result.error.message }
						}
						if (!(META_CELL_KEY in current)) return current
						const { [META_CELL_KEY]: _saved, ...rest } = current
						return rest
					})
				})
				.catch((cause: unknown) => {
					setFailures((current) => ({
						...current,
						[META_CELL_KEY]:
							cause instanceof Error ? cause.message : String(cause),
					}))
				})
		}, META_WRITEBACK_DELAY_MS)

		return () => clearTimeout(timer)
	}, [metaDraft, blockId, writeByPageId])

	useEffect(() => {
		if (metaRow) createdIds.current.delete(META_CELL_KEY)
	}, [metaRow])

	// A draft is the user's most recent intent for a cell. It outranks the stored
	// row until the query catches up and reports the same text, at which point it
	// has served its purpose and is dropped.
	useEffect(() => {
		setDrafts((current) => {
			const remaining: Record<string, string> = {}
			let changed = false
			for (const [ref, raw] of Object.entries(current)) {
				const stored = rows.get(ref)
				const settled = stored ? stored.raw === raw : raw === ""
				if (settled) changed = true
				else remaining[ref] = raw
			}
			return changed ? remaining : current
		})
	}, [rows])

	const raws = useMemo(() => {
		const merged: RawGrid = {}
		for (const [ref, stored] of rows) merged[ref] = stored.raw
		for (const [ref, raw] of Object.entries(drafts)) merged[ref] = raw
		return merged
	}, [rows, drafts])

	const grid = useMemo(() => evaluateGrid(raws), [raws])

	const setCell = useCallback(
		(ref: string, nextRaw: string) => {
			const raw = nextRaw.trim() === "" ? "" : nextRaw
			const stored = rows.get(ref)
			if ((stored?.raw ?? "") === raw) return

			setDrafts((current) => ({ ...current, [ref]: raw }))

			// The computed value is written here too so the row is never
			// momentarily self-inconsistent; the debounced pass below repairs
			// dependents.
			const display = evaluateGrid({ ...raws, [ref]: raw })[ref].display

			// A page created moments ago but not yet returned by the query.
			const pendingId = createdIds.current.get(ref)

			const write = async () => {
				if (raw === "") {
					if (stored) return pages.delete(stored.item.id)
					if (pendingId) {
						createdIds.current.delete(ref)
						return pages.delete(pendingId)
					}
					return { status: "success" as const }
				}
				if (stored) {
					return stored.item.update({
						properties: { raw: richText(raw), value: richText(display) },
					})
				}
				if (pendingId) return writeByPageId(pendingId, { raw, value: display })

				const created = await pages.create({
					parent: { type: "data_source_key", key: "cells" },
					properties: {
						cell: title(ref),
						raw: richText(raw),
						value: richText(display),
						blockId: richText(blockId),
					},
				})
				if (created.status === "success") {
					createdIds.current.set(ref, created.page.id)
				}
				return created
			}

			// A rejected write keeps the draft. Reverting the cell would silently
			// throw away what the user typed and leave them guessing why nothing
			// changed; instead the text stays put, the cell is flagged unsaved, and
			// the edit can be retried.
			const recordFailure = (message: string) =>
				setFailures((current) => ({ ...current, [ref]: message }))

			const clearFailure = () =>
				setFailures((current) => {
					if (!(ref in current)) return current
					const { [ref]: _resolved, ...rest } = current
					return rest
				})

			void write()
				.then((result) => {
					if (result.status === "error") recordFailure(result.error.message)
					else clearFailure()
				})
				.catch((cause: unknown) => {
					recordFailure(cause instanceof Error ? cause.message : String(cause))
				})
		},
		[rows, raws, blockId, writeByPageId]
	)

	// Once the query returns a row we created, the remembered id is redundant.
	useEffect(() => {
		for (const ref of createdIds.current.keys()) {
			if (rows.has(ref)) createdIds.current.delete(ref)
		}
	}, [rows])

	const retryFailed = useCallback(() => {
		for (const ref of Object.keys(failures)) setCell(ref, drafts[ref] ?? "")
	}, [failures, drafts, setCell])

	// There is no batch write API, so a paste is simply N independent writes.
	// Pasting a 10x10 block is 100 requests; the caller keeps blocks small by
	// clipping to the visible grid.
	const setCells = useCallback(
		(entries: Array<{ ref: string; raw: string }>) => {
			for (const entry of entries) setCell(entry.ref, entry.raw)
		},
		[setCell]
	)

	// Clearing is sparse-aware: only cells that actually have a row cost a
	// request, so clearing a mostly-empty row is usually one or two deletes
	// rather than ten.
	const clearCells = useCallback(
		(refs: string[]) => {
			for (const ref of refs) {
				if (rows.has(ref)) setCell(ref, "")
			}
		},
		[rows, setCell]
	)

	// Debounced value writeback. Recomputing is free, but writing is not: one
	// edit can cascade through many dependents, so wait for the edits to settle
	// and then write only the rows whose stored value is actually stale.
	const gridRef = useRef(grid)
	gridRef.current = grid
	const rowsRef = useRef(rows)
	rowsRef.current = rows
	const failuresRef = useRef(failures)
	failuresRef.current = failures

	useEffect(() => {
		const timer = setTimeout(() => {
			for (const [ref, stored] of rowsRef.current) {
				// A cell whose write is already failing would just fail again, so
				// don't retry it on a timer behind the user's back.
				if (ref in failuresRef.current) continue

				const display = gridRef.current[ref]?.display ?? ""
				if (stored.value === display) continue
				void stored.item
					.update({ properties: { value: richText(display) } })
					.catch(() => {
						// A stale cached value is cosmetic — the block always renders
						// from `raw`. Leave it for the next edit to fix rather than
						// interrupting the user.
					})
			}
		}, VALUE_WRITEBACK_DELAY_MS)

		return () => clearTimeout(timer)
	}, [grid, rows])

	return {
		raws,
		grid,
		isLoading,
		// `hasMore` means the bound database has more rows than one query returns.
		// Because the query cannot filter by block, this sheet's own rows may be
		// among the ones left behind — a cell would look empty when it is not, and
		// writing to it would create a SECOND row for that ref. The caller must
		// stop accepting edits rather than risk that duplicate.
		truncated: hasMore,
		error: queryError?.message,
		failures,
		setCell,
		clearCells,
		setCells,
		retryFailed,
		meta,
		setMeta: setMetaDraft,
	}
}
