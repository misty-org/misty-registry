import { loadFromBlob, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Misty } from "@misty/sdk";
import * as Y from "yjs";

export const BOARD_NAME = "Board.excalidraw";
export const MIME = "application/vnd.excalidraw+json";

export const ELEMENTS = "elements";
export const FILES = "files";

export async function boardFileId(misty: Misty): Promise<string> {
  const page = await misty.files.list({ accept: [".excalidraw"] });
  const found = page.files.find((file) => file.name === BOARD_NAME);
  if (found) return found.id;
  const created = await misty.files.save({
    name: BOARD_NAME,
    mime: MIME,
    data: new TextEncoder().encode(serializeAsJSON([], {}, {}, "local")),
  });
  return created.id;
}

export async function sceneOf(data: ArrayBuffer) {
  if (!data.byteLength) return undefined;
  return loadFromBlob(new Blob([data], { type: MIME }), null, null).catch(() => undefined);
}

export async function loadBoard(data: ArrayBuffer, doc: Y.Doc): Promise<void> {
  const scene = await sceneOf(data);
  if (!scene) return;
  const elements = doc.getMap<OrderedExcalidrawElement>(ELEMENTS);
  const files = doc.getMap<BinaryFileData>(FILES);
  doc.transact(() => {
    for (const element of scene.elements) elements.set(element.id, element as OrderedExcalidrawElement);
    for (const file of Object.values(scene.files ?? {})) files.set(file.id, file);
  });
}

export function boardJSON(doc: Y.Doc): string {
  const stored = [...doc.getMap<OrderedExcalidrawElement>(ELEMENTS).values()];
  const elements = restoreElements(stored, null)
    .filter((element) => !element.isDeleted)
    .sort((left, right) => ((left.index ?? "") < (right.index ?? "") ? -1 : 1));
  const files: BinaryFiles = {};
  for (const [id, file] of doc.getMap<BinaryFileData>(FILES)) files[id] = file;
  return serializeAsJSON(elements, {}, files, "local");
}
