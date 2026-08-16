/**
 * Cell references and the grid's fixed dimensions.
 *
 * The grid is 10x10: columns A-J, rows 1-10. Everything outside that is #REF!.
 */

export const COLS = 10
export const ROWS = 10

/** Column letters, "A" through "J". */
export const COL_LETTERS = Array.from({ length: COLS }, (_, i) =>
	String.fromCharCode(65 + i)
)

/** A zero-indexed grid position. */
export type CellPos = { row: number; col: number }

/**
 * A position plus whether each half was written with a `$`. The dollars have no
 * effect on what a formula computes — they only decide which halves move when a
 * formula is copied somewhere else.
 */
export type CellRef = CellPos & { absRow: boolean; absCol: boolean }

/** Accepts `A1`, `$A1`, `A$1`, `$A$1`. */
const REF_PATTERN = /^(\$?)([A-Za-z])(\$?)([0-9]{1,2})$/

/** Shape test only — does not check that the ref is inside the grid. */
export function looksLikeRef(text: string): boolean {
	return REF_PATTERN.test(text)
}

/** `{row: 0, col: 0}` -> `"A1"`. */
export function toRef({ row, col }: CellPos): string {
	return `${COL_LETTERS[col]}${row + 1}`
}

/** `{row: 0, col: 0, absCol: true}` -> `"$A1"`. */
export function formatCellRef(ref: CellRef): string {
	const col = `${ref.absCol ? "$" : ""}${COL_LETTERS[ref.col]}`
	const row = `${ref.absRow ? "$" : ""}${ref.row + 1}`
	return `${col}${row}`
}

/**
 * `"$A1"` -> `{row: 0, col: 0, absRow: false, absCol: true}`. Returns null for
 * anything malformed or outside the 10x10 grid, which callers surface as #REF!.
 */
export function parseCellRef(ref: string): CellRef | null {
	const match = REF_PATTERN.exec(ref.trim())
	if (!match) return null

	const col = match[2].toUpperCase().charCodeAt(0) - 65
	const row = Number(match[4]) - 1
	if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null

	return { row, col, absCol: match[1] === "$", absRow: match[3] === "$" }
}

/** As `parseCellRef`, for callers that only care where the cell is. */
export function parseRef(ref: string): CellPos | null {
	const parsed = parseCellRef(ref)
	return parsed && { row: parsed.row, col: parsed.col }
}

/** Drops the `$` markers, leaving a plain uppercase reference. */
export function stripAbsolute(ref: string): string {
	return ref.replace(/\$/g, "").toUpperCase()
}

/**
 * Expands `"A1"`/`"B3"` into every ref in the rectangle they bound, in
 * row-major order. Corners may be given in any order — `B3:A1` is the same
 * range as `A1:B3`. Returns null if either corner is out of bounds.
 */
export function expandRange(startRef: string, endRef: string): string[] | null {
	const start = parseRef(startRef)
	const end = parseRef(endRef)
	if (!start || !end) return null

	const refs: string[] = []
	for (let row = Math.min(start.row, end.row); row <= Math.max(start.row, end.row); row++) {
		for (let col = Math.min(start.col, end.col); col <= Math.max(start.col, end.col); col++) {
			refs.push(toRef({ row, col }))
		}
	}
	return refs
}

/** Every ref in the grid, row-major: A1, B1, ... J1, A2, ... J10. */
export function allRefs(): string[] {
	const refs: string[] = []
	for (let row = 0; row < ROWS; row++) {
		for (let col = 0; col < COLS; col++) refs.push(toRef({ row, col }))
	}
	return refs
}
