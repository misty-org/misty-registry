import "./asset_path";
import "@excalidraw/excalidraw/index.css";
import "./board.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connect, type Misty } from "@misty/sdk";
import { Board } from "./Board";

const root = createRoot(document.getElementById("root")!);
const show = (misty?: Misty) =>
  root.render(
    <StrictMode>
      <Board misty={misty} />
    </StrictMode>,
  );

connect({ applyTheme: false }).then(show, () => show());
