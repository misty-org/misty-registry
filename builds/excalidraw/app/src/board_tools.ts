import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  getCommonBounds,
  newElementWith,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { agentOfCall, joinAsAgent } from "@misty/sdk";
import type { AgentInRoom, McpMessage, Misty, Room } from "@misty/sdk";
import { MIME } from "./board_file";

const PROTOCOL = "2025-06-18";
const GAP = 80;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run(args: Json, agent: AgentInRoom | null): Promise<unknown>;
}

const EDITABLE = new Set([
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "locked",
  "link",
  "text",
  "fontSize",
  "textAlign",
  "verticalAlign",
]);

const object = (properties: Json, required: string[] = []): Json => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function summary(element: ExcalidrawElement): Json {
  const facts: Json = {
    id: element.id,
    type: element.type,
    x: Math.round(element.x),
    y: Math.round(element.y),
    width: Math.round(element.width),
    height: Math.round(element.height),
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
  };
  if (element.angle) facts.angle = element.angle;
  if ("text" in element) facts.text = element.text;
  if ("containerId" in element && element.containerId) facts.containerId = element.containerId;
  if (element.boundElements?.length) facts.boundElements = element.boundElements.map((bound) => bound.id);
  if ("startBinding" in element && element.startBinding) facts.from = element.startBinding.elementId;
  if ("endBinding" in element && element.endBinding) facts.to = element.endBinding.elementId;
  if (element.groupIds.length) facts.groupIds = element.groupIds;
  if (element.frameId) facts.frameId = element.frameId;
  if (element.link) facts.link = element.link;
  return facts;
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function rightOfScene(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements();
  if (!elements.length) return { x: 0, y: 0 };
  const [, minY, maxX] = getCommonBounds(elements);
  return { x: maxX + GAP, y: minY };
}

function placed(elements: OrderedExcalidrawElement[], at: { x: number; y: number }) {
  if (!elements.length) return elements;
  const [minX, minY] = getCommonBounds(elements);
  return elements.map((element) => newElementWith(element, { x: element.x - minX + at.x, y: element.y - minY + at.y }));
}

function writeAsAgent(agent: AgentInRoom, elements: OrderedExcalidrawElement[], files: BinaryFileData[] = []) {
  agent.transact((mirror) => {
    const stored = mirror.getMap<OrderedExcalidrawElement>("elements");
    for (const element of elements) stored.set(element.id, element);
    const kept = mirror.getMap<BinaryFileData>("files");
    for (const file of files) if (!kept.has(file.id)) kept.set(file.id, file);
  });
  const shown = elements.filter((element) => !element.isDeleted);
  agent.setPresence({ selected: Object.fromEntries(shown.map((element) => [element.id, true])) });
}

function changeScene(
  api: ExcalidrawImperativeAPI,
  agent: AgentInRoom | null,
  changed: OrderedExcalidrawElement[],
) {
  if (agent) {
    writeAsAgent(agent, changed);
    return;
  }
  const byId = new Map(changed.map((element) => [element.id, element]));
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((element) => byId.get(element.id) ?? element),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

function addToScene(
  api: ExcalidrawImperativeAPI,
  agent: AgentInRoom | null,
  added: OrderedExcalidrawElement[],
  files: BinaryFileData[] = [],
) {
  if (agent) writeAsAgent(agent, added, files);
  else {
    if (files.length) api.addFiles(files);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...added],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  api.scrollToContent(added, { fitToContent: false, animate: true });
  return added.map((element) => element.id);
}

function tools(misty: Misty, api: ExcalidrawImperativeAPI): Tool[] {
  const live = () => api.getSceneElements();
  const byId = (ids: unknown) => {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
      throw new Error("Give the elements' ids as a list of strings.");
    return new Set(ids as string[]);
  };
  return [
    {
      name: "read_scene",
      description:
        "Read the board everyone is drawing on: each element's id, type, position, size, colors, text and what it is bound or connected to. Pass ids to read only those.",
      inputSchema: object({ ids: { type: "array", items: { type: "string" } } }),
      async run({ ids }) {
        const wanted = ids === undefined ? null : byId(ids);
        const elements = live().filter((element) => !wanted || wanted.has(element.id));
        return { count: elements.length, elements: elements.map(summary) };
      },
    },
    {
      name: "add_elements",
      description:
        "Add elements to the board, given as Excalidraw element skeletons: { type: rectangle | ellipse | diamond | text | arrow | line | frame, x, y, width?, height?, text?, label?: { text }, strokeColor?, backgroundColor?, start?/end?: { id } for arrows, id? }. Placed to the right of what is there unless place_at_given_coordinates is true.",
      inputSchema: object(
        {
          elements: { type: "array", items: { type: "object" } },
          place_at_given_coordinates: { type: "boolean" },
        },
        ["elements"],
      ),
      async run({ elements, place_at_given_coordinates: keep }, agent) {
        if (!Array.isArray(elements) || !elements.length) throw new Error("Give at least one element.");
        const made = convertToExcalidrawElements(elements as ExcalidrawElementSkeleton[], { regenerateIds: false });
        const ids = addToScene(api, agent, keep === true ? made : placed(made, rightOfScene(api)));
        return { added: ids };
      },
    },
    {
      name: "update_elements",
      description: `Change elements on the board by id. Each change is { id, ...properties }, the properties being any of ${[...EDITABLE].join(", ")}.`,
      inputSchema: object({ changes: { type: "array", items: { type: "object" } } }, ["changes"]),
      async run({ changes }, agent) {
        if (!Array.isArray(changes) || !changes.length) throw new Error("Give at least one change.");
        const wanted = new Map<string, Json>();
        for (const change of changes as Json[]) {
          if (typeof change.id !== "string") throw new Error("Each change needs the element's id.");
          const patch: Json = {};
          for (const [key, value] of Object.entries(change))
            if (key !== "id") {
              if (!EDITABLE.has(key)) throw new Error(`${key} can't be changed this way.`);
              patch[key] = value;
            }
          if (typeof patch.text === "string") patch.originalText = patch.text;
          wanted.set(change.id, patch);
        }
        const missing = [...wanted.keys()].filter((id) => !live().some((element) => element.id === id));
        if (missing.length) throw new Error(`There is no element ${missing.join(", ")} on the board.`);
        changeScene(
          api,
          agent,
          api
            .getSceneElementsIncludingDeleted()
            .filter((element) => wanted.has(element.id))
            .map((element) => newElementWith(element, wanted.get(element.id) as Partial<typeof element>)),
        );
        return { changed: [...wanted.keys()] };
      },
    },
    {
      name: "delete_elements",
      description: "Delete elements from the board by id, with the text and arrows bound to them.",
      inputSchema: object({ ids: { type: "array", items: { type: "string" } } }, ["ids"]),
      async run({ ids }, agent) {
        const gone = byId(ids);
        for (const element of live())
          if (
            ("containerId" in element && element.containerId && gone.has(element.containerId)) ||
            ("startBinding" in element && element.startBinding && gone.has(element.startBinding.elementId)) ||
            ("endBinding" in element && element.endBinding && gone.has(element.endBinding.elementId))
          )
            gone.add(element.id);
        changeScene(
          api,
          agent,
          api
            .getSceneElementsIncludingDeleted()
            .filter((element) => gone.has(element.id))
            .map((element) => newElementWith(element, { isDeleted: true })),
        );
        if (agent) agent.setPresence(null);
        return { deleted: [...gone] };
      },
    },
    {
      name: "add_mermaid",
      description:
        "Draw a diagram from Mermaid (flowcharts, sequence and class diagrams), converted by Excalidraw's own converter into elements everyone can edit. Placed to the right of what is there.",
      inputSchema: object({ definition: { type: "string" } }, ["definition"]),
      async run({ definition }, agent) {
        if (typeof definition !== "string" || !definition.trim()) throw new Error("Give the Mermaid definition.");
        const { elements, files } = await parseMermaidToExcalidraw(definition);
        const made = convertToExcalidrawElements(elements as ExcalidrawElementSkeleton[], { regenerateIds: true });
        const ids = addToScene(api, agent, placed(made, rightOfScene(api)), Object.values(files ?? {}));
        return { added: ids };
      },
    },
    {
      name: "undo_my_change",
      description: "Take back your own last change to the board, leaving everyone else's as they are.",
      inputSchema: object({}),
      async run(_args, agent) {
        if (!agent) throw new Error("Only a live board keeps each agent's own changes to undo.");
        return { undone: agent.undo() };
      },
    },
    {
      name: "export",
      description:
        "Export the board, or the elements given by id, as png, svg or excalidraw, saved into the Space's files in this app's folder.",
      inputSchema: object(
        {
          format: { type: "string", enum: ["png", "svg", "excalidraw"] },
          name: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
          dark: { type: "boolean" },
        },
        ["format"],
      ),
      async run({ format, name, ids, dark }) {
        const wanted = ids === undefined ? null : byId(ids);
        const elements = live().filter((element) => !wanted || wanted.has(element.id));
        if (!elements.length) throw new Error("There is nothing to export.");
        const appState = { ...api.getAppState(), exportWithDarkMode: dark === true, exportBackground: true };
        const files = api.getFiles();
        const base = (typeof name === "string" && name.trim() ? name.trim() : "Board").replace(/\.(png|svg|excalidraw)$/i, "");
        let data: Uint8Array;
        let mime: string;
        if (format === "png") {
          const blob = await exportToBlob({ elements, appState, files, mimeType: "image/png" });
          data = new Uint8Array(await blob.arrayBuffer());
          mime = "image/png";
        } else if (format === "svg") {
          const svg = await exportToSvg({ elements, appState, files });
          data = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
          mime = "image/svg+xml";
        } else if (format === "excalidraw") {
          data = new TextEncoder().encode(serializeAsJSON(elements, appState, files, "local"));
          mime = MIME;
        } else throw new Error("The format is png, svg or excalidraw.");
        const file = await misty.files.save({ name: `${base}.${format}`, mime, data });
        return { file };
      },
    },
  ];
}

export function serveBoardTools(misty: Misty, api: ExcalidrawImperativeAPI, room: () => Room | null): () => void {
  const transport = misty.mcpTransport();
  const offered = tools(misty, api);
  const send = (message: McpMessage) => void transport.send(message).catch(() => undefined);
  transport.onmessage = (raw) => {
    const message = raw as { id?: string | number; method?: string; params?: Json };
    if (typeof message.method !== "string") return;
    const reply = (result: unknown) => {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
    };
    const fail = (code: number, error: string) => {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code, message: error } });
    };
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion:
            typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "excalidraw", version: "0.2.0" },
          instructions:
            "These tools draw on the Excalidraw board open in the person's window, which everyone in the Space edits live. Read the scene before changing it.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const tool = offered.find((candidate) => candidate.name === message.params?.name);
        if (!tool) return fail(-32602, `There is no tool ${String(message.params?.name)}.`);
        const args = (message.params?.arguments ?? {}) as Json;
        const caller = agentOfCall(message.params);
        const live = room();
        const agent =
          caller && live
            ? joinAsAgent(live, caller, { scope: (mirror) => [mirror.getMap("elements"), mirror.getMap("files")] })
            : null;
        void tool.run(args, agent).then(
          (result) => reply(text(result)),
          (error: unknown) =>
            reply({ ...text(error instanceof Error ? error.message : String(error)), isError: true }),
        );
        return;
      }
      default:
        if (message.method.startsWith("notifications/")) return;
        return fail(-32601, `${message.method} isn't something this app answers.`);
    }
  };
  void transport.start().catch(() => undefined);
  return () => {
    transport.onmessage = undefined;
    void transport.close();
  };
}
