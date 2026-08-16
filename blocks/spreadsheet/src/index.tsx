import "@notionhq/custom-blocks/nds.css"
import {
	NotionCustomBlock,
	NotionTokenScope,
} from "@notionhq/custom-blocks/react"
import ReactDOM from "react-dom/client"

import { App } from "./App.tsx"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

// NotionCustomBlock performs the handshake with the host and reports the
// block's height back so the iframe sizes itself (auto-resize is the SDK
// default; a fixed height would be set as a CSS height on #root instead).
// Nothing inside it may call an SDK hook before initialization completes —
// the hooks throw if it hasn't.
ReactDOM.createRoot(root).render(
	<NotionCustomBlock>
		<NotionTokenScope>
			<App />
		</NotionTokenScope>
	</NotionCustomBlock>
)
