/**
 * Formula engine tests.
 *
 * The engine is pure and has no Notion or React imports, so it runs directly
 * under `node --test` with native type stripping — no build step.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { classify, evaluateGrid } from "../blocks/spreadsheet/src/engine/evaluate.ts"
import type { RawGrid } from "../blocks/spreadsheet/src/engine/evaluate.ts"
import { expandRange, parseRef, toRef } from "../blocks/spreadsheet/src/engine/refs.ts"

/** Evaluates `grid` and returns what the Values tab would show in `ref`. */
function display(grid: RawGrid, ref: string): string {
	return evaluateGrid(grid)[ref].display
}

/** Evaluates a single formula placed in A1, with optional supporting cells. */
function calc(formula: string, rest: RawGrid = {}): string {
	return display({ ...rest, A1: formula }, "A1")
}

test("refs: round-trip and bounds", () => {
	assert.deepEqual(parseRef("A1"), { row: 0, col: 0 })
	assert.deepEqual(parseRef("J10"), { row: 9, col: 9 })
	assert.equal(toRef({ row: 9, col: 9 }), "J10")

	// Outside the 10x10 grid.
	assert.equal(parseRef("K1"), null)
	assert.equal(parseRef("A11"), null)
	assert.equal(parseRef("A0"), null)
	assert.equal(parseRef("AA1"), null)
})

test("refs: ranges expand row-major and accept reversed corners", () => {
	assert.deepEqual(expandRange("A1", "B2"), ["A1", "B1", "A2", "B2"])
	assert.deepEqual(expandRange("B2", "A1"), ["A1", "B1", "A2", "B2"])
	assert.equal(expandRange("A1", "K1"), null)
})

test("classify infers type from raw text without storing it", () => {
	assert.equal(classify(undefined), "empty")
	assert.equal(classify("   "), "empty")
	assert.equal(classify("42"), "number")
	assert.equal(classify("-3.5"), "number")
	assert.equal(classify("Revenue"), "text")
	assert.equal(classify("=SUM(A1:A2)"), "formula")
	// Leading whitespace still reads as a formula.
	assert.equal(classify("  =1+1"), "formula")
})

test("literals pass through", () => {
	const grid = { A1: "10", A2: "Revenue", A3: "" }
	assert.equal(display(grid, "A1"), "10")
	assert.equal(display(grid, "A2"), "Revenue")
	assert.equal(display(grid, "A3"), "")
	// A cell nobody wrote to is empty, not an error.
	assert.equal(display(grid, "J10"), "")
})

test("arithmetic precedence and associativity", () => {
	assert.equal(calc("=1+2*3"), "7")
	assert.equal(calc("=(1+2)*3"), "9")
	assert.equal(calc("=10-2-3"), "5") // left-associative
	assert.equal(calc("=2^3^2"), "512") // right-associative, like Excel
	assert.equal(calc("=-2^2"), "4") // Excel semantics: (-2)^2, not -(2^2)
	assert.equal(calc("=2^-2"), "0.25") // unary still works on the right of ^
	assert.equal(calc("=8/2/2"), "2")
})

test("float noise is formatted away", () => {
	assert.equal(calc("=0.1+0.2"), "0.3")
	assert.equal(calc("=1/3"), "0.333333333333")
})

test("SUM over a range, and range vs scalar args agree", () => {
	const supporting = { A2: "10", A3: "32", A4: "8" }
	assert.equal(calc("=SUM(A2:A4)", supporting), "50")
	assert.equal(calc("=SUM(A2, A3, A4)", supporting), "50")
})

test("aggregates skip non-numeric text, like Excel", () => {
	const supporting = { A2: "Header", A3: "10", A4: "20" }
	assert.equal(calc("=SUM(A2:A4)", supporting), "30")
	assert.equal(calc("=COUNT(A2:A4)", supporting), "2")
	assert.equal(calc("=AVERAGE(A2:A4)", supporting), "15")
	assert.equal(calc("=MIN(A2:A4)", supporting), "10")
	assert.equal(calc("=MAX(A2:A4)", supporting), "20")
})

test("nested function calls", () => {
	const supporting = { A2: "1", A3: "2", A4: "3" }
	assert.equal(calc("=ROUND(AVERAGE(A2:A4), 1)", supporting), "2")
	assert.equal(calc("=ABS(MIN(A2:A4) - MAX(A2:A4))", supporting), "2")
	assert.equal(calc("=SUM(A2:A3) * MAX(A3:A4)", supporting), "9")
})

test("ROUND honours digits and defaults to 0", () => {
	assert.equal(calc("=ROUND(3.14159, 2)"), "3.14")
	assert.equal(calc("=ROUND(3.7)"), "4")
})

test("CONCAT joins text and numbers", () => {
	assert.equal(calc('=CONCAT("Q", 1, " total")'), "Q1 total")
	assert.equal(calc('=CONCAT(A2, "!")', { A2: "Revenue" }), "Revenue!")
})

test("IF branches, and is lazy enough to dodge an error in the untaken branch", () => {
	assert.equal(calc('=IF(1>0, "yes", "no")'), "yes")
	assert.equal(calc('=IF(1<0, "yes", "no")'), "no")
	// B1 is 0, so the division is never evaluated.
	assert.equal(calc('=IF(A2=0, "n/a", A3/A2)', { A2: "0", A3: "10" }), "n/a")
})

