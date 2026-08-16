/**
 * Grid evaluation.
 *
 * `evaluateGrid` takes the raw text of every cell and returns each cell's
 * computed value plus its display string. It is pure and cheap enough at 10x10
 * to re-run on every keystroke, so there is no incremental recalculation.
 *
 * Evaluation is a memoized depth-first walk of the dependency graph rather than
 * an explicit topological sort: a cell is computed the first time something
 * asks for it. Re-entering a cell that is already being computed is exactly the
 * definition of a circular reference, which is what makes #CYCLE! detection
 * fall out of the walk for free.
 */

import { FUNCTIONS } from "./functions.ts"
import { type Node, ParseError, parse } from "./parse.ts"
import { allRefs, expandRange, parseRef } from "./refs.ts"
import { TokenizeError } from "./tokenize.ts"
import {
	type CellValue,
	EMPTY,
	err,
	firstError,
	isError,
	isPercentText,
	parseNumericText,
	toBoolean,
	toNumber,
	toText,
} from "./values.ts"

/** Raw text keyed by cell ref. Missing or blank entries are empty cells. */
export type RawGrid = Record<string, string | undefined>

export type EvaluatedCell = {
	/** The computed value, for downstream arithmetic. */
	value: CellValue
	/** What the Values tab renders. */
	display: string
}

export type EvaluatedGrid = Record<string, EvaluatedCell>

/** How a cell's raw text is interpreted. Inferred, never stored. */
export type CellKind = "empty" | "number" | "text" | "formula"

export function classify(raw: string | undefined): CellKind {
	if (raw === undefined || raw.trim() === "") return "empty"
	if (raw.trimStart().startsWith("=")) return "formula"
	return isNumericLiteral(raw) ? "number" : "text"
}

function isNumericLiteral(raw: string): boolean {
	return parseNumericText(raw) !== null
}

/** Strips the leading "=" from a formula cell. */
function formulaBody(raw: string): string {
	return raw.trimStart().slice(1)
}

export function evaluateGrid(raws: RawGrid): EvaluatedGrid {
	// Parse every formula up front so a syntax error is reported on the cell that
	// owns it, and so the walk below never re-parses a shared dependency.
	const asts = new Map<string, Node | "parse-error">()
	for (const ref of allRefs()) {
		const raw = raws[ref]
		if (classify(raw) !== "formula") continue
		try {
			asts.set(ref, parse(formulaBody(raw as string)))
		} catch (error) {
			if (error instanceof ParseError || error instanceof TokenizeError) {
				asts.set(ref, "parse-error")
			} else {
				throw error
			}
		}
	}

	const computed = new Map<string, CellValue>()
	const inProgress = new Set<string>()

	/** Value of a cell, computing it on first request. */
	const valueOf = (ref: string): CellValue => {
		const memo = computed.get(ref)
		if (memo !== undefined) return memo

		// Re-entering a cell mid-computation means we followed a chain of
		// references back to where we started. Return the error to the caller
		// WITHOUT memoizing it against `ref` — `ref`'s own computation is still
		// unwinding and will store its real result in a moment.
		if (inProgress.has(ref)) return err("#CYCLE!")

		const raw = raws[ref]
		const kind = classify(raw)

		let result: CellValue
		if (kind === "empty") {
			result = EMPTY
		} else if (kind === "number") {
			// Non-null because `classify` returned "number".
			result = parseNumericText(raw as string) as number
		} else if (kind === "text") {
			result = raw as string
		} else {
			const ast = asts.get(ref)
			if (ast === undefined || ast === "parse-error") {
				result = err("#ERROR!")
			} else {
				inProgress.add(ref)
				try {
					result = evaluateNode(ast, valueOf)
				} finally {
					inProgress.delete(ref)
				}
			}
		}

		computed.set(ref, result)
		return result
	}

	const grid: EvaluatedGrid = {}
	for (const ref of allRefs()) {
		const value = valueOf(ref)
		const raw = raws[ref]

		// A cell typed as "5%" holds 0.05 but must still READ as "5%" — there is
		// nowhere to store a number format, so the literal's own text is the
		// format. Only literals get this: a formula returning 0.05 shows 0.05,
		// because nothing said it was a percentage.
		const display =
			raw !== undefined && classify(raw) === "number" && isPercentText(raw)
				? raw.trim()
				: toText(value)

		grid[ref] = { value, display }
	}
	return grid
}

/**
 * Evaluates one AST node. `lookup` resolves a cell ref, recursing back into the
 * memoized walk above.
 */
