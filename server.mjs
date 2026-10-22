// More storage for COGNIX[WS] backups, through rclone (ADR-0368): Dropbox,
// OneDrive, an SFTP server, WebDAV (Nextcloud, ownCloud) and more as rclone
// grows. The core encrypts every object before it reaches this process;
// each storage holds only encrypted copies.
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Door, send } from "./lib/door.mjs";
import { HostAPI } from "./lib/host.mjs";
import { authorize, baseEnv, ensureBinary, obscure, run } from "./lib/rclone.mjs";
import { SLOTS, StorageError, TYPES, env as storageEnv, newID, remoteName, validate, view } from "./lib/storages.mjs";

const env = process.env;
const required = ["PICODE_URL", "PICODE_EXT_TOKEN", "PICODE_EXT_DATA", "PICODE_EXT_PORT", "PICODE_EXT_PROXY_SECRET"];
if (Number(process.versions.node.split(".")[0]) < 22 || required.some((k) => !env[k])) {
  console.error("Start this storage from COGNIX[WS] (Node.js 22 or newer).");
  process.exit(1);
}
const secret = env.PICODE_EXT_PROXY_SECRET;
const dataDir = env.PICODE_EXT_DATA;
const host = new HostAPI({ url: env.PICODE_URL, token: env.PICODE_EXT_TOKEN, dataDir });

// rclone, downloaded once and checked (or a test's own).
let binary = null;
let binaryError = "";
const bin = () => {
  if (!binary) binary = ensureBinary(dataDir).catch((e) => { binary = null; binaryError = e.code === "unsupported-platform" ? "unsupported" : "download"; throw e; });
  return binary;
};

// The storages: one sealed secret per slot, written by this process. Read
// once; followed in memory as storages are added and removed here.
let slots = null; // slot → storage
async function load() {
  if (!slots) {
    const s = await host.request("/api/ext/v1/settings"); // throws while the host does not answer
    const next = {};
    for (const slot of SLOTS) {
      try { if (s?.secrets?.[slot]) next[slot] = JSON.parse(s.secrets[slot]); } catch { /* a damaged slot is free */ }
    }
    slots = next;
  }
  return slots;
}
const storages = async () => Object.values(await load());
const door = new Door({ storages, bin, dataDir });
// Pieces of uploads cut short by a stop are not kept.
rmSync(join(dataDir, "staging"), { recursive: true, force: true });

async function save(slot, storage) {
  const value = storage ? JSON.stringify(storage) : "";
  if (value.length > 4096) throw new StorageError("This storage's sign-in is too large to keep.");
  if (storage) await host.request(`/api/ext/v1/secrets/${slot}`, { method: "PUT", body: { value } });
  else await host.request(`/api/ext/v1/secrets/${slot}`, { method: "DELETE" });
  if (storage) slots[slot] = storage;
  else delete slots[slot];
  door.cached = null;
  await door.prune();
}

// ---- adding a storage ----
let signing = null; // { type, name, link, cancel }
let lastError = "";

async function add(input) {
  const s = validate(input);
  const all = await load();
  const slot = SLOTS.find((k) => !all[k]);
  if (!slot) throw new StorageError("Four storages at most: remove one to add another.");
  const b = await bin();
  const storage = { id: newID(), ...s };
  if (TYPES[s.type].signIn) {
    if (signing) signing.cancel();
    lastError = "";
    let linkSeen;
    const linkReady = new Promise((r) => { linkSeen = r; });
    const flow = authorize(b, baseEnv(dataDir), s.type, (link) => linkSeen(link));
    signing = { type: s.type, name: s.name, link: "", cancel: flow.cancel };
    const mine = signing;
    flow.done.then(async (token) => {
      if (signing !== mine) return; // cancelled, or another sign-in started
      storage.options = { token };
      if (s.type === "onedrive") Object.assign(storage.options, await oneDriveOf(token));
      await save(slot, storage);
      signing = null;
    }).catch(() => {
      if (signing === mine) { signing = null; lastError = "The sign-in did not finish. Try again."; }
    });
    const link = await Promise.race([linkReady, new Promise((r) => setTimeout(() => r(""), 15_000))]);
    if (!link) { flow.cancel(); signing = null; throw new StorageError("rclone did not start the sign-in. Try again."); }
    mine.link = link;
    return { link };
  }
  // A password storage: rclone keeps the password obscured, and the storage
  // must answer before it is kept.
  storage.options.pass = await obscure(b, baseEnv(dataDir), storage.options.pass);
  try {
    await run(b, ["lsf", remoteName(storage) + ":", "--max-depth", "1"], { env: { ...baseEnv(dataDir), ...storageEnv(storage) }, timeoutMs: 30_000 });
  } catch {
    throw new StorageError(s.type === "sftp" ? "The server refused this user and password, or did not answer." : "The address refused this user and password, or did not answer.");
  }
  await save(slot, storage);
  return { added: storage.id };
}

