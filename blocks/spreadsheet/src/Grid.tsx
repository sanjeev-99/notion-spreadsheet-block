/**
 * The 10x10 grid.
 *
 * Editing follows Excel rather than a plain form: selecting a cell does not
 * make it editable. A selected cell keeps showing its computed result, and you
 * enter edit mode explicitly — double-click, F2, or just start typing. Entering
 * edit mode ALWAYS loads the cell's raw text, so a formula can never be
 * silently replaced by the number it happened to display.
 *
 * Typing a character to begin editing replaces the cell's contents, again like
 * Excel. Use F2 or the formula bar to amend rather than replace.
 */

import { useEffect, useRef, useState } from "react"

import { type CellBlock, fromTsv, toTsv } from "./clipboard.ts"
import type { EvaluatedGrid, RawGrid } from "./engine/evaluate.ts"
import { COL_LETTERS, parseRef, toRef } from "./engine/refs.ts"
import { translateCell } from "./engine/translate.ts"
import { isError } from "./engine/values.ts"
import {
	type Selection,
	bounds,
	covers,
	extendTo,
	focusedRef,
	selectedRefs,
	topLeftRef,
} from "./selection.ts"
import {
	DEFAULT_COL_WIDTH,
	DEFAULT_ROW_HEIGHT,
	type SheetMeta,
	colWidth,
	formatFor,
	rowHeight,
} from "./sheetMeta.ts"

export type GridMode = "values" | "formulas"

type GridProps = {
	mode: GridMode
	raws: RawGrid
	grid: EvaluatedGrid
	readOnly: boolean
	selection: Selection
	onSelect: (selection: Selection) => void
	onCommit: (ref: string, raw: string) => void
	/** Cells whose write was rejected, keyed by ref. */
	failures: Record<string, string>
	/** Sizes, visible extent, and per-cell formatting. */
	meta: SheetMeta
	/** Live during a drag; the caller debounces the write. */
	onResizeCol: (col: number, width: number) => void
	onResizeRow: (row: number, height: number) => void
	/** Applies a pasted block. One write per cell — there is no batch API. */
	onPasteCells: (entries: Array<{ ref: string; raw: string }>) => void
	/** Clears cells, used by cut. */
	onClearCells: (refs: string[]) => void
}

type Editing = { ref: string; text: string }

