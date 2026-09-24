import { render } from "solid-js/web";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("kanboard: #root missing");
render(() => <App />, root);
