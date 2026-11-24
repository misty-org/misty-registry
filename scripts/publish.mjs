import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { built } from "./build.mjs";

const pem = process.env.REGISTRY_SIGNING_KEY;
if (!pem) throw new Error("REGISTRY_SIGNING_KEY is not set: run scripts/keygen.mjs once and keep its key as a secret.");
const kid = process.env.REGISTRY_KEY_ID || "misty-registry";
const root = new URL("../", import.meta.url);

const committed = readFileSync(new URL("registry.json", root), "utf8");
if (committed !== built()["registry.json"]) throw new Error("registry.json is out of date: run npm run build.");

const document = { ...JSON.parse(committed), published_at: new Date().toISOString() };
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const payload = b64url(JSON.stringify(document));
const header = b64url(JSON.stringify({ alg: "EdDSA", kid }));
const signature = b64url(sign(null, Buffer.from(`${header}.${payload}`), createPrivateKey(pem)));

const site = new URL("site/", root);
mkdirSync(site, { recursive: true });
writeFileSync(new URL("registry.jws.json", site), `${JSON.stringify({ payload, signatures: [{ protected: header, signature }] })}\n`);
writeFileSync(new URL("CNAME", site), "registry.mistysys.com\n");
console.log(`site/registry.jws.json signed with ${kid}, published ${document.published_at}`);
