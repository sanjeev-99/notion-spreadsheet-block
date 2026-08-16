/**
 * Tab-separated text, the lingua franca of spreadsheet clipboards.
 *
 * Copying writes each cell's RAW text, so a formula survives a round trip
 * through the clipboard, and pasting into Excel or Sheets carries the formula
 * rather than the number it happened to show.
 */

/** A rectangular block of raw cell text, row-major. */
export type CellBlock = string[][]

export function toTsv(block: CellBlock): string {
	return block.map((row) => row.join("\t")).join("\n")
}

/**
 * Parses clipboard text into a rectangle, padding short rows so the result is
 * never ragged. A trailing newline — which most spreadsheets append — is not
 * treated as an extra empty row.
 */
export function fromTsv(text: string): CellBlock {
	const withoutTrailingNewline = text.replace(/\r?\n$/, "")
	if (withoutTrailingNewline === "") return []

	const rows = withoutTrailingNewline.split(/\r?\n/).map((line) => line.split("\t"))
	const width = Math.max(...rows.map((row) => row.length))

	return rows.map((row) =>
		row.length === width ? row : [...row, ...Array(width - row.length).fill("")]
	)
}
