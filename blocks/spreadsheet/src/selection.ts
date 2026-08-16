/**
 * What the user currently has selected.
 *
 * A single cell is the common case; whole-row and whole-column selections exist
 * so a row or column can be cleared in one action instead of ten.
 */

import { COLS, COL_LETTERS, ROWS, parseRef, toRef } from "./engine/refs.ts"

export type Selection =
	| { kind: "cell"; ref: string }
	/** A rectangle. `anchor` is where it started; `focus` is the moving corner. */
	| { kind: "range"; anchor: string; focus: string }
	| { kind: "row"; row: number }
	| { kind: "col"; col: number }

/** The rectangle a selection covers, as inclusive zero-indexed bounds. */
export type Bounds = {
	top: number
	left: number
	bottom: number
	right: number
}

export function bounds(selection: Selection): Bounds {
	switch (selection.kind) {
		case "cell": {
			const at = parseRef(selection.ref) ?? { row: 0, col: 0 }
			return { top: at.row, left: at.col, bottom: at.row, right: at.col }
		}
		case "range": {
			const a = parseRef(selection.anchor) ?? { row: 0, col: 0 }
			const b = parseRef(selection.focus) ?? a
			return {
				top: Math.min(a.row, b.row),
				left: Math.min(a.col, b.col),
				bottom: Math.max(a.row, b.row),
				right: Math.max(a.col, b.col),
			}
		}
		case "row":
			return {
				top: selection.row,
				left: 0,
				bottom: selection.row,
				right: COLS - 1,
			}
		case "col":
			return {
				top: 0,
				left: selection.col,
				bottom: ROWS - 1,
				right: selection.col,
			}
	}
}

/** Every cell ref covered by the selection, row-major. */
export function selectedRefs(selection: Selection): string[] {
	const area = bounds(selection)
	const refs: string[] = []
	for (let row = area.top; row <= area.bottom; row++) {
		for (let col = area.left; col <= area.right; col++) {
			refs.push(toRef({ row, col }))
		}
	}
	return refs
}

/** True if `ref` sits inside the selection. */
export function covers(selection: Selection, ref: string): boolean {
	const at = parseRef(ref)
	if (!at) return false
	const area = bounds(selection)
	return (
		at.row >= area.top &&
		at.row <= area.bottom &&
		at.col >= area.left &&
		at.col <= area.right
	)
}

/** How the selection is described in the toolbar, e.g. "row 3" or "A1:B3". */
export function describe(selection: Selection): string {
	switch (selection.kind) {
		case "cell":
			return selection.ref
		case "range": {
			const area = bounds(selection)
			const from = toRef({ row: area.top, col: area.left })
			const to = toRef({ row: area.bottom, col: area.right })
			return from === to ? from : `${from}:${to}`
		}
		case "row":
			return `row ${selection.row + 1}`
		case "col":
			return `column ${COL_LETTERS[selection.col]}`
	}
}

/**
 * The cell that holds keyboard focus. For a range that is the moving corner, so
 * shift-arrow keeps growing from where the user last was.
 */
export function focusedRef(selection: Selection): string | undefined {
	if (selection.kind === "cell") return selection.ref
	if (selection.kind === "range") return selection.focus
	return undefined
}

/** The top-left cell, which is where a copied block is anchored. */
export function topLeftRef(selection: Selection): string {
	const area = bounds(selection)
	return toRef({ row: area.top, col: area.left })
}

/**
 * Grows a selection to `ref`, keeping whatever corner it already started from.
 * A plain cell selection becomes a range anchored where it was.
 */
export function extendTo(selection: Selection, ref: string): Selection {
	if (selection.kind === "range") return { ...selection, focus: ref }
	if (selection.kind === "cell") {
		return { kind: "range", anchor: selection.ref, focus: ref }
	}
	return selection
}
