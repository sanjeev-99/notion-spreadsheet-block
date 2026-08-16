/**
 * Sheet-level metadata: column widths, row heights, how much of the grid is
 * shown, and per-cell formatting.
 *
 * All of it lives in ONE reserved row of the same `cells` database, with
 * `Cell = "#sheet"` and a compact JSON blob in `Raw`. `useCells` already skips
 * rows whose `Cell` is not a valid reference, so this needed no new property —
 * which matters, because adding a declared property would force every already
 * deployed block to be re-bound before it would initialize again.
 *
 * The cost of that choice is Notion's 2000-character `rich_text` limit. JSON
 * keys are therefore single letters, defaults are omitted entirely, and
 * `serializeSheetMeta` reports its length so the caller can refuse a write that
 * would not survive the round trip.
 *
 * This module is pure: no React, no Notion. It is unit-tested directly.
 */

import { COLS, ROWS, parseRef } from "./engine/refs.ts"

/** `Cell` value of the reserved metadata row. Not a valid cell reference. */
export const META_CELL_KEY = "#sheet"

/**
 * Refuse to persist beyond this. Notion's rich_text cap is 2000; the margin
 * absorbs the surrounding property envelope.
 */
export const META_MAX_CHARS = 1900

export const DEFAULT_COL_WIDTH = 88
export const DEFAULT_ROW_HEIGHT = 26
export const MIN_COL_WIDTH = 40
export const MAX_COL_WIDTH = 420
export const MIN_ROW_HEIGHT = 20
export const MAX_ROW_HEIGHT = 220

/**
 * Text and background colours are stored as palette NAMES, not raw CSS, so the
 * stylesheet stays in charge of how each one renders in light and dark.
 */
export const TEXT_COLORS = [
	"red",
	"orange",
	"green",
	"blue",
	"purple",
	"gray",
] as const
export const FILL_COLORS = TEXT_COLORS

export type ColorName = (typeof TEXT_COLORS)[number]

/** Compact on purpose — these keys are serialized verbatim. */
export type CellFormat = {
	/** Bold. */
	b?: 1
	/** Italic. */
	i?: 1
	/** Text colour. */
	c?: ColorName
	/** Background colour. */
	g?: ColorName
}

export type SheetMeta = {
	/** Column index -> width in px. Absent means the default. */
	colWidths: Record<number, number>
	/** Row index -> height in px. Absent means the default. */
	rowHeights: Record<number, number>
	/** How many rows/columns are shown. Hidden cells keep their data. */
	visibleRows: number
	visibleCols: number
	/** Cell ref -> formatting. Sparse; unformatted cells are absent. */
	formats: Record<string, CellFormat>
}

export const DEFAULT_META: SheetMeta = {
	colWidths: {},
	rowHeights: {},
	visibleRows: ROWS,
	visibleCols: COLS,
	formats: {},
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Math.round(value)))

/**
 * Colour names cost too much to store verbatim — a fully formatted grid came to
 * 4679 characters, well over the 2000 the property holds. Each format is
 * therefore written as a token string: "b" bold, "i" italic, "c" + code for text
 * colour, "g" + code for fill. So bold italic red-on-orange is "bicrgo".
 *
 * Scanning is unambiguous because "c" and "g" always consume the following
 * character, so a colour code that happens to be "b" is never read as bold.
 */
const COLOR_CODES: Record<ColorName, string> = {
	red: "r",
	orange: "o",
	green: "n",
	blue: "b",
	purple: "p",
	gray: "a",
}

const COLOR_NAMES: Record<string, ColorName> = Object.fromEntries(
	Object.entries(COLOR_CODES).map(([name, code]) => [code, name as ColorName])
)

function encodeFormat(format: CellFormat): string {
	let encoded = ""
	if (format.b) encoded += "b"
	if (format.i) encoded += "i"
	if (format.c) encoded += `c${COLOR_CODES[format.c]}`
	if (format.g) encoded += `g${COLOR_CODES[format.g]}`
	return encoded
}

function decodeFormat(encoded: unknown): CellFormat {
	const format: CellFormat = {}
	if (typeof encoded !== "string") return format

	for (let i = 0; i < encoded.length; i++) {
		switch (encoded[i]) {
			case "b":
				format.b = 1
				break
			case "i":
				format.i = 1
				break
			case "c": {
				const name = COLOR_NAMES[encoded[++i]]
				if (name) format.c = name
				break
			}
			case "g": {
				const name = COLOR_NAMES[encoded[++i]]
				if (name) format.g = name
				break
			}
			default:
				break
		}
	}
	return format
}

/**
 * Reads the stored blob. Never throws and never rejects a whole sheet over one
 * bad field — the metadata row is user-visible and hand-editable, so anything
 * unrecognised is dropped and the rest is kept.
 */
