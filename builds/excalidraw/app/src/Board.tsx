import { useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Misty, Room } from "@misty/sdk";
import { BoardSync } from "./board_sync";
import { boardFileId, boardJSON, loadBoard } from "./board_file";
import { serveBoardTools } from "./board_tools";

function useFileId(misty: Misty | undefined) {
  const [fileId, setFileId] = useState(misty?.route().params.file);
  useEffect(() => misty?.onRoute((route) => setFileId(route.params.file)), [misty]);
  return fileId;
}

function useThemeMode(misty: Misty | undefined) {
  const [mode, setMode] = useState(misty?.theme().mode ?? "light");
  useEffect(() => misty?.onTheme((theme) => setMode(theme.mode)), [misty]);
  return mode;
}

async function openRoom(misty: Misty, fileId: string): Promise<Room> {
  if (misty.supports("room.sync")) {
    const room = misty.room.forFile(fileId, { load: loadBoard, serialize: boardJSON });
    await room.ready;
    return room;
  }
  const room = misty.room(`file:${fileId}`);
  await room.synced;
  if (room.doc.getMap("elements").size === 0) {
    const { data } = await misty.files.download(fileId);
    await loadBoard(data, room.doc);
  }
  return room;
}

export function Board({ misty }: { misty?: Misty }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const fileId = useFileId(misty);
  const theme = useThemeMode(misty);
  const sync = useRef<BoardSync | null>(null);
  const live = useRef<Room | null>(null);

  useEffect(() => {
    if (!misty || !api) return;
    return serveBoardTools(misty, api, () => live.current);
  }, [misty, api]);

  useEffect(() => {
    if (!misty || !api) return;
    let alive = true;
    let board: BoardSync | undefined;
    let room: Room | undefined;
    let framed = false;
    const frame = () => {
      if (framed || !api.getSceneElements().length) return;
      framed = true;
      api.scrollToContent(undefined, { fitToContent: true });
    };
    void (async () => {
      const id = fileId ?? (await boardFileId(misty));
      if (!alive) return;
      const opened = await openRoom(misty, id);
      if (!alive) {
        opened.destroy();
        return;
      }
      room = opened;
      room.onLost((error) => console.warn("The board's live room closed:", error));
      board = new BoardSync(room, api, frame);
      frame();
      sync.current = board;
      live.current = room;
    })().catch((error: unknown) => console.warn("The board couldn't open:", error));
    return () => {
      alive = false;
      sync.current = null;
      live.current = null;
      board?.dispose();
      room?.destroy();
    };
  }, [misty, api, fileId]);

  return (
    <div className="board">
      <Excalidraw
        excalidrawAPI={setApi}
        theme={theme}
        isCollaborating={Boolean(misty)}
        onChange={(elements, appState, files) => sync.current?.local(elements, appState, files)}
        onPointerUpdate={({ pointer, button }) => sync.current?.pointer(pointer, button)}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />
    </div>
  );
}
