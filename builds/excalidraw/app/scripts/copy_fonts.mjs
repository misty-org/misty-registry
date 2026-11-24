import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts", import.meta.url));
const to = fileURLToPath(new URL("../dist/fonts", import.meta.url));
cpSync(from, to, { recursive: true });
