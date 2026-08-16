/**
 * Sheet metadata tests.
 *
 * The blob is stored in a user-visible, hand-editable Notion row and is capped
 * at 2000 characters, so parsing must be tolerant and serializing must stay
 * small. Both properties are asserted here.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
	DEFAULT_COL_WIDTH,
	DEFAULT_META,
	DEFAULT_ROW_HEIGHT,
	MAX_COL_WIDTH,
	META_MAX_CHARS,
	MIN_COL_WIDTH,
	colWidth,
	fitsInProperty,
	parseSheetMeta,
	pruneHiddenFormats,
	rowHeight,
	serializeSheetMeta,
	withColWidth,
	withFormat,
	withRowHeight,
	withVisible,
} from "../blocks/spreadsheet/src/sheetMeta.ts"

/** Serializes then re-parses, the round trip every write actually performs. */
const roundTrip = (meta: Parameters<typeof serializeSheetMeta>[0]) =>
	parseSheetMeta(serializeSheetMeta(meta))

test("an untouched sheet serializes to nothing at all", () => {
	assert.equal(serializeSheetMeta(DEFAULT_META), "")
	assert.deepEqual(parseSheetMeta(""), DEFAULT_META)
	assert.deepEqual(parseSheetMeta(undefined), DEFAULT_META)
})

test("defaults apply when a size was never set", () => {
	assert.equal(colWidth(DEFAULT_META, 3), DEFAULT_COL_WIDTH)
	assert.equal(rowHeight(DEFAULT_META, 3), DEFAULT_ROW_HEIGHT)
})

test("sizes round-trip", () => {
	const meta = withRowHeight(withColWidth(DEFAULT_META, 2, 140), 5, 48)
	const restored = roundTrip(meta)
	assert.equal(colWidth(restored, 2), 140)
	assert.equal(rowHeight(restored, 5), 48)
	// Untouched indices still fall back.
	assert.equal(colWidth(restored, 0), DEFAULT_COL_WIDTH)
})

test("sizes are clamped rather than rejected", () => {
	assert.equal(colWidth(withColWidth(DEFAULT_META, 0, 5), 0), MIN_COL_WIDTH)
	assert.equal(colWidth(withColWidth(DEFAULT_META, 0, 9999), 0), MAX_COL_WIDTH)
})

test("visible dimensions round-trip and clamp to the grid", () => {
	const meta = withVisible(DEFAULT_META, 7, 4)
	const restored = roundTrip(meta)
	assert.equal(restored.visibleRows, 7)
	assert.equal(restored.visibleCols, 4)

	assert.equal(withVisible(DEFAULT_META, 0, 0).visibleRows, 1)
	assert.equal(withVisible(DEFAULT_META, 99, 99).visibleCols, 10)
})

test("formatting applies across a range and round-trips", () => {
	const meta = withFormat(DEFAULT_META, ["A1", "B1"], { b: 1, c: "red" })
	const restored = roundTrip(meta)
	assert.deepEqual(restored.formats.A1, { b: 1, c: "red" })
	assert.deepEqual(restored.formats.B1, { b: 1, c: "red" })
	assert.equal(restored.formats.C1, undefined)
})

test("clearing the last attribute drops the cell from the blob", () => {
	const bold = withFormat(DEFAULT_META, ["A1"], { b: 1 })
	assert.deepEqual(bold.formats.A1, { b: 1 })

	const cleared = withFormat(bold, ["A1"], { b: undefined })
	assert.equal(cleared.formats.A1, undefined)
	// And so leaves nothing to store.
	assert.equal(serializeSheetMeta(cleared), "")
})

test("formatting attributes are independent", () => {
	let meta = withFormat(DEFAULT_META, ["A1"], { b: 1, i: 1, g: "blue" })
	meta = withFormat(meta, ["A1"], { i: undefined })
	assert.deepEqual(meta.formats.A1, { b: 1, g: "blue" })
})

test("garbage in the row degrades to defaults instead of throwing", () => {
	assert.deepEqual(parseSheetMeta("not json"), DEFAULT_META)
	assert.deepEqual(parseSheetMeta("[1,2,3]"), DEFAULT_META)
	assert.deepEqual(parseSheetMeta("null"), DEFAULT_META)
})

test("unrecognised fields are dropped, valid siblings are kept", () => {
	const meta = parseSheetMeta(
		JSON.stringify({
			c: { "0": 120, "99": 50, bad: 40 },
			// "cz" is an unknown colour code; "b" alone is still bold. ZZ9 is not a
			// cell in this grid, and a non-string format entry is meaningless.
			f: { A1: "bcz", ZZ9: "b", B2: { b: 1 } },
			v: [7, 4],
		})
	)
	assert.equal(colWidth(meta, 0), 120)
	// Out-of-grid column index and non-numeric key are ignored.
	assert.equal(Object.keys(meta.colWidths).length, 1)
	// Unknown colour dropped, bold kept.
	assert.deepEqual(meta.formats.A1, { b: 1 })
	// Out-of-grid ref and non-object entry dropped.
	assert.equal(meta.formats.ZZ9, undefined)
	assert.equal(meta.formats.B2, undefined)
	assert.equal(meta.visibleRows, 7)
})

test("hidden cells lose their formatting when pruned", () => {
	let meta = withFormat(DEFAULT_META, ["A1", "J10"], { b: 1 })
	meta = pruneHiddenFormats(withVisible(meta, 7, 4))
	assert.deepEqual(meta.formats.A1, { b: 1 })
	assert.equal(meta.formats.J10, undefined)
})

test("a fully formatted grid still fits in one Notion property", () => {
	// The worst realistic case: every cell of the 10x10 carries every attribute.
	const everyRef = Array.from({ length: 10 }, (_, row) =>
		Array.from({ length: 10 }, (_, col) => `${String.fromCharCode(65 + col)}${row + 1}`)
	).flat()

	let meta = withFormat(DEFAULT_META, everyRef, {
		b: 1,
		i: 1,
		c: "purple",
		g: "orange",
	})
	for (let col = 0; col < 10; col++) meta = withColWidth(meta, col, 120)
	for (let row = 0; row < 10; row++) meta = withRowHeight(meta, row, 40)

	const serialized = serializeSheetMeta(meta)
	assert.ok(
		fitsInProperty(serialized),
		`worst case is ${serialized.length} chars, over the ${META_MAX_CHARS} limit`
	)
})
