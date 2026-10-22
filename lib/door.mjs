// The storage door COGNIX[WS] calls (ADR-0368, decision 10). Each storage
// the person added runs its own `rclone serve restic` on loopback, with
// credentials only this process knows; the door answers under
// /repo/{connection}/{repository}/ by passing each request to that server.
// rclone keeps the repositories with restic's own layout; COGNIX[WS]
// encrypts and checks everything, and only a status code of rclone's
// answers reaches it.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { baseEnv, run } from "./rclone.mjs";
import { connectionOf, env as storageEnv, remoteName } from "./storages.mjs";

const SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

export function send(res, code, body = "", type = "text/plain") {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// stage keeps an object's body in a file of the extension's own until the
// whole of it arrived and its SHA-256 is its name: an upload the core cuts
// short, or a body that is not its name, never reaches the storage (rclone
// writes SFTP and WebDAV objects in place, as they arrive).
async function stage(req, dir, name, size) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, randomBytes(8).toString("hex") + ".part");
  const h = createHash("sha256");
  try {
    await pipeline(req, async function* (source) { for await (const c of source) { h.update(c); yield c; } }, createWriteStream(file, { mode: 0o600 }));
    if (statSync(file).size !== size || h.digest("hex") !== name) throw new Error("the body is not its name");
    return file;
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
}

export class Door {
  // storages() answers the storages; bin() rclone's path.
  constructor({ storages, bin, dataDir, hostKeys = async () => "", statusTTL = 60_000, statusWaitMs = 2_500 }) {
    this.hostKeys = hostKeys;
    this.storages = storages;
    this.bin = bin;
    this.dataDir = dataDir;
    this.statusTTL = statusTTL;
    this.statusWaitMs = statusWaitMs;
    this.servers = new Map(); // storage id → { child, port, auth, key }
    this.cached = null;
    this.inflight = null;
  }

  server(storage) {
    const key = JSON.stringify([storage.type, storage.folder, storage.appendOnly, storage.options]);
    const have = this.servers.get(storage.id);
    if (have && have.key === key && !have.dead) return have.ready;
    if (have) have.stop();
    // The entry is in the map before anything waits: concurrent first
    // requests share one server.
    const entry = { key, dead: false, child: null, stop() { this.dead = true; this.child?.kill(); } };
    this.servers.set(storage.id, entry);
    entry.ready = this.start(storage, entry).catch((e) => { entry.stop(); if (this.servers.get(storage.id) === entry) this.servers.delete(storage.id); throw e; });
    return entry.ready;
  }

  async start(storage, entry) {
    const bin = await this.bin();
    const port = await freePort();
    if (entry.dead) throw new Error("stopped");
    const auth = randomBytes(18).toString("base64url");
    const args = ["serve", "restic", remoteName(storage) + ":" + storage.folder, "--addr", "127.0.0.1:" + port, "--log-level", "ERROR"];
    if (storage.appendOnly) args.push("--append-only");
    // The server's own credentials go in its environment, never on its
    // command line, where any local user could read them.
    const child = spawn(bin, args, { env: { ...baseEnv(), ...storageEnv(storage, await this.hostKeys(storage)), RCLONE_USER: "picode", RCLONE_PASS: auth }, stdio: ["ignore", "ignore", "pipe"] });
    Object.assign(entry, { child, port, auth });
    child.on("error", () => { entry.dead = true; });
    child.stderr.resume(); // rclone's words stay here
    child.on("exit", () => { entry.dead = true; if (this.servers.get(storage.id) === entry) this.servers.delete(storage.id); });
    for (let i = 0; i < 100; i++) {
      if (entry.dead) throw new Error("rclone stopped");
      const ok = await new Promise((r) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", agent, timeout: 500 }, (res) => { res.resume(); r(true); });
        req.on("error", () => r(false));
        req.on("timeout", () => { req.destroy(); r(false); });
      });
      if (ok) return entry;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("rclone did not start");
  }

  stopAll() {
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
  }

  // forget stops the servers of storages that are gone.
  async prune() {
    const ids = new Set((await this.storages()).map((s) => s.id));
    for (const [id, s] of this.servers) if (!ids.has(id)) { s.stop(); this.servers.delete(id); }
  }