export function Grid({
	mode,
	raws,
	grid,
	readOnly,
	selection,
	onSelect,
	onCommit,
	failures,
	meta,
	onResizeCol,
	onResizeRow,
	onPasteCells,
	onClearCells,
}: GridProps) {
	const [editing, setEditing] = useState<Editing | null>(null)
	const containerRef = useRef<HTMLDivElement>(null)

	/**
	 * Where the last copy came from, so a paste can work out how far the formulas
	 * moved. Cleared when the clipboard content did not come from this grid —
	 * text pasted from elsewhere has no origin and is taken literally.
	 */
	const copyOrigin = useRef<{ ref: string; tsv: string } | null>(null)

	/**
	 * The cell a drag-select started from, or null when no drag is in progress.
	 * Held in a ref so that pointer moves never wait on a re-render.
	 */
	const dragAnchor = useRef<string | null>(null)

	// The drag ends wherever the button is released, including outside the grid
	// or outside the iframe, so this listens on the window rather than on a cell.
	useEffect(() => {
		const endDrag = () => {
			dragAnchor.current = null
		}
		window.addEventListener("pointerup", endDrag)
		window.addEventListener("pointercancel", endDrag)
		return () => {
			window.removeEventListener("pointerup", endDrag)
			window.removeEventListener("pointercancel", endDrag)
		}
	}, [])

	const focused = focusedRef(selection)

	// Only the visible extent is rendered. Hidden cells keep their data and are
	// still evaluated, so a formula may legitimately reference one.
	const rowCount = meta.visibleRows
	const colCount = meta.visibleCols

	/**
	 * Drags a row or column edge. Pointer capture keeps the moves coming to the
	 * handle even when the cursor outruns it, which is what makes a fast drag
	 * feel attached rather than sticky.
	 */
	const startResize = (
		event: React.PointerEvent<HTMLSpanElement>,
		axis: "col" | "row",
		index: number
	) => {
		event.preventDefault()
		event.stopPropagation()

		const handle = event.currentTarget
		const startPos = axis === "col" ? event.clientX : event.clientY
		const startSize =
			axis === "col" ? colWidth(meta, index) : rowHeight(meta, index)

		handle.setPointerCapture(event.pointerId)

		const onMove = (move: PointerEvent) => {
			const delta = (axis === "col" ? move.clientX : move.clientY) - startPos
			if (axis === "col") onResizeCol(index, startSize + delta)
			else onResizeRow(index, startSize + delta)
		}

		const onUp = () => {
			handle.releasePointerCapture(event.pointerId)
			handle.removeEventListener("pointermove", onMove)
			handle.removeEventListener("pointerup", onUp)
			handle.removeEventListener("pointercancel", onUp)
		}

		handle.addEventListener("pointermove", onMove)
		handle.addEventListener("pointerup", onUp)
		handle.addEventListener("pointercancel", onUp)
	}

	const resetSize = (axis: "col" | "row", index: number) => {
		if (axis === "col") onResizeCol(index, DEFAULT_COL_WIDTH)
		else onResizeRow(index, DEFAULT_ROW_HEIGHT)
	}

	// ── Clipboard ─────────────────────────────────────────────
	//
	// These use the copy/cut/paste DOM events rather than navigator.clipboard.
	// The block runs in a sandboxed cross-origin iframe, where the async
	// Clipboard API needs a permission the host may not have granted; the events
	// carry their own clipboardData and need no permission at all.
	//
	// While a cell is being edited the handlers stand aside, so copying part of a
	// formula behaves normally.

	/** The selection as a rectangle of raw text, clipped to what is visible. */
	const selectionBlock = (): { block: CellBlock; origin: string } => {
		const area = bounds(selection)
		const bottom = Math.min(area.bottom, rowCount - 1)
		const right = Math.min(area.right, colCount - 1)

		const block: CellBlock = []
		for (let row = area.top; row <= bottom; row++) {
			const line: string[] = []
			for (let col = area.left; col <= right; col++) {
				line.push(raws[toRef({ row, col })] ?? "")
			}
			block.push(line)
		}
		return { block, origin: toRef({ row: area.top, col: area.left }) }
	}

	const handleCopy = (event: React.ClipboardEvent) => {
		if (editing) return
		event.preventDefault()

		const { block, origin } = selectionBlock()
		const tsv = toTsv(block)
		event.clipboardData.setData("text/plain", tsv)
		copyOrigin.current = { ref: origin, tsv }
	}

	const handleCut = (event: React.ClipboardEvent) => {
		if (editing || readOnly) return
		handleCopy(event)
		onClearCells(selectedRefs(selection).filter((ref) => (raws[ref] ?? "") !== ""))
	}

	const handlePaste = (event: React.ClipboardEvent) => {
		if (editing || readOnly) return
		event.preventDefault()

		const text = event.clipboardData.getData("text/plain")
		const block = fromTsv(text)
		if (block.length === 0) return

		const target = parseRef(topLeftRef(selection))
		if (!target) return

		// Only translate when this text is what we last copied. Anything pasted
		// from another app has no origin to measure an offset from, so its
		// formulas are taken exactly as written.
		const sameContent = copyOrigin.current?.tsv === text
		const source = sameContent ? parseRef(copyOrigin.current!.ref) : null
		const rowDelta = source ? target.row - source.row : 0
		const colDelta = source ? target.col - source.col : 0

		const entries: Array<{ ref: string; raw: string }> = []
		block.forEach((line, rowOffset) => {
			line.forEach((raw, colOffset) => {
				const row = target.row + rowOffset
				const col = target.col + colOffset
				// Silently clip at the visible edge rather than wrapping or erroring.
				if (row >= rowCount || col >= colCount) return
				entries.push({
					ref: toRef({ row, col }),
					raw: source ? translateCell(raw, rowDelta, colDelta) : raw,
				})
			})
		})

		if (entries.length > 0) onPasteCells(entries)
	}

	const inputFor = (ref: string) =>
		containerRef.current?.querySelector<HTMLInputElement>(
			`input[data-ref="${ref}"]`
		)

	// Keep DOM focus on the selected cell so keyboard navigation survives a
	// commit moving the selection, or a jump driven from the toolbar.
	useEffect(() => {
		if (!focused || editing) return
		const input = inputFor(focused)
		// preventScroll: during a drag the focused corner changes on every cell
		// entered, and letting the browser scroll each one into view makes the
		// grid jitter under the pointer.
		if (input && document.activeElement !== input) {
			input.focus({ preventScroll: true })
		}
	}, [focused, editing])

	// Put the caret at the end whenever edit mode opens, so F2 and double-click
	// append rather than leaving the caret wherever the click landed.
	useEffect(() => {
		if (!editing) return
		const input = inputFor(editing.ref)
		if (!input) return
		const end = input.value.length
		input.setSelectionRange(end, end)
	}, [editing?.ref])

	const beginEdit = (ref: string, text: string) => {
		if (readOnly) return
		setEditing({ ref, text })
	}

	const commit = (ref: string, text: string) => {
		setEditing(null)
		onCommit(ref, text)
	}

	// Navigation stops at the visible edge rather than the grid's, so a sheet
	// collapsed to 4x7 behaves as if it really were 4x7.
	const move = (
		ref: string,
		rowDelta: number,
		colDelta: number,
		extend = false
	) => {
		const row = Number(ref.slice(1)) - 1 + rowDelta
		const col = ref.charCodeAt(0) - 65 + colDelta
		if (row < 0 || row >= rowCount || col < 0 || col >= colCount) return

		const next = toRef({ row, col })
		onSelect(extend ? extendTo(selection, next) : { kind: "cell", ref: next })
	}

	const handleKeyDown = (
		event: React.KeyboardEvent<HTMLInputElement>,
		ref: string
	) => {
		const active = editing?.ref === ref ? editing : null

		switch (event.key) {
			case "Enter":
				event.preventDefault()
				if (active) commit(ref, active.text)
				else if (!readOnly) {
					// Enter on a selected-but-not-editing cell opens it, matching F2.
					beginEdit(ref, raws[ref] ?? "")
					return
				}
				move(ref, 1, 0)
				return

			case "F2":
				event.preventDefault()
				if (!active) beginEdit(ref, raws[ref] ?? "")
				return

			case "Tab":
				if (active) commit(ref, active.text)
				move(ref, 0, event.shiftKey ? -1 : 1)
				event.preventDefault()
				return

			case "Escape":
				event.preventDefault()
				setEditing(null)
				return

			// Arrows navigate only when not mid-edit, so they still move the caret
			// inside a formula being typed.
			case "ArrowUp":
			case "ArrowDown":
			case "ArrowLeft":
			case "ArrowRight": {
				if (active) return
				event.preventDefault()
				const deltas: Record<string, [number, number]> = {
					ArrowUp: [-1, 0],
					ArrowDown: [1, 0],
					ArrowLeft: [0, -1],
					ArrowRight: [0, 1],
				}
				const [rowDelta, colDelta] = deltas[event.key]
				// Shift grows the selection instead of moving it, as in any sheet.
				move(ref, rowDelta, colDelta, event.shiftKey)
				return
			}

			case "Delete":
			case "Backspace": {
				if (active) return
				event.preventDefault()
				if (readOnly) return
				// Clears the whole selection, not just the focused cell.
				const filled = selectedRefs(selection).filter(
					(target) => (raws[target] ?? "") !== ""
				)
				if (filled.length > 1) onClearCells(filled)
				else commit(ref, "")
				return
			}

			default: {
				if (active || readOnly) return
				// A printable character opens edit mode and replaces the contents.
				// Modifier combinations are left alone so the host's own shortcuts,
				// and the alpha's backslash message log, still work.
				const printable =
					event.key.length === 1 &&
					!event.metaKey &&
					!event.ctrlKey &&
					!event.altKey
				if (!printable) return
				event.preventDefault()
				beginEdit(ref, event.key)
			}
		}
	}

	return (
		<div
			className="grid-scroll"
			ref={containerRef}
			onCopy={handleCopy}
			onCut={handleCut}
			onPaste={handlePaste}
		>
			<table className="grid">
				<colgroup>
					<col className="head-col" />
					{Array.from({ length: colCount }, (_, col) => (
						<col key={col} style={{ width: `${colWidth(meta, col)}px` }} />
					))}
				</colgroup>
				<thead>
					<tr>
						<th className="corner" aria-hidden="true" />
						{COL_LETTERS.slice(0, colCount).map((letter, col) => (
							<th key={letter} scope="col" className="col-head">
								<button
									type="button"
									className={
										selection.kind === "col" && selection.col === col
											? "head-button is-active"
											: "head-button"
									}
									onClick={() => onSelect({ kind: "col", col })}
									title={`Select column ${letter}`}
								>
									{letter}
								</button>
								<span
									className="resize-handle is-col"
									role="separator"
									aria-label={`Resize column ${letter}`}
									title="Drag to resize, double-click to reset"
									onPointerDown={(event) => startResize(event, "col", col)}
									onDoubleClick={() => resetSize("col", col)}
								/>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{Array.from({ length: rowCount }, (_, row) => (
						<tr key={row} style={{ height: `${rowHeight(meta, row)}px` }}>
							<th scope="row" className="row-head">
								<button
									type="button"
									className={
										selection.kind === "row" && selection.row === row
											? "head-button is-active"
											: "head-button"
									}
									onClick={() => onSelect({ kind: "row", row })}
									title={`Select row ${row + 1}`}
								>
									{row + 1}
								</button>
								<span
									className="resize-handle is-row"
									role="separator"
									aria-label={`Resize row ${row + 1}`}
									title="Drag to resize, double-click to reset"
									onPointerDown={(event) => startResize(event, "row", row)}
									onDoubleClick={() => resetSize("row", row)}
								/>
							</th>
							{Array.from({ length: colCount }, (_, col) => {
								const ref = toRef({ row, col })
								const cell = grid[ref]
								const raw = raws[ref] ?? ""
								const active = editing?.ref === ref ? editing : null

								// While editing, show what is being typed. Otherwise the
								// Formulas tab shows raw text and the Values tab shows the
								// computed result.
								const shown = active
									? active.text
									: mode === "formulas"
										? raw
										: cell.display

								const numeric = typeof cell.value === "number"
								const errored = isError(cell.value)
								const format = formatFor(meta, ref)

								return (
									<td key={ref}>
										<input
											data-ref={ref}
											className={[
												"cell",
												covers(selection, ref) ? "is-selected" : "",
												focused === ref ? "is-focused" : "",
												active ? "is-editing" : "",
												ref in failures ? "is-unsaved" : "",
												format?.b ? "is-bold" : "",
												format?.i ? "is-italic" : "",
												format?.c ? `text-${format.c}` : "",
												format?.g ? `fill-${format.g}` : "",
												!active && mode === "values" && numeric
													? "is-numeric"
													: "",
												!active && mode === "values" && errored
													? "is-error"
													: "",
												!active && mode === "formulas" && raw.startsWith("=")
													? "is-formula"
													: "",
											]
												.filter(Boolean)
												.join(" ")}
											value={shown}
											title={failures[ref]}
											// Only an actively edited cell accepts input. This is what
											// makes "type to replace" possible and stops a displayed
											// value from being edited as if it were the formula.
											readOnly={!active}
											aria-label={ref}
											spellCheck={false}
											autoComplete="off"
											onPointerDown={(event) => {
												if (active || event.button !== 0) return

												if (event.shiftKey) {
													// Swallowed so the browser does not also move focus,
													// which would scroll the grid mid-gesture.
													event.preventDefault()
													onSelect(extendTo(selection, ref))
													inputFor(ref)?.focus({ preventScroll: true })
													return
												}

												// Plain press starts a drag. Focus is left to the
												// browser here so a click still behaves like a click.
												dragAnchor.current = ref
												onSelect({ kind: "cell", ref })
											}}
											onPointerEnter={() => {
												const anchor = dragAnchor.current
												if (anchor === null || anchor === ref) return
												// Built from the remembered anchor rather than from
												// `selection`, so a fast drag cannot act on a stale
												// render's selection.
												onSelect({ kind: "range", anchor, focus: ref })
											}}
											onFocus={() => {
												// Only claim the selection when focus arrives at a cell
												// outside it — by Tab, say. Without the `covers` guard
												// this fires for the focused corner of a range and
												// collapses the range as soon as it is made.
												if (!covers(selection, ref)) {
													onSelect({ kind: "cell", ref })
												}
											}}
											onDoubleClick={() => beginEdit(ref, raw)}
											onChange={(event) => {
												if (!active) return
												setEditing({ ref, text: event.target.value })
											}}
											onBlur={() => {
												if (active) commit(ref, active.text)
											}}
											onKeyDown={(event) => handleKeyDown(event, ref)}
										/>
									</td>
								)
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
