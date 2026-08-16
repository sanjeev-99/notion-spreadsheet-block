/**
 * Built-in functions.
 *
 * Arguments arrive already flattened: a range argument has been expanded into
 * its cells, so SUM(A1:A3) and SUM(A1, A2, A3) are indistinguishable here. The
 * aggregates follow Excel and skip non-numeric text rather than erroring on it,
 * so a range that includes a header label still sums.
 *
 * IF is the exception to flattening — it needs its branches unevaluated, so the
 * evaluator special-cases it before reaching this table.
 */

import {
	type CellValue,
	type FormulaError,
	err,
	firstError,
	isError,
	toNumber,
	toText,
} from "./values.ts"

/** The numbers in `args`, skipping blanks and non-numeric text. */
function numericArgs(args: CellValue[]): number[] | FormulaError {
	const error = firstError(args)
	if (error) return error

	const numbers: number[] = []
	for (const arg of args) {
		if (typeof arg === "number") {
			numbers.push(arg)
			continue
		}
		if (typeof arg === "boolean") {
			numbers.push(arg ? 1 : 0)
			continue
		}
		// Blank and non-numeric text are skipped, not an error.
		if (typeof arg === "string" && arg.trim() !== "") {
			const parsed = Number(arg)
			if (Number.isFinite(parsed)) numbers.push(parsed)
		}
	}
	return numbers
}

/** Requires exactly `count` args and coerces each to a number. */
function scalarArgs(
	args: CellValue[],
	count: number
): number[] | FormulaError {
	if (args.length !== count) return err("#VALUE!")

	const numbers: number[] = []
	for (const arg of args) {
		const num = toNumber(arg)
		if (isError(num)) return num
		numbers.push(num)
	}
	return numbers
}

export type FunctionImpl = (args: CellValue[]) => CellValue

export const FUNCTIONS: Record<string, FunctionImpl> = {
	SUM: (args) => {
		const numbers = numericArgs(args)
		if (isError(numbers)) return numbers
		return numbers.reduce((total, n) => total + n, 0)
	},

	AVERAGE: (args) => {
		const numbers = numericArgs(args)
		if (isError(numbers)) return numbers
		if (numbers.length === 0) return err("#DIV/0!")
		return numbers.reduce((total, n) => total + n, 0) / numbers.length
	},

	MIN: (args) => {
		const numbers = numericArgs(args)
		if (isError(numbers)) return numbers
		return numbers.length === 0 ? 0 : Math.min(...numbers)
	},

	MAX: (args) => {
		const numbers = numericArgs(args)
		if (isError(numbers)) return numbers
		return numbers.length === 0 ? 0 : Math.max(...numbers)
	},

	/** Counts numeric cells only, like Excel's COUNT (not COUNTA). */
	COUNT: (args) => {
		const numbers = numericArgs(args)
		if (isError(numbers)) return numbers
		return numbers.length
	},

	ROUND: (args) => {
		const nums = scalarArgs(args.length === 1 ? [...args, 0] : args, 2)
		if (isError(nums)) return nums
		const [value, digits] = nums
		const factor = 10 ** Math.trunc(digits)
		return Math.round(value * factor) / factor
	},

	ABS: (args) => {
		const nums = scalarArgs(args, 1)
		if (isError(nums)) return nums
		return Math.abs(nums[0])
	},

	CONCAT: (args) => {
		const error = firstError(args)
		if (error) return error
		return args.map(toText).join("")
	},
}