export function parseSheetMeta(raw: string | undefined): SheetMeta {
	if (!raw || raw.trim() === "") return DEFAULT_META

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return DEFAULT_META
	}
	if (typeof parsed !== "object" || parsed === null) return DEFAULT_META

	const source = parsed as Record<string, unknown>

	const readSizes = (
		value: unknown,
		limit: number,
		min: number,
		max: number
	): Record<number, number> => {
		const sizes: Record<number, number> = {}
		if (typeof value !== "object" || value === null) return sizes
		for (const [key, size] of Object.entries(value)) {
			const index = Number(key)
			if (!Number.isInteger(index) || index < 0 || index >= limit) continue
			if (typeof size !== "number" || !Number.isFinite(size)) continue
			sizes[index] = clamp(size, min, max)
		}
		return sizes
	}

	const visible = Array.isArray(source.v) ? source.v : []
	const visibleRows =
		typeof visible[0] === "number" ? clamp(visible[0], 1, ROWS) : ROWS
	const visibleCols =
		typeof visible[1] === "number" ? clamp(visible[1], 1, COLS) : COLS

	const formats: Record<string, CellFormat> = {}
	if (typeof source.f === "object" && source.f !== null) {
		for (const [ref, value] of Object.entries(source.f)) {
			if (!parseRef(ref)) continue
			const format = decodeFormat(value)
			if (Object.keys(format).length > 0) formats[ref.toUpperCase()] = format
		}
	}

	return {
		colWidths: readSizes(source.c, COLS, MIN_COL_WIDTH, MAX_COL_WIDTH),
		rowHeights: readSizes(source.r, ROWS, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
		visibleRows,
		visibleCols,
		formats,
	}
}

/** Writes the blob, omitting anything left at its default. */
export function serializeSheetMeta(meta: SheetMeta): string {
	const output: Record<string, unknown> = {}

	if (Object.keys(meta.colWidths).length > 0) output.c = meta.colWidths
	if (Object.keys(meta.rowHeights).length > 0) output.r = meta.rowHeights
	if (meta.visibleRows !== ROWS || meta.visibleCols !== COLS) {
		output.v = [meta.visibleRows, meta.visibleCols]
	}
	if (Object.keys(meta.formats).length > 0) {
		const encoded: Record<string, string> = {}
		for (const [ref, format] of Object.entries(meta.formats)) {
			const token = encodeFormat(format)
			if (token !== "") encoded[ref] = token
		}
		if (Object.keys(encoded).length > 0) output.f = encoded
	}

	// Nothing customised — store empty text rather than "{}" so an untouched
	// sheet never creates a metadata row at all.
	if (Object.keys(output).length === 0) return ""
	return JSON.stringify(output)
}

/** True if the serialized form will survive a Notion rich_text property. */
export function fitsInProperty(serialized: string): boolean {
	return serialized.length <= META_MAX_CHARS
}

// ── Reads ───────────────────────────────────────────────────

export const colWidth = (meta: SheetMeta, col: number): number =>
	meta.colWidths[col] ?? DEFAULT_COL_WIDTH

export const rowHeight = (meta: SheetMeta, row: number): number =>
	meta.rowHeights[row] ?? DEFAULT_ROW_HEIGHT

export const formatFor = (meta: SheetMeta, ref: string): CellFormat | undefined =>
	meta.formats[ref]

// ── Immutable updates ───────────────────────────────────────

export function withColWidth(
	meta: SheetMeta,
	col: number,
	width: number
): SheetMeta {
	return {
		...meta,
		colWidths: {
			...meta.colWidths,
			[col]: clamp(width, MIN_COL_WIDTH, MAX_COL_WIDTH),
		},
	}
}

export function withRowHeight(
	meta: SheetMeta,
	row: number,
	height: number
): SheetMeta {
	return {
		...meta,
		rowHeights: {
			...meta.rowHeights,
			[row]: clamp(height, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
		},
	}
}

export function withVisible(
	meta: SheetMeta,
	visibleRows: number,
	visibleCols: number
): SheetMeta {
	return {
		...meta,
		visibleRows: clamp(visibleRows, 1, ROWS),
		visibleCols: clamp(visibleCols, 1, COLS),
	}
}

/**
 * Applies `patch` to every ref. A key set to undefined is removed, and a cell
 * left with no formatting at all drops out of the map entirely so the blob does
 * not accumulate empty objects.
 */
export function withFormat(
	meta: SheetMeta,
	refs: string[],
	patch: Partial<Record<keyof CellFormat, CellFormat[keyof CellFormat] | undefined>>
): SheetMeta {
	const formats = { ...meta.formats }

	for (const ref of refs) {
		const next: CellFormat = { ...formats[ref] }
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete next[key as keyof CellFormat]
			else (next as Record<string, unknown>)[key] = value
		}
		if (Object.keys(next).length === 0) delete formats[ref]
		else formats[ref] = next
	}

	return { ...meta, formats }
}

/** Drops formatting for cells that are no longer shown, keeping the blob small. */
export function pruneHiddenFormats(meta: SheetMeta): SheetMeta {
	const formats: Record<string, CellFormat> = {}
	for (const [ref, format] of Object.entries(meta.formats)) {
		const position = parseRef(ref)
		if (!position) continue
		if (position.row >= meta.visibleRows || position.col >= meta.visibleCols) {
			continue
		}
		formats[ref] = format
	}
	return { ...meta, formats }
}
