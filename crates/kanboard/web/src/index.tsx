import { render } from "solid-js/web";
import { App } from "./App.js";
import { toast } from "./state.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("kanboard: #root missing");
// UI checks (tests/ui.mjs) raise toasts directly to test folding/capping.
(window as unknown as { __kbToast: typeof toast }).__kbToast = toast;
// A file dropped outside a drop zone must not make the browser navigate to it
// (that throws the board away). Zones call preventDefault themselves first.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
}
render(() => <App />, root);
