/**
 * Block shell: tabs, formula bar, selection actions, and status.
 *
 * Both tabs render the same in-memory state, so switching is instant and costs
 * no round-trip. Selection lives here rather than in the grid because the
 * formula bar and the error jump both act on it.
 */

import { useMemo, useState } from "react"

import { FormulaBar } from "./FormulaBar.tsx"
import { Grid, type GridMode } from "./Grid.tsx"
import { COLS, ROWS, allRefs, parseRef } from "./engine/refs.ts"
import { isError } from "./engine/values.ts"
import { type Selection, describe, selectedRefs } from "./selection.ts"
import {
	type CellFormat,
	type ColorName,
	TEXT_COLORS,
	pruneHiddenFormats,
	withColWidth,
	withFormat,
	withRowHeight,
	withVisible,
} from "./sheetMeta.ts"
import { useCells } from "./useCells.ts"

export function App() {
	const [mode, setMode] = useState<GridMode>("values")
	const [selection, setSelection] = useState<Selection>({
		kind: "cell",
		ref: "A1",
	})

	const {
		raws,
		grid,
		isLoading,
		truncated,
		error,
		failures,
		setCell,
		clearCells,
		setCells,
		retryFailed,
		meta,
		setMeta,
	} = useCells()

	// A truncated query means rows of this sheet may be missing, so a cell that
	// looks empty might not be. Editing would create a duplicate row for that
	// ref, so the sheet goes read-only until the database is split up.
	const locked = isLoading || truncated

	const failedRefs = Object.keys(failures)
	// Every failure in a burst usually shares one cause, so lead with that
	// message rather than repeating it per cell.
	const failureMessage = failedRefs.length > 0 ? failures[failedRefs[0]] : undefined

	const errorRefs = useMemo(
		() => allRefs().filter((ref) => isError(grid[ref].value)),
		[grid]
	)

	/** Jumps to the next errored cell after the current selection, wrapping. */
	const jumpToNextError = () => {
		if (errorRefs.length === 0) return
		const order = allRefs()
		const current = selection.kind === "cell" ? order.indexOf(selection.ref) : -1
		const next =
			errorRefs.find((ref) => order.indexOf(ref) > current) ?? errorRefs[0]
		setSelection({ kind: "cell", ref: next })
	}

	// Formatting and clearing act on the selection, but never on cells the user
	// has collapsed out of view.
	const targets = useMemo(() => {
		return selectedRefs(selection).filter((ref) => {
			const position = parseRef(ref)
			return (
				position !== null &&
				position.row < meta.visibleRows &&
				position.col < meta.visibleCols
			)
		})
	}, [selection, meta.visibleRows, meta.visibleCols])

	const clearable = selection.kind !== "cell"
	const filledInSelection = targets.filter((ref) => (raws[ref] ?? "") !== "").length

	/** True when every target already carries the attribute, so it should turn off. */
	const allHave = (key: keyof CellFormat) =>
		targets.length > 0 && targets.every((ref) => meta.formats[ref]?.[key])

	const toggle = (key: "b" | "i") =>
		setMeta(withFormat(meta, targets, { [key]: allHave(key) ? undefined : 1 }))

	const applyColor = (key: "c" | "g", color: ColorName | undefined) =>
		setMeta(withFormat(meta, targets, { [key]: color }))

	const clearFormatting = () =>
		setMeta(
			withFormat(meta, targets, {
				b: undefined,
				i: undefined,
				c: undefined,
				g: undefined,
			})
		)

	/**
	 * Collapsing the grid keeps the data in the hidden cells — only formatting is
	 * dropped, since it would otherwise sit in the blob unseen and unremovable.
	 */
	const resize = (rows: number, cols: number) => {
		setMeta(pruneHiddenFormats(withVisible(meta, rows, cols)))
		const position = selection.kind === "cell" ? parseRef(selection.ref) : null
		const outOfView =
			selection.kind === "row"
				? selection.row >= rows
				: selection.kind === "col"
					? selection.col >= cols
					: position !== null && (position.row >= rows || position.col >= cols)
		if (outOfView) setSelection({ kind: "cell", ref: "A1" })
	}

	return (
		<main className="sheet">
			<header className="toolbar">
				<div className="tabs" role="tablist" aria-label="Spreadsheet view">
					<button
						type="button"
						role="tab"
						aria-selected={mode === "values"}
						className={mode === "values" ? "tab is-active" : "tab"}
						onClick={() => setMode("values")}
					>
						Values
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "formulas"}
						className={mode === "formulas" ? "tab is-active" : "tab"}
						onClick={() => setMode("formulas")}
					>
						Formulas
					</button>
				</div>

				<div className="toolbar-actions">
					{clearable && (
						<button
							type="button"
							className="action"
							disabled={locked || filledInSelection === 0}
							onClick={() => clearCells(targets)}
						>
							{filledInSelection === 0
								? `${describe(selection)} is empty`
								: `Clear ${describe(selection)} (${filledInSelection})`}
						</button>
					)}

					{errorRefs.length > 0 && (
						<button
							type="button"
							className="action is-error-chip"
							onClick={jumpToNextError}
							title="Jump to the next cell in error"
						>
							{errorRefs.length} {errorRefs.length === 1 ? "error" : "errors"}
						</button>
					)}

					<span className="status" role="status">
						{isLoading ? (
							"Loading…"
						) : error ? (
							<span className="status-error">{error}</span>
						) : null}
					</span>
				</div>
			</header>

			<div className="format-bar">
				<div className="format-group" aria-label="Text style">
					<button
						type="button"
						className={allHave("b") ? "fmt is-on" : "fmt"}
						disabled={locked}
						aria-pressed={allHave("b")}
						title="Bold"
						onClick={() => toggle("b")}
					>
						<strong>B</strong>
					</button>
					<button
						type="button"
						className={allHave("i") ? "fmt is-on" : "fmt"}
						disabled={locked}
						aria-pressed={allHave("i")}
						title="Italic"
						onClick={() => toggle("i")}
					>
						<em>I</em>
					</button>
				</div>

				<div className="format-group" aria-label="Text colour">
					<span className="format-label">Text</span>
					<button
						type="button"
						className="swatch is-default"
						disabled={locked}
						title="Default text colour"
						onClick={() => applyColor("c", undefined)}
					/>
					{TEXT_COLORS.map((color) => (
						<button
							key={color}
							type="button"
							className={`swatch text-${color}`}
							disabled={locked}
							title={`${color} text`}
							onClick={() => applyColor("c", color)}
						/>
					))}
				</div>

				<div className="format-group" aria-label="Cell colour">
					<span className="format-label">Fill</span>
					<button
						type="button"
						className="swatch is-default"
						disabled={locked}
						title="No fill"
						onClick={() => applyColor("g", undefined)}
					/>
					{TEXT_COLORS.map((color) => (
						<button
							key={color}
							type="button"
							className={`swatch fill-${color}`}
							disabled={locked}
							title={`${color} fill`}
							onClick={() => applyColor("g", color)}
						/>
					))}
				</div>

				<button
					type="button"
					className="fmt"
					disabled={locked}
					title="Remove formatting from the selection"
					onClick={clearFormatting}
				>
					Clear
				</button>

				<div className="format-group format-size" aria-label="Visible grid size">
					<span className="format-label">Size</span>
					<select
						aria-label="Visible rows"
						value={meta.visibleRows}
						disabled={locked}
						onChange={(event) =>
							resize(Number(event.target.value), meta.visibleCols)
						}
					>
						{Array.from({ length: ROWS }, (_, i) => (
							<option key={i} value={i + 1}>
								{i + 1}
							</option>
						))}
					</select>
					<span className="format-label">&times;</span>
					<select
						aria-label="Visible columns"
						value={meta.visibleCols}
						disabled={locked}
						onChange={(event) =>
							resize(meta.visibleRows, Number(event.target.value))
						}
					>
						{Array.from({ length: COLS }, (_, i) => (
							<option key={i} value={i + 1}>
								{i + 1}
							</option>
						))}
					</select>
				</div>
			</div>

			{truncated && (
				<div className="banner" role="alert">
					<div className="banner-text">
						<strong>Editing is locked — this database is too large</strong>
						<span>
							It holds more rows than one query returns, so some of this
							sheet&rsquo;s cells may not have loaded and could look empty when
							they are not. Editing now would create duplicate rows. Move this
							sheet to its own database, or delete rows belonging to sheets you
							no longer use.
						</span>
					</div>
				</div>
			)}

			{failedRefs.length > 0 && (
				<div className="banner" role="alert">
					<div className="banner-text">
						<strong>
							{failedRefs.length === 1
								? `${failedRefs[0]} could not be saved`
								: `${failedRefs.length} cells could not be saved`}
						</strong>
						<span>
							{failureMessage}. Your text is still here and is not lost —
							{failedRefs.length > 1 ? ` ${failedRefs.join(", ")}. ` : " "}
							retry, or copy it somewhere safe before reloading.
						</span>
					</div>
					<button type="button" className="action" onClick={retryFailed}>
						Retry
					</button>
				</div>
			)}

			<FormulaBar
				selection={selection}
				raws={raws}
				readOnly={locked}
				onCommit={setCell}
			/>

			<Grid
				mode={mode}
				raws={raws}
				grid={grid}
				readOnly={locked}
				selection={selection}
				onSelect={setSelection}
				onCommit={setCell}
				failures={failures}
				meta={meta}
				onResizeCol={(col, width) => setMeta(withColWidth(meta, col, width))}
				onResizeRow={(row, height) => setMeta(withRowHeight(meta, row, height))}
				onPasteCells={setCells}
				onClearCells={clearCells}
			/>

			<footer className="hint">
				Type to replace a cell, F2 or double-click to amend it, or edit the
				formula bar. Start with <code>=</code> for a formula: SUM, AVERAGE, MIN,
				MAX, COUNT, IF, ROUND, ABS, CONCAT. Percentages work as values and in
				formulas &mdash; <code>5%</code> is 0.05. Click a row or column header to
				select and clear it. Drag, or shift-click, to select a block. Copy, cut
				and paste work across the selection;
				pasted formulas shift with the offset, and a <code>$</code> pins a row
				or column &mdash; <code>=B2*$C$1</code> copied down becomes
				<code>=B3*$C$1</code>.
			</footer>
		</main>
	)
}
