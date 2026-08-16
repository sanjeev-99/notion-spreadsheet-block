/**
 * The formula bar: the selected cell's raw text, always editable.
 *
 * This is the safe way to amend a formula — the grid replaces contents when you
 * type into a cell, whereas this edits in place. It is also the only place a
 * formula is visible while the Values tab is showing its result.
 */

import { useEffect, useState } from "react"

import type { RawGrid } from "./engine/evaluate.ts"
import { type Selection, describe, focusedRef } from "./selection.ts"

type FormulaBarProps = {
	selection: Selection
	raws: RawGrid
	readOnly: boolean
	onCommit: (ref: string, raw: string) => void
}

export function FormulaBar({
	selection,
	raws,
	readOnly,
	onCommit,
}: FormulaBarProps) {
	const ref = focusedRef(selection)
	const stored = ref ? (raws[ref] ?? "") : ""

	// null means "not being edited", so the bar tracks the grid. Once the user
	// types, the draft takes over until it is committed or abandoned.
	const [draft, setDraft] = useState<string | null>(null)

	// Moving to another cell abandons an uncommitted draft rather than carrying
	// it across, which would write one cell's text into another.
	useEffect(() => setDraft(null), [ref])

	const disabled = readOnly || ref === undefined

	const commit = () => {
		if (draft === null || ref === undefined) return
		setDraft(null)
		if (draft !== stored) onCommit(ref, draft)
	}

	return (
		<div className="formula-bar">
			<span className="formula-ref" title={`Selected: ${describe(selection)}`}>
				{describe(selection)}
			</span>
			<input
				className="formula-input"
				value={draft ?? stored}
				disabled={disabled}
				placeholder={
					disabled ? "Select a cell to edit" : "Value, or = to start a formula"
				}
				spellCheck={false}
				autoComplete="off"
				aria-label="Formula bar"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
						event.currentTarget.blur()
						return
					}
					if (event.key === "Escape") {
						event.preventDefault()
						setDraft(null)
						event.currentTarget.blur()
					}
				}}
			/>
		</div>
	)
}
