import { render } from "solid-js/web";
import { App } from "./App.js";
import { toast } from "./state.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("kanboard: #root missing");
// UI checks (tests/ui.mjs) raise toasts directly to test folding/capping.
(window as unknown as { __kbToast: typeof toast }).__kbToast = toast;
render(() => <App />, root);