  async status() {
    const list = await this.storages();
    if (!list.length) return { state: "needs-setup", next: "settings", connections: [] };
    if (this.cached && this.cached.key === JSON.stringify(list.map((s) => [s.id, s.folder, s.appendOnly])) && Date.now() - this.cached.at < (this.cached.value.state === "ready" ? this.statusTTL : 5_000)) return this.cached.value;
    if (!this.inflight) {
      const key = JSON.stringify(list.map((s) => [s.id, s.folder, s.appendOnly]));
      this.inflight = this.probe(list).then((value) => { this.cached = { key, at: Date.now(), value }; return value; }).finally(() => { this.inflight = null; });
    }
    // COGNIX[WS] waits three seconds for a status: a slow storage answers
    // what was last known, and the look goes on to be read next time.
    const late = new Promise((r) => setTimeout(() => r(null), this.statusWaitMs).unref());
    const value = await Promise.race([this.inflight, late]);
    if (value) return value;
    if (this.cached) return this.cached.value;
    return { state: "needs-attention", next: "retry", connections: [] };
  }

  // probe lists each storage's folder: it proves the storage answers and
  // names the repositories already there. Storages that fail are left out;
  // with none left, the person is asked to look at the extension.
  async probe(list) {
    const bin = await this.bin();
    const connections = [];
    let failures = 0;
    for (const s of list) {
      try {
        const out = await run(bin, ["lsf", remoteName(s) + ":" + s.folder, "--dirs-only", "--max-depth", "1"], { env: { ...baseEnv(), ...storageEnv(s, await this.hostKeys(s)) }, timeoutMs: 20_000 });
        const repositories = out.split("\n").map((l) => l.trim().replace(/\/$/, "")).filter((n) => SEGMENT.test(n)).slice(0, 64);
        connections.push({ ...connectionOf(s), deleteAllowed: !s.appendOnly, repositories });
      } catch (e) {
        // A folder that does not exist yet is an empty place.
        if (/directory not found/i.test(e.stderr || "")) connections.push({ ...connectionOf(s), deleteAllowed: !s.appendOnly, repositories: [] });
        else failures++;
      }
    }
    if (!connections.length && failures) return { state: "needs-attention", next: "settings", connections: [] };
    return { state: "ready", connections };
  }

  // handle passes one repository request to its storage's server.
  async handle(req, res, connection, repo, rest) {
    // Only restic's own routes, spelled plainly: nothing escaped, so a body
    // always meets the check its name calls for.
    if (!SEGMENT.test(repo) || !/^\/(|config|(data|index|snapshots|keys|locks)\/([0-9a-f]{64})?)$/.test(rest)) return send(res, 404, "not found");
    const storage = (await this.storages()).find((s) => connectionOf(s).id === connection);
    if (!storage) return send(res, 404, "not found");
    let srv;
    try { srv = await this.server(storage); } catch { req.resume(); return send(res, 502, "storage error"); }
    const object = req.method === "POST" && /^\/(data|index|snapshots|keys|locks)\/([0-9a-f]{64})$/.exec(rest);
    let staged = "";
    if (object) {
      const size = Number(req.headers["content-length"]);
      if (!(Number.isSafeInteger(size) && size >= 0 && size <= 64 << 20)) { req.resume(); return send(res, 400, "size"); }
      try { staged = await stage(req, join(this.dataDir, "staging"), object[2], size); }
      catch (e) { return send(res, e.message === "the body is not its name" || req.aborted ? 400 : 502, "body"); }
    }
    const url = new URL(req.url, "http://storage");
    const headers = { authorization: "Basic " + Buffer.from("picode:" + srv.auth).toString("base64") };
    for (const h of ["content-length", "content-type", "range", "accept"]) if (req.headers[h]) headers[h] = req.headers[h];
    const up = http.request({ host: "127.0.0.1", port: srv.port, method: req.method, path: "/" + repo + rest + url.search, headers, agent }, (r) => {
      if (res.destroyed) { r.destroy(); return; }
      if (r.statusCode >= 300) {
        r.resume();
        // Only rclone's status code travels, never its words.
        return send(res, r.statusCode === 401 ? 502 : r.statusCode, "");
      }
      const out = {};
      for (const h of ["content-type", "content-length", "content-range"]) if (r.headers[h]) out[h] = r.headers[h];
      res.writeHead(r.statusCode, out);
      r.on("error", () => res.destroy());
      r.pipe(res);
    });
    up.on("error", () => send(res, 502, "storage error"));
    // The core cancelled (a read stopped, a copy paused): rclone's request
    // ends now, before or after it answered, and its socket is freed.
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    if (staged) {
      const body = createReadStream(staged);
      const clean = () => rmSync(staged, { force: true });
      up.on("close", clean);
      body.on("error", () => up.destroy());
      body.pipe(up);
      return;
    }
    // Anything else (config, a listing, a read) goes as it comes; a request
    // the core cancels ends rclone's at once.
    req.on("close", () => { if (!req.complete) up.destroy(); });
    req.pipe(up);
  }
}