test("comparison operators", () => {
	assert.equal(calc("=2>=2"), "TRUE")
	assert.equal(calc("=2<>3"), "TRUE")
	assert.equal(calc('="abc"="ABC"'), "TRUE") // case-insensitive, like Excel
	assert.equal(calc("=3<1"), "FALSE")
})

test("division by zero", () => {
	assert.equal(calc("=1/0"), "#DIV/0!")
	assert.equal(calc("=A2/A3", { A2: "5", A3: "0" }), "#DIV/0!")
})

test("out-of-grid references are #REF!", () => {
	assert.equal(calc("=K1+1"), "#REF!")
	assert.equal(calc("=A11"), "#REF!")
	assert.equal(calc("=SUM(A1:K1)"), "#REF!")
})

test("unknown functions are #NAME?", () => {
	assert.equal(calc("=VLOOKUP(A2)"), "#NAME?")
})

test("unparseable formulas are #ERROR!", () => {
	assert.equal(calc("=1+"), "#ERROR!")
	assert.equal(calc("=(1+2"), "#ERROR!")
	assert.equal(calc("=1 2"), "#ERROR!")
	assert.equal(calc('="unterminated'), "#ERROR!")
})

test("non-numeric text in arithmetic is #VALUE!", () => {
	assert.equal(calc("=A2+1", { A2: "Revenue" }), "#VALUE!")
})

test("a three-cell cycle marks every member #CYCLE!", () => {
	const grid = { A1: "=A2", A2: "=A3", A3: "=A1" }
	const evaluated = evaluateGrid(grid)
	assert.equal(evaluated.A1.display, "#CYCLE!")
	assert.equal(evaluated.A2.display, "#CYCLE!")
	assert.equal(evaluated.A3.display, "#CYCLE!")
})

test("a self-reference is a cycle", () => {
	assert.equal(calc("=A1+1"), "#CYCLE!")
})

test("a cycle inside a range is caught", () => {
	const evaluated = evaluateGrid({ A1: "=SUM(A1:A3)", A2: "1", A3: "2" })
	assert.equal(evaluated.A1.display, "#CYCLE!")
	// Cells that merely sit in the range are unaffected.
	assert.equal(evaluated.A2.display, "1")
})

test("errors propagate to dependents", () => {
	const grid = { A1: "=1/0", A2: "=A1+1", A3: "=SUM(A1:A2)" }
	const evaluated = evaluateGrid(grid)
	assert.equal(evaluated.A2.display, "#DIV/0!")
	assert.equal(evaluated.A3.display, "#DIV/0!")
})

test("cells outside a cycle still compute normally", () => {
	const grid = { A1: "=A2", A2: "=A1", B1: "5", B2: "=B1*2" }
	const evaluated = evaluateGrid(grid)
	assert.equal(evaluated.A1.display, "#CYCLE!")
	assert.equal(evaluated.B2.display, "10")
})

test("a long dependency chain evaluates in order regardless of position", () => {
	// J10 depends on A1 through a chain that runs backwards through the grid,
	// so this only works if evaluation is demand-driven rather than row-major.
	const grid = { J10: "=A1*2", A1: "=B5+1", B5: "4" }
	assert.equal(evaluateGrid(grid).J10.display, "10")
})

test("a cell typed as a percentage is a number, not text", () => {
	assert.equal(classify("5%"), "number")
	assert.equal(classify("12.5%"), "number")
	assert.equal(classify("-2%"), "number")
	// Still text when there is no number in front of the sign.
	assert.equal(classify("%"), "text")
	assert.equal(classify("abc%"), "text")
})

test("a percentage literal computes as a fraction but still reads as typed", () => {
	const evaluated = evaluateGrid({ C2: "5%" })
	assert.equal(evaluated.C2.value, 0.05)
	assert.equal(evaluated.C2.display, "5%")
})

test("the reported failing case: =B2*(1+C2)*A2 with C2 as a percentage", () => {
	const grid = { A2: "2", B2: "100", C2: "5%", D2: "=B2*(1+C2)*A2" }
	assert.equal(evaluateGrid(grid).D2.display, "210")
})

test("percent works as a postfix operator inside a formula", () => {
	assert.equal(calc("=5%"), "0.05")
	assert.equal(calc("=100*(1+5%)"), "105")
	assert.equal(calc("=-5%"), "-0.05")
	assert.equal(calc("=50%+50%"), "1")
})

test("percent binds tighter than ^, like Excel", () => {
	// 2^(3%), not (2^3)% — asserted against both candidates so the test states
	// the precedence rather than a hand-computed decimal.
	assert.equal(calc("=2^3%"), String(Number((2 ** 0.03).toPrecision(12))))
	assert.notEqual(calc("=2^3%"), String(2 ** 3 / 100))
})

test("percentages flow through references and aggregates", () => {
	const supporting = { A2: "5%", A3: "10%", A4: "15%" }
	assert.equal(calc("=SUM(A2:A4)", supporting), "0.3")
	assert.equal(calc("=A2*200", supporting), "10")
	assert.equal(calc("=ROUND(AVERAGE(A2:A4), 4)", supporting), "0.1")
})

test("a formula returning a fraction is not reformatted as a percentage", () => {
	// Nothing recorded that this was a percentage, so it reads as the number.
	assert.equal(calc("=5%*1"), "0.05")
})

test("references to empty cells read as zero", () => {
	assert.equal(calc("=B7+5"), "5")
	assert.equal(calc("=SUM(B1:B9)"), "0")
})
