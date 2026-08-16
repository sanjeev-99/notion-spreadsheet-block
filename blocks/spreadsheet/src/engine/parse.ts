/**
 * Pratt parser: tokens -> AST.
 *
 * Precedence, loosest to tightest:
 *   comparison (= <> < <= > >=)  <  + -  <  * /  <  ^  <  unary -
 *
 * Two deliberate Excel/Sheets compatibilities, both of which differ from what a
 * general-purpose language would do:
 *
 *   - "^" is right-associative: 2^3^2 is 2^(3^2) = 512.
 *   - Unary minus binds TIGHTER than "^", so -2^2 is (-2)^2 = 4, not -(2^2).
 *     Spreadsheet users expect the Excel answer here.
 *
 * "%" is a POSTFIX percent operator, not modulo — 5% is 0.05. It binds tighter
 * than everything else.
 */

import { stripAbsolute } from "./refs.ts"
import { type Token, tokenize } from "./tokenize.ts"
import { ERROR_CODES, type ErrorCode } from "./values.ts"

export type Node =
	| { kind: "number"; value: number }
	| { kind: "string"; value: string }
	| { kind: "boolean"; value: boolean }
	| { kind: "ref"; ref: string }
	| { kind: "range"; start: string; end: string }
	| { kind: "error"; code: ErrorCode }
	| { kind: "unary"; op: "-" | "+"; operand: Node }
	| { kind: "percent"; operand: Node }
	| { kind: "binary"; op: string; left: Node; right: Node }
	| { kind: "call"; name: string; args: Node[] }

/** Thrown for anything the grammar rejects. Surfaces as #ERROR!. */
export class ParseError extends Error {}

/** Binding power of each infix operator. Higher binds tighter. */
const INFIX_PRECEDENCE: Record<string, number> = {
	"=": 1,
	"<>": 1,
	"<": 1,
	"<=": 1,
	">": 1,
	">=": 1,
	"+": 2,
	"-": 2,
	"*": 3,
	"/": 3,
	"^": 5,
}

/** Above "^" (5), so a unary minus never absorbs a following exponent. */
const UNARY_PRECEDENCE = 6

export function parse(formula: string): Node {
	const tokens = tokenize(formula)
	if (tokens.length === 0) throw new ParseError("Empty formula")

	let pos = 0

	const peek = (): Token | undefined => tokens[pos]

	const expect = (type: Token["type"], what: string): Token => {
		const token = tokens[pos]
		if (!token || token.type !== type) throw new ParseError(`Expected ${what}`)
		pos++
		return token
	}

	/** Parses a prefix position: literals, refs, parens, unary minus, calls. */
	const parsePrefix = (): Node => {
		const token = tokens[pos]
		if (!token) throw new ParseError("Unexpected end of formula")
		pos++

		switch (token.type) {
			case "number":
				return { kind: "number", value: Number(token.value) }

			case "string":
				return { kind: "string", value: token.value }

			// "$" only decides what happens when a formula is copied elsewhere; it
			// makes no difference to the value, so it is dropped here.
			case "ref":
				return { kind: "ref", ref: stripAbsolute(token.value) }

			case "range": {
				const [start, end] = token.value.split(":")
				return {
					kind: "range",
					start: stripAbsolute(start),
					end: stripAbsolute(end),
				}
			}

			case "error": {
				const code = token.value.toUpperCase()
				if (!(ERROR_CODES as readonly string[]).includes(code)) {
					throw new ParseError(`Unknown error literal "${token.value}"`)
				}
				return { kind: "error", code: code as ErrorCode }
			}

			case "lparen": {
				const inner = parseExpression(0)
				expect("rparen", '")"')
				return inner
			}

			case "op": {
				if (token.value !== "-" && token.value !== "+") {
					throw new ParseError(`Unexpected operator "${token.value}"`)
				}
				return {
					kind: "unary",
					op: token.value,
					operand: parseExpression(UNARY_PRECEDENCE),
				}
			}

			case "name": {
				const upper = token.value.toUpperCase()
				if (upper === "TRUE") return { kind: "boolean", value: true }
				if (upper === "FALSE") return { kind: "boolean", value: false }

				// A bare name that isn't a call is a #NAME? at evaluation time; the
				// parser only rejects it if it can't be a function.
				if (peek()?.type !== "lparen") {
					throw new ParseError(`Unknown name "${token.value}"`)
				}
				pos++ // consume "("

				const args: Node[] = []
				if (peek()?.type === "rparen") {
					pos++
				} else {
					for (;;) {
						args.push(parseExpression(0))
						const next = peek()
						if (next?.type === "comma") {
							pos++
							continue
						}
						expect("rparen", '")"')
						break
					}
				}
				return { kind: "call", name: upper, args }
			}

			default:
				throw new ParseError(`Unexpected token "${token.value}"`)
		}
	}

	/**
	 * A prefix expression plus any trailing "%". Percent binds tighter than every
	 * infix operator including "^", so 2^3% is 2^0.03 — consuming it here, before
	 * the infix loop ever runs, is what gives it that precedence.
	 */
	const parseOperand = (): Node => {
		let operand = parsePrefix()
		while (peek()?.type === "op" && peek()?.value === "%") {
			pos++
			operand = { kind: "percent", operand }
		}
		return operand
	}

	/**
	 * Parses an expression, consuming infix operators that bind tighter than
	 * `minPrecedence`.
	 */
	const parseExpression = (minPrecedence: number): Node => {
		let left = parseOperand()

		for (;;) {
			const token = peek()
			if (!token || token.type !== "op") break

			const precedence = INFIX_PRECEDENCE[token.value]
			if (precedence === undefined || precedence < minPrecedence) break

			pos++
			// Right-associative for "^", left-associative for everything else.
			const nextMin = token.value === "^" ? precedence : precedence + 1
			left = {
				kind: "binary",
				op: token.value,
				left,
				right: parseExpression(nextMin),
			}
		}

		return left
	}

	const ast = parseExpression(0)
	if (pos !== tokens.length) {
		throw new ParseError(`Unexpected trailing input "${tokens[pos].value}"`)
	}
	return ast
}
