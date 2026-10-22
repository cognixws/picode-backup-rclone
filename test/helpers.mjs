// Test helpers: a stand-in for the COGNIX[WS] Host API (settings and the
// process's own secrets), this storage's process started the way COGNIX[WS]
// starts it with the rclone on this computer, and storages to point it at
// (rclone's own SFTP and WebDAV servers over a temporary folder).
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function hostStandIn(secrets) {
  const host = { secrets: { ...secrets }, writes: [] };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.headers["x-picode-extension-token"] !== "token") { res.writeHead(401).end(); return; }
      if (req.url === "/api/ext/v1/settings" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ values: {}, secrets: host.secrets }));
      }
      const m = /^\/api\/ext\/v1\/secrets\/([a-z0-9_]+)$/.exec(req.url);
      if (m) {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          if (req.method === "PUT") host.secrets[m[1]] = JSON.parse(Buffer.concat(chunks).toString()).value;
          else delete host.secrets[m[1]];
          host.writes.push(req.method + " " + m[1]);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(404).end();
    }).listen(0, "127.0.0.1", () => { server.host = host; resolve(server); });
  });
}

export async function storage(secrets = {}) {
  const host = await hostStandIn(secrets);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const secret = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PICODE_RCLONE_TEST_BIN: RCLONE, PICODE_URL: `http://127.0.0.1:${host.address().port}`, PICODE_EXT_TOKEN: "token", PICODE_EXT_DATA: mkdtempSync(join(tmpdir(), "gd-")), PICODE_EXT_PORT: String(port), PICODE_EXT_PROXY_SECRET: secret },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(url + "/status"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const headers = { "X-PiCode-Proxy-Secret": secret };
  const basic = { Authorization: "Basic " + Buffer.from("picode:" + secret).toString("base64") };
  const status = async () => (await fetch(url + "/status", { headers })).json();
  const page = async (path, method = "GET", body) => {
    const r = await fetch(url + path, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };
  return { url, secret, basic, status, page, host: host.host, stop: () => { child.kill(); host.close(); } };
}

export const RCLONE = process.env.RCLONE_BIN || execFileSync("sh", ["-c", "command -v rclone"]).toString().trim();

// serveRemote runs `rclone serve sftp|webdav` over a temporary folder: a
// storage to add, with its own user and password.
export async function serveRemote(kind) {
  const dir = mkdtempSync(join(tmpdir(), "rc-" + kind + "-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(RCLONE, ["serve", kind, dir, "--addr", "127.0.0.1:" + port, "--user", "tester", "--pass", "tester-pass", "--config", join(dir, "none.conf")], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
  return { dir, port, stop: () => child.kill() };
}
