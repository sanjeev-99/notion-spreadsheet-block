/**
 * Formula translation: rewriting references when a formula is copied elsewhere.
 *
 * Copying `=SUM(A1:A3)` from B1 to C1 should yield `=SUM(B1:B3)` — every
 * reference moves by the same offset as the formula itself. A `$` pins the half
 * it precedes, so `=$A1*2` copied one column right stays `=$A1*2`, while `=A$1`
 * copied one row down stays `=A$1`.
 *
 * The rewrite works on the TOKEN STREAM rather than an AST, splicing only the
 * reference tokens and copying everything between them verbatim. That keeps the
 * author's spacing, capitalisation and redundant parentheses exactly as typed —
 * printing an AST back to text would quietly reformat all three.
 */

import { COLS, ROWS, formatCellRef, parseCellRef } from "./refs.ts"
import { TokenizeError, tokenize } from "./tokenize.ts"

/** What a reference becomes when it is pushed off the edge of the grid. */
const OUT_OF_RANGE = "#REF!"

function shiftRef(text: string, rowDelta: number, colDelta: number): string {
	const ref = parseCellRef(text)
	// Already outside the grid, or not really a reference — leave it alone and
	// let evaluation report it.
	if (!ref) return text

	const row = ref.absRow ? ref.row : ref.row + rowDelta
	const col = ref.absCol ? ref.col : ref.col + colDelta
	if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return OUT_OF_RANGE

	return formatCellRef({ ...ref, row, col })
}

function shiftRange(text: string, rowDelta: number, colDelta: number): string {
	const [start, end] = text.split(":")
	const shiftedStart = shiftRef(start, rowDelta, colDelta)
	const shiftedEnd = shiftRef(end, rowDelta, colDelta)

	// A range with one end off the grid has no meaning, so the whole thing goes.
	if (shiftedStart === OUT_OF_RANGE || shiftedEnd === OUT_OF_RANGE) {
		return OUT_OF_RANGE
	}
	return `${shiftedStart}:${shiftedEnd}`
}

/**
 * Rewrites the references in a formula BODY (no leading "="). Unparseable text
 * is returned untouched — a formula that does not tokenize has no references
 * worth moving, and mangling it would lose what the user typed.
 */
export function translateFormula(
	body: string,
	rowDelta: number,
	colDelta: number
): string {
	if (rowDelta === 0 && colDelta === 0) return body

	let tokens
	try {
		tokens = tokenize(body)
	} catch (error) {
		if (error instanceof TokenizeError) return body
		throw error
	}

	let output = ""
	let cursor = 0

	for (const token of tokens) {
		if (token.type !== "ref" && token.type !== "range") continue

		output += body.slice(cursor, token.start)
		output +=
			token.type === "ref"
				? shiftRef(token.value, rowDelta, colDelta)
				: shiftRange(token.value, rowDelta, colDelta)
		cursor = token.end
	}

	return output + body.slice(cursor)
}

/**
 * Translates a whole cell's raw text. Literals are copied as they are; only
 * formulas have anything to move.
 */
export function translateCell(
	raw: string,
	rowDelta: number,
	colDelta: number
): string {
	const leading = raw.length - raw.trimStart().length
	const trimmed = raw.trimStart()
	if (!trimmed.startsWith("=")) return raw

	const translated = translateFormula(trimmed.slice(1), rowDelta, colDelta)
	return `${raw.slice(0, leading)}=${translated}`
}
