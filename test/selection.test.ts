/**
 * Selection geometry.
 *
 * The `covers` assertions below are load-bearing: the grid's focus handler uses
 * `covers` to decide whether an incoming focus belongs to the current selection.
 * When that guard was missing, focusing a range's own corner looked like a click
 * on an unrelated cell and collapsed the range the instant it was made — so
 * shift-click and shift-arrow appeared to do nothing at all.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
	type Selection,
	bounds,
	covers,
	describe as describeSelection,
	extendTo,
	focusedRef,
	selectedRefs,
	topLeftRef,
} from "../blocks/spreadsheet/src/selection.ts"

const cell = (ref: string): Selection => ({ kind: "cell", ref })
const range = (anchor: string, focus: string): Selection => ({
	kind: "range",
	anchor,
	focus,
})

test("a range covers both of its corners", () => {
	const selection = range("A1", "C3")
	assert.ok(covers(selection, "A1"), "anchor must be covered")
	assert.ok(covers(selection, "C3"), "focus must be covered")
	assert.ok(covers(selection, "B2"), "interior must be covered")
	assert.ok(!covers(selection, "D1"), "outside must not be covered")
})

test("a range is the same rectangle whichever corner it grew from", () => {
	assert.deepEqual(bounds(range("C3", "A1")), bounds(range("A1", "C3")))
	assert.deepEqual(selectedRefs(range("C3", "A1")), selectedRefs(range("A1", "C3")))
})

test("selected refs are row-major and complete", () => {
	assert.deepEqual(selectedRefs(range("A1", "B2")), ["A1", "B1", "A2", "B2"])
	assert.deepEqual(selectedRefs(cell("D4")), ["D4"])
})

test("a whole row and column resolve to full lines", () => {
	assert.equal(selectedRefs({ kind: "row", row: 2 }).length, 10)
	assert.equal(selectedRefs({ kind: "col", col: 2 }).length, 10)
	assert.ok(covers({ kind: "row", row: 2 }, "J3"))
	assert.ok(!covers({ kind: "row", row: 2 }, "J4"))
})

test("extending a cell anchors the range where it started", () => {
	const grown = extendTo(cell("B2"), "D5")
	assert.deepEqual(grown, range("B2", "D5"))
})

test("extending again keeps the original anchor and moves only the focus", () => {
	// This is what makes shift-arrow grow and shrink from a fixed corner.
	const once = extendTo(cell("B2"), "D5")
	const twice = extendTo(once, "C3")
	assert.deepEqual(twice, range("B2", "C3"))
})

test("focus stays on the moving corner so the keyboard can keep extending", () => {
	assert.equal(focusedRef(range("B2", "D5")), "D5")
	assert.equal(focusedRef(cell("B2")), "B2")
	// Row and column selections have no single focused cell.
	assert.equal(focusedRef({ kind: "row", row: 1 }), undefined)
})

test("copy anchors on the top-left corner regardless of drag direction", () => {
	assert.equal(topLeftRef(range("C3", "A1")), "A1")
	assert.equal(topLeftRef(range("A1", "C3")), "A1")
})

test("selections describe themselves for the toolbar", () => {
	assert.equal(describeSelection(cell("B2")), "B2")
	assert.equal(describeSelection(range("A1", "C3")), "A1:C3")
	// A range collapsed onto one cell reads as that cell, not "A1:A1".
	assert.equal(describeSelection(range("A1", "A1")), "A1")
	assert.equal(describeSelection({ kind: "row", row: 2 }), "row 3")
	assert.equal(describeSelection({ kind: "col", col: 1 }), "column B")
})
