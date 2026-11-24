import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [path, kid = "misty-registry"] = process.argv.slice(2);
if (!path) throw new Error("Give the path to write the private key to, outside this repository.");
const target = resolve(path);
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (target.startsWith(`${repository}/`)) throw new Error("Keep the private key outside this repository.");
if (existsSync(target)) throw new Error(`${target} already exists.`);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(target, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
console.log(`Private key: ${target}`);
console.log(`Public key for Misty: ("${kid}", "${raw}")`);
