import "@/lib/ui/theme.css";
import { render } from "preact";
import { App } from "./App";

const root = document.getElementById("app");
if (root) render(<App />, root);
