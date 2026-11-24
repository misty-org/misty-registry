// The pins: for each listed app, the release (or built zip) it is pinned to, written by refresh.ts and read by
// everything that publishes. They are the one part of the index that is state rather than built from the folders.
import { readFileSync, writeFileSync } from "node:fs";

export const PINS = new URL("../pins.json", import.meta.url);
export const SCHEMA = 2;
/** The index's own shape: the root holds only checksummed pointers, to its sections and to each listing's shards. */
export const INDEX_SCHEMA = 3;

export const readPins = (): { schema: number; apps: any[] } => JSON.parse(readFileSync(PINS, "utf8"));
export const pinnedApps = () => readPins().apps ?? [];
export const writePins = (apps: any[]) => writeFileSync(PINS, `${JSON.stringify({ schema: SCHEMA, apps }, null, 2)}\n`);

export const minified = (document: unknown) => `${JSON.stringify(document)}\n`;