// oneDriveOf asks Microsoft which drive the token reaches (rclone needs it).
async function oneDriveOf(token) {
  const r = await fetch("https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType", { headers: { authorization: "Bearer " + token.access_token }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error("drive");
  const d = await r.json();
  if (!d.id || !d.driveType) throw new Error("drive");
  return { drive_id: d.id, drive_type: d.driveType };
}

async function remove(id) {
  const all = await load();
  const slot = SLOTS.find((k) => all[k]?.id === id);
  if (!slot) throw Object.assign(new StorageError("That storage is not here."), { status: 404 });
  await save(slot, null);
}

async function state() {
  let list = [];
  try { list = await storages(); } catch { return { ready: false, error: "COGNIX[WS] did not answer. Try again." }; }
  return {
    ready: true,
    storages: list.map(view),
    types: Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, signIn: !!t.signIn, fields: t.fields || [] })),
    slotsLeft: SLOTS.length - list.length,
    signingIn: signing ? { type: signing.type, name: signing.name, link: signing.link } : null,
    error: lastError || (binaryError === "unsupported" ? "rclone does not run on this computer's system." : binaryError === "download" ? "rclone could not be downloaded. Check the connection and try again." : ""),
  };
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
// The core sends the relay's secret as a header and as Basic picode:<secret>.
// The repositories ask for Basic: a page's relay sends only the header and
// must never reach them (ADR-0368, decision 13).
function basicOK(req) {
  const basic = /^Basic (.+)$/.exec(req.headers.authorization || "");
  return !!basic && same(Buffer.from(basic[1], "base64").toString(), "picode:" + secret);
}
function allowed(req, repositoryRoute) {
  if (repositoryRoute) return basicOK(req);
  return same(req.headers["x-picode-proxy-secret"] || "", secret) || basicOK(req);
}
const json = (res, code, value) => send(res, code, JSON.stringify(value), "application/json");

async function readJSON(req, limit = 16 << 10) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) return undefined; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return undefined; }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://storage").pathname;
    const repo = path.startsWith("/repo/");
    if (!allowed(req, repo)) return send(res, 401, "unauthorized");
    if (path === "/status" && req.method === "GET") return json(res, 200, await door.status());
    if (path === "/state" && req.method === "GET") return json(res, 200, await state());
    if (path === "/storages" && req.method === "POST") {
      const body = await readJSON(req);
      if (body === undefined) return json(res, 400, { error: "This request could not be read." });
      return json(res, 200, await add(body));
    }
    if (path === "/sign-in/cancel" && req.method === "POST") { signing?.cancel(); signing = null; return json(res, 200, await state()); }
    const del = /^\/storages\/([0-9a-f]{8})$/.exec(path);
    if (del && req.method === "DELETE") { await remove(del[1]); return json(res, 200, await state()); }
    const m = /^\/repo\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return send(res, 404, "not found");
    return await door.handle(req, res, m[1], m[2], m[3]);
  } catch (e) {
    if (e instanceof StorageError) return json(res, e.status || 400, { error: e.message });
    send(res, 502, "storage error");
  }
});
server.listen(Number(env.PICODE_EXT_PORT), "127.0.0.1");

function shutdown() { signing?.cancel(); door.stopAll(); server.close(); }
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT", () => { shutdown(); process.exit(0); });
