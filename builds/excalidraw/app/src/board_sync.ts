import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { CaptureUpdateAction, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { Room } from "@misty/sdk";
import { colorsOf, peersOf, TONE_INK } from "@misty/sdk/store";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";

const LOCAL = Symbol("board-local");
const POINTER_MS = 40;

interface PeerState {
  pointer?: { x: number; y: number; tool: "pointer" | "laser" };
  button?: "up" | "down";
  selected?: Record<string, true>;
}

function sameKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) {
  const left = Object.keys(a ?? {});
  const right = Object.keys(b ?? {});
  return left.length === right.length && left.every((key) => b && key in b);
}

export class BoardSync {
  private readonly elements: Y.Map<OrderedExcalidrawElement>;
  private readonly files: Y.Map<BinaryFileData>;
  private readonly versions = new Map<string, number>();
  private pointerTimer?: ReturnType<typeof setTimeout>;
  private pendingPointer?: PeerState["pointer"];
  private disposed = false;
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;

  constructor(
    private readonly room: Room,
    private readonly api: ExcalidrawImperativeAPI,
    private readonly arrived: () => void,
  ) {
    this.doc = room.doc;
    this.awareness = room.awareness;
    this.elements = room.doc.getMap("elements");
    this.files = room.doc.getMap("files");
    this.awareness.setLocalState({} satisfies PeerState);
    this.elements.observe(this.remoteElements);
    this.files.observe(this.remoteFiles);
    this.awareness.on("change", this.peers);
    this.apply([...this.elements.values()]);
    this.addFiles([...this.files.values()]);
    this.peers();
  }

  get empty() {
    return this.elements.size === 0;
  }

  local(elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) {
    if (this.disposed) return;
    const changed = elements.filter((element) => (this.versions.get(element.id) ?? -1) < element.version);
    const added = Object.values(files).filter((file) => !this.files.has(file.id));
    if (changed.length || added.length)
      this.doc.transact(() => {
        for (const element of changed) {
          this.versions.set(element.id, element.version);
          const stored = this.elements.get(element.id);
          if (stored && stored.version >= element.version) continue;
          this.elements.set(element.id, element);
        }
        for (const file of added) this.files.set(file.id, file);
      }, LOCAL);
    const selected = appState.selectedElementIds as Record<string, true>;
    const mine = this.awareness.getLocalState() as PeerState | null;
    if (!sameKeys(mine?.selected, selected)) this.awareness.setLocalStateField("selected", { ...selected });
  }

  pointer(pointer: { x: number; y: number; tool: "pointer" | "laser" }, button: "up" | "down") {
    if (this.disposed) return;
    this.pendingPointer = pointer;
    if ((this.awareness.getLocalState() as PeerState | null)?.button !== button)
      this.awareness.setLocalStateField("button", button);
    if (this.pointerTimer) return;
    this.pointerTimer = setTimeout(() => {
      this.pointerTimer = undefined;
      if (!this.disposed) this.awareness.setLocalStateField("pointer", this.pendingPointer);
    }, POINTER_MS);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.pointerTimer);
    this.elements.unobserve(this.remoteElements);
    this.files.unobserve(this.remoteFiles);
    this.awareness.off("change", this.peers);
  }

  private remoteElements = (event: Y.YMapEvent<OrderedExcalidrawElement>, transaction: Y.Transaction) => {
    if (transaction.origin === LOCAL || this.disposed) return;
    const remote = [...event.keysChanged]
      .map((id) => this.elements.get(id))
      .filter((element): element is OrderedExcalidrawElement => Boolean(element));
    this.apply(remote);
    this.arrived();
  };

  private remoteFiles = (event: Y.YMapEvent<BinaryFileData>, transaction: Y.Transaction) => {
    if (transaction.origin === LOCAL || this.disposed) return;
    this.addFiles(
      [...event.keysChanged]
        .map((id) => this.files.get(id))
        .filter((file): file is BinaryFileData => Boolean(file)),
    );
  };

  private apply(remote: OrderedExcalidrawElement[]) {
    if (!remote.length) return;
    for (const element of remote)
      this.versions.set(element.id, Math.max(this.versions.get(element.id) ?? -1, element.version));
    const restored = restoreElements(remote, null) as unknown as Parameters<typeof reconcileElements>[1];
    const elements = reconcileElements(
      this.api.getSceneElementsIncludingDeleted(),
      restored,
      this.api.getAppState(),
    );
    this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private addFiles(files: BinaryFileData[]) {
    if (files.length) this.api.addFiles(files);
  }

  private peers = (change?: { added: number[]; updated: number[]; removed: number[] }) => {
    if (this.disposed) return;
    const touched = change ? [...change.added, ...change.updated, ...change.removed] : [];
    if (touched.length && touched.every((client) => client === this.doc.clientID)) return;
    const collaborators = new Map<SocketId, Collaborator>();
    const known = new Map(peersOf(this.room).map((peer) => [peer.clientId, peer]));
    for (const [client, raw] of this.awareness.getStates()) {
      if (client === this.doc.clientID) continue;
      const outer = (raw ?? {}) as PeerState & { presence?: PeerState | null };
      const state: PeerState = outer.presence ? { ...outer, ...outer.presence } : outer;
      const who = known.get(client) ?? this.room.identity(client);
      collaborators.set(String(client) as SocketId, {
        id: who?.user_id ?? String(client),
        username: who?.name ?? null,
        color: { background: colorsOf(who?.tone ?? null).color, stroke: TONE_INK },
        pointer: state.pointer,
        button: state.button,
        selectedElementIds: state.selected,
      });
    }
    this.api.updateScene({ collaborators });
  };
}