function evaluateNode(node: Node, lookup: (ref: string) => CellValue): CellValue {
	switch (node.kind) {
		case "number":
		case "string":
		case "boolean":
			return node.value

		// An error the author (or a paste) wrote into the formula text.
		case "error":
			return err(node.code)

		// The tokenizer accepts any letter+digits shape, so bounds are checked
		// here: K1 and A99 are well-formed refs that fall outside the 10x10 grid.
		case "ref":
			return parseRef(node.ref) ? lookup(node.ref) : err("#REF!")

		// A bare range outside a function call has no scalar meaning.
		case "range":
			return err("#VALUE!")

		case "unary": {
			const operand = evaluateNode(node.operand, lookup)
			const num = toNumber(operand)
			if (isError(num)) return num
			return node.op === "-" ? -num : num
		}

		case "percent": {
			const operand = evaluateNode(node.operand, lookup)
			const num = toNumber(operand)
			if (isError(num)) return num
			return num / 100
		}

		case "binary":
			return evaluateBinary(node.op, node.left, node.right, lookup)

		case "call":
			return evaluateCall(node, lookup)
	}
}

function evaluateBinary(
	op: string,
	leftNode: Node,
	rightNode: Node,
	lookup: (ref: string) => CellValue
): CellValue {
	const left = evaluateNode(leftNode, lookup)
	const right = evaluateNode(rightNode, lookup)

	const error = firstError([left, right])
	if (error) return error

	if (op === "=" || op === "<>") {
		const equal = compareLoose(left, right)
		return op === "=" ? equal : !equal
	}

	if (op === "<" || op === "<=" || op === ">" || op === ">=") {
		// Text compares to text lexicographically; anything else compares
		// numerically, matching how the aggregates coerce.
		if (typeof left === "string" && typeof right === "string" && left !== EMPTY && right !== EMPTY) {
			const order = left.localeCompare(right)
			return applyOrder(op, order)
		}
		const leftNum = toNumber(left)
		if (isError(leftNum)) return leftNum
		const rightNum = toNumber(right)
		if (isError(rightNum)) return rightNum
		return applyOrder(op, leftNum - rightNum)
	}

	const leftNum = toNumber(left)
	if (isError(leftNum)) return leftNum
	const rightNum = toNumber(right)
	if (isError(rightNum)) return rightNum

	switch (op) {
		case "+":
			return leftNum + rightNum
		case "-":
			return leftNum - rightNum
		case "*":
			return leftNum * rightNum
		case "/":
			return rightNum === 0 ? err("#DIV/0!") : leftNum / rightNum
		case "^": {
			const power = leftNum ** rightNum
			return Number.isFinite(power) ? power : err("#VALUE!")
		}
		default:
			return err("#ERROR!")
	}
}

function applyOrder(op: string, order: number): boolean {
	switch (op) {
		case "<":
			return order < 0
		case "<=":
			return order <= 0
		case ">":
			return order > 0
		default:
			return order >= 0
	}
}

/** Equality that treats 1 and "1" as equal and is case-insensitive on text. */
function compareLoose(left: CellValue, right: CellValue): boolean {
	if (typeof left === "string" && typeof right === "string") {
		return left.toLowerCase() === right.toLowerCase()
	}
	const leftNum = toNumber(left)
	const rightNum = toNumber(right)
	if (isError(leftNum) || isError(rightNum)) return toText(left) === toText(right)
	return leftNum === rightNum
}

function evaluateCall(
	node: Extract<Node, { kind: "call" }>,
	lookup: (ref: string) => CellValue
): CellValue {
	// IF is lazy: only the taken branch is evaluated, so
	// =IF(B1=0, "n/a", A1/B1) does not produce a #DIV/0!.
	if (node.name === "IF") {
		if (node.args.length < 2 || node.args.length > 3) return err("#VALUE!")
		const condition = toBoolean(evaluateNode(node.args[0], lookup))
		if (isError(condition)) return condition
		if (condition) return evaluateNode(node.args[1], lookup)
		return node.args[2] ? evaluateNode(node.args[2], lookup) : false
	}

	const impl = FUNCTIONS[node.name]
	if (!impl) return err("#NAME?")

	// Flatten range arguments into their cells before handing them over.
	const args: CellValue[] = []
	for (const argNode of node.args) {
		if (argNode.kind === "range") {
			const refs = expandRange(argNode.start, argNode.end)
			if (!refs) return err("#REF!")
			for (const ref of refs) args.push(lookup(ref))
			continue
		}
		args.push(evaluateNode(argNode, lookup))
	}

	return impl(args)
}
