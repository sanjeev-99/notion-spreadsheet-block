/**
 * Tokenizer for the formula language.
 *
 * Input is the formula body — the caller strips the leading "=" first.
 */

import { looksLikeRef } from "./refs.ts"

export type TokenType =
	| "number"
	| "string"
	| "ref"
	| "range"
	| "name"
	| "error"
	| "op"
	| "lparen"
	| "rparen"
	| "comma"

/**
 * `start`/`end` are offsets into the input. Formula translation splices only the
 * reference tokens and copies everything between them verbatim, so a rewritten
 * formula keeps the author's original spacing and capitalisation.
 */
export type Token = { type: TokenType; value: string; start: number; end: number }

/** Thrown for characters the language has no meaning for. Surfaces as #ERROR!. */
export class TokenizeError extends Error {}

// "%" is postfix percent, as in spreadsheets — never modulo. Multi-character
// operators must precede their prefixes so "<=" is not read as "<" then "=".
const OPERATORS = ["<=", ">=", "<>", "+", "-", "*", "/", "^", "=", "<", ">", "%"]

/** `#REF!`, `#DIV/0!`, `#NAME?` … written literally into a formula. */
const ERROR_PATTERN = /^#[A-Z]+(?:\/[0-9]+)?[!?]/

/** Characters that can appear inside a reference or a bare name. */
const WORD_CHAR = /[A-Za-z0-9_.$]/

const isDigit = (ch: string) => ch >= "0" && ch <= "9"
const isWordStart = (ch: string) => /[A-Za-z_$]/.test(ch)
const isSpace = (ch: string | undefined) =>
	ch === " " || ch === "\t" || ch === "\n" || ch === "\r"

export function tokenize(input: string): Token[] {
	const tokens: Token[] = []
	let i = 0

	const push = (type: TokenType, value: string, start: number, end: number) => {
		tokens.push({ type, value, start, end })
	}

	while (i < input.length) {
		const ch = input[i]

		if (isSpace(ch)) {
			i++
			continue
		}

		// Numbers: 12, 3.5, .5. A leading "-" is handled as unary minus by the
		// parser, not folded in here, so that A1-2 tokenizes as three tokens.
		if (isDigit(ch) || (ch === "." && isDigit(input[i + 1]))) {
			const start = i
			let j = i
			while (j < input.length && isDigit(input[j])) j++
			if (input[j] === ".") {
				j++
				while (j < input.length && isDigit(input[j])) j++
			}
			push("number", input.slice(start, j), start, j)
			i = j
			continue
		}

		// Strings: double-quoted, with "" as an escaped quote (spreadsheet style).
		if (ch === '"') {
			const start = i
			let j = i + 1
			let value = ""
			for (;;) {
				if (j >= input.length) throw new TokenizeError("Unterminated string")
				if (input[j] === '"') {
					if (input[j + 1] === '"') {
						value += '"'
						j += 2
						continue
					}
					j++
					break
				}
				value += input[j]
				j++
			}
			push("string", value, start, j)
			i = j
			continue
		}

		// An error written into the formula itself. Copying a formula off the edge
		// of the grid produces one, exactly as it does in Excel, so the language
		// has to be able to read its own output back.
		if (ch === "#") {
			const match = ERROR_PATTERN.exec(input.slice(i).toUpperCase())
			if (!match) throw new TokenizeError('Unexpected character "#"')
			const end = i + match[0].length
			push("error", match[0], i, end)
			i = end
			continue
		}

		// Identifiers split three ways: A1:B3 is a range, $A1 is a ref, and
		// anything else (SUM, TRUE) is a name the parser resolves.
		if (isWordStart(ch)) {
			const start = i
			let j = i
			while (j < input.length && WORD_CHAR.test(input[j])) j++
			const word = input.slice(start, j)

			// A range may be spaced out — "A1 : A3" is the same as "A1:A3" — so the
			// colon is looked for past any whitespace on either side.
			if (looksLikeRef(word)) {
				let k = j
				while (k < input.length && isSpace(input[k])) k++

				if (input[k] === ":") {
					k++
					while (k < input.length && isSpace(input[k])) k++

					let end = k
					while (end < input.length && WORD_CHAR.test(input[end])) end++
					const endWord = input.slice(k, end)

					if (looksLikeRef(endWord)) {
						push("range", `${word}:${endWord}`, start, end)
						i = end
						continue
					}
				}
			}

			push(looksLikeRef(word) ? "ref" : "name", word, start, j)
			i = j
			continue
		}

		if (ch === "(") {
			push("lparen", ch, i, i + 1)
			i++
			continue
		}
		if (ch === ")") {
			push("rparen", ch, i, i + 1)
			i++
			continue
		}
		if (ch === "," || ch === ";") {
			push("comma", ",", i, i + 1)
			i++
			continue
		}

		const op = OPERATORS.find((candidate) => input.startsWith(candidate, i))
		if (op) {
			push("op", op, i, i + op.length)
			i += op.length
			continue
		}

		throw new TokenizeError(`Unexpected character "${ch}"`)
	}

	return tokens
}
