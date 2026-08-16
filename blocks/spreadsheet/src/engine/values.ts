/**
 * The value model shared by the evaluator and the built-in functions.
 *
 * A cell holds a number, a string, a boolean, or an error. Errors are values
 * rather than exceptions so they propagate the way a spreadsheet expects: any
 * operation touching an error yields that error.
 */

export const ERROR_CODES = [
	"#REF!", // reference outside the grid, or a malformed one
	"#CYCLE!", // the cell participates in a circular reference
	"#DIV/0!", // division by zero
	"#NAME?", // unknown function
	"#VALUE!", // wrong operand type
	"#ERROR!", // the formula did not parse
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type FormulaError = { kind: "error"; code: ErrorCode }

export type CellValue = number | string | boolean | FormulaError

/** An empty cell reads as 0 in numeric context and "" in text context. */
export const EMPTY = ""

export const err = (code: ErrorCode): FormulaError => ({ kind: "error", code })

/**
 * Takes `unknown` rather than `CellValue` so it also narrows the helper return
 * types in this module, which are unions like `number | FormulaError` and
 * `number[] | FormulaError`.
 */
export function isError(value: unknown): value is FormulaError {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as FormulaError).kind === "error"
	)
}

/** The first error among `values`, or undefined if none carry one. */
export function firstError(values: CellValue[]): FormulaError | undefined {
	return values.find(isError) as FormulaError | undefined
}

/**
 * Parses text as a number, accepting a trailing percent sign: "5%" is 0.05.
 * Returns null if the text is not numeric at all.
 *
 * This is the single definition of "looks like a number" — the evaluator uses it
 * to classify literal cells and `toNumber` uses it to coerce, so a cell reading
 * "5%" and a formula reading "5%" can never disagree.
 */
export function parseNumericText(text: string): number | null {
	const trimmed = text.trim()
	if (trimmed === "") return null

	const isPercent = trimmed.endsWith("%")
	const body = isPercent ? trimmed.slice(0, -1).trim() : trimmed
	if (body === "") return null

	const parsed = Number(body)
	if (!Number.isFinite(parsed)) return null
	return isPercent ? parsed / 100 : parsed
}

/** True if `text` is a numeric literal written as a percentage. */
export function isPercentText(text: string): boolean {
	return text.trim().endsWith("%") && parseNumericText(text) !== null
}

/**
 * Coerces to a number for arithmetic. Empty is 0 and booleans are 1/0, matching
 * Excel; a non-numeric string is #VALUE!.
 */
export function toNumber(value: CellValue): number | FormulaError {
	if (isError(value)) return value
	if (typeof value === "number") return value
	if (typeof value === "boolean") return value ? 1 : 0
	if (value.trim() === "") return 0

	const parsed = parseNumericText(value)
	return parsed === null ? err("#VALUE!") : parsed
}

/** Coerces to text for display and CONCAT. Errors render as their code. */
export function toText(value: CellValue): string {
	if (isError(value)) return value.code
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
	if (typeof value === "number") return formatNumber(value)
	return value
}

/** Truthiness for IF. Empty and 0 are false; any non-empty string is true. */
export function toBoolean(value: CellValue): boolean | FormulaError {
	if (isError(value)) return value
	if (typeof value === "boolean") return value
	if (typeof value === "number") return value !== 0
	if (value.trim() === "") return false
	if (value.toUpperCase() === "TRUE") return true
	if (value.toUpperCase() === "FALSE") return false
	return true
}

/**
 * Renders a number without float noise: 0.1 + 0.2 should read as 0.3, not
 * 0.30000000000000004. 12 significant digits is well inside a double's ~15-17
 * and is what most spreadsheets settle on.
 */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "#VALUE!"
	if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
	return String(Number(value.toPrecision(12)))
}
