/**
 * Formula translation and clipboard encoding.
 *
 * These are the rules that make copy/paste feel like a spreadsheet: references
 * move with the formula unless a `$` pins them.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { fromTsv, toTsv } from "../blocks/spreadsheet/src/clipboard.ts"
import { evaluateGrid } from "../blocks/spreadsheet/src/engine/evaluate.ts"
import {
	translateCell,
	translateFormula,
} from "../blocks/spreadsheet/src/engine/translate.ts"

test("relative references move with the formula", () => {
	// One column right.
	assert.equal(translateFormula("A1+A2", 0, 1), "B1+B2")
	// One row down.
	assert.equal(translateFormula("A1+A2", 1, 0), "A2+A3")
	// Both.
	assert.equal(translateFormula("A1", 2, 3), "D3")
	// Backwards.
	assert.equal(translateFormula("C3", -1, -1), "B2")
})

test("a zero offset is a no-op", () => {
	assert.equal(translateFormula("SUM(A1:B2)*C3", 0, 0), "SUM(A1:B2)*C3")
})

test("$ pins the half it precedes", () => {
	// Column pinned, row free.
	assert.equal(translateFormula("$A1", 1, 1), "$A2")
	// Row pinned, column free.
	assert.equal(translateFormula("A$1", 1, 1), "B$1")
	// Both pinned.
	assert.equal(translateFormula("$A$1", 5, 5), "$A$1")
	// Neither.
	assert.equal(translateFormula("A1", 1, 1), "B2")
})

test("ranges move end to end, and honour $ per corner", () => {
	assert.equal(translateFormula("SUM(A1:A3)", 0, 1), "SUM(B1:B3)")
	assert.equal(translateFormula("SUM($A$1:A3)", 1, 0), "SUM($A$1:A4)")
})

test("the classic use: a running total copied down a column", () => {
	// =B2*$C$1 copied from D2 down to D3 and D4 keeps the rate cell pinned.
	assert.equal(translateCell("=B2*$C$1", 1, 0), "=B3*$C$1")
	assert.equal(translateCell("=B2*$C$1", 2, 0), "=B4*$C$1")
})

test("references pushed off the grid become #REF!", () => {
	assert.equal(translateFormula("A1", -1, 0), "#REF!")
	assert.equal(translateFormula("A1", 0, -1), "#REF!")
	assert.equal(translateFormula("J10", 1, 0), "#REF!")
	// A range loses meaning if either corner falls off.
	assert.equal(translateFormula("SUM(A1:A3)", -1, 0), "SUM(#REF!)")
})

test("a translated #REF! evaluates as an error rather than a syntax failure", () => {
	// The language must be able to read its own output back.
	const grid = { A1: "=#REF!", A2: "=A1+1" }
	const evaluated = evaluateGrid(grid)
	assert.equal(evaluated.A1.display, "#REF!")
	assert.equal(evaluated.A2.display, "#REF!")
})

test("$ changes nothing about the computed value", () => {
	const grid = {
		A1: "10",
		B1: "=$A$1*2",
		C1: "=A1*2",
	}
	const evaluated = evaluateGrid(grid)
	assert.equal(evaluated.B1.display, "20")
	assert.equal(evaluated.C1.display, evaluated.B1.display)
})

test("only references are rewritten — text, numbers and names are untouched", () => {
	assert.equal(
		translateFormula('IF(A1>0, "A1 is positive", B1)', 1, 0),
		'IF(A2>0, "A1 is positive", B2)'
	)
	// Function names that look nothing like refs stay put.
	assert.equal(translateFormula("SUM(A1)", 1, 0), "SUM(A2)")
})

test("spacing and function names survive; refs normalise to uppercase", () => {
	assert.equal(translateCell("= A1 + 1", 1, 0), "= A2 + 1")
	// "sum" stays lowercase as typed; the refs are uppercased, as Excel does.
	assert.equal(translateFormula("  sum( a1, a2 )  ", 1, 0), "  sum( A2, A3 )  ")
})

test("a range may be spaced around the colon", () => {
	// The whole range is one token, so its internal spacing is normalised while
	// the surrounding text is left as typed.
	assert.equal(translateFormula("sum( a1 : a3 )", 1, 0), "sum( A2:A4 )")
	assert.equal(
		evaluateGrid({ A1: "1", A2: "2", A3: "3", B1: "=SUM(A1 : A3)" }).B1.display,
		"6"
	)
})

test("literals are copied unchanged", () => {
	assert.equal(translateCell("42", 3, 3), "42")
	assert.equal(translateCell("Revenue", 3, 3), "Revenue")
	assert.equal(translateCell("5%", 3, 3), "5%")
	assert.equal(translateCell("", 3, 3), "")
})

test("an unparseable formula is left alone rather than mangled", () => {
	assert.equal(translateCell("=1 @ 2", 1, 0), "=1 @ 2")
})

test("TSV round-trips a block of cells", () => {
	const block = [
		["Region", "Q1", "Q2"],
		["North", "120", "=SUM(B2:C2)"],
	]
	assert.deepEqual(fromTsv(toTsv(block)), block)
})

test("TSV tolerates CRLF, a trailing newline, and ragged rows", () => {
	assert.deepEqual(fromTsv("a\tb\r\nc\td\r\n"), [
		["a", "b"],
		["c", "d"],
	])
	// Short rows are padded so the block stays rectangular.
	assert.deepEqual(fromTsv("a\tb\tc\nd"), [
		["a", "b", "c"],
		["d", "", ""],
	])
	assert.deepEqual(fromTsv(""), [])
})
