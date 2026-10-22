// The storages a person adds on the extension's page. Each is one rclone
// remote, kept as a sealed secret this process writes itself (storage_1 …
// storage_4) and handed to rclone through RCLONE_CONFIG_<NAME>_<KEY>, never
// through a config file.
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const SLOTS = ["storage_1", "storage_2", "storage_3", "storage_4"];
export const DEFAULT_FOLDER = "COGNIX[WS] backups";

// TYPES: what the page offers. sign-in types run rclone's own sign-in;
// the others ask for their fields.
export const TYPES = {
  dropbox: { label: "Dropbox", signIn: true },
  onedrive: { label: "OneDrive", signIn: true },
  sftp: { label: "SFTP server", fields: ["host", "port", "user", "password"] },
  webdav: { label: "WebDAV (Nextcloud, ownCloud and others)", fields: ["url", "vendor", "user", "password"] },
};

export class StorageError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const NAME = /^[\p{L}\p{N} ._-]{1,40}$/u;
const FOLDER_SEGMENT = /^[\p{L}\p{N} ._()[\]-]{1,100}$/u;

export function cleanFolder(value) {
  const text = String(value ?? "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_FOLDER;
  const parts = text.split("/");
  if (parts.length > 6 || parts.some((p) => !FOLDER_SEGMENT.test(p) || p === "." || p === "..")) throw new StorageError("A folder is up to 6 names of letters, digits, spaces, dots, brackets or hyphens, separated by /.");
  return parts.join("/");
}

// validate checks what the page sent for a storage and answers the fields
// to keep (passwords still plain: the caller obscures them).
export function validate(input) {
  const type = String(input?.type || "");
  const t = TYPES[type];
  if (!t) throw new StorageError("Choose a kind of storage.");
  const name = String(input?.name || t.label.split(" (")[0]).trim();
  if (!NAME.test(name)) throw new StorageError("Name the storage with up to 40 letters, digits, spaces, dots or hyphens.");
  const folder = cleanFolder(input?.folder);
  const f = input?.fields || {};
  const out = { type, name, folder, appendOnly: input?.appendOnly === true, options: {} };
  if (type === "sftp") {
    const host = String(f.host || "").trim();
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new StorageError("Write the server's host name or address.");
    const port = Number(f.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StorageError("A port is a number from 1 to 65535.");
    const user = String(f.user || "").trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new StorageError("Write the user name on that server.");
    if (!f.password || String(f.password).length > 512 || /[\r\n]/.test(f.password)) throw new StorageError("Write the password for that user (one line).");
    out.options = { host, port: String(port), user, pass: String(f.password) };
  }
  if (type === "webdav") {
    let url;
    try { url = new URL(String(f.url || "").trim()); } catch { throw new StorageError("Write the WebDAV address, like https://cloud.example.com/remote.php/dav/files/you."); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && homeAddress(url.hostname))) throw new StorageError("Use an https:// address (plain http only for this computer or your home network).");
    if (url.username || url.password) throw new StorageError("Write the user and password in their own fields, not in the address.");
    const vendor = ["nextcloud", "owncloud", "other"].includes(f.vendor) ? f.vendor : "other";
    const user = String(f.user || "").trim();
    if (!user || user.length > 128) throw new StorageError("Write the user name.");
    if (!f.password || String(f.password).length > 512 || /[\r\n]/.test(f.password)) throw new StorageError("Write the password (an app password, for Nextcloud), on one line.");
    out.options = { url: url.toString().replace(/\/$/, ""), vendor, user, pass: String(f.password) };
  }
  return out;
}

// homeAddress: this computer or a private network address, judged by the
// exact name or the address itself, never a prefix of a name.
function homeAddress(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost") return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return isIP(h) === 6 && (h === "::1" || /^f[cd]/.test(h));
}

export function newID() { return randomBytes(4).toString("hex"); }

export function remoteName(storage) { return "S" + storage.id.toUpperCase(); }

// env answers the variables that define a storage's remote for rclone;
// knownHosts is the file of an SFTP server's keys, when they were recorded.
export function env(storage, knownHosts = "") {
  const prefix = "RCLONE_CONFIG_" + remoteName(storage) + "_";
  const out = { [prefix + "TYPE"]: storage.type };
  for (const [k, v] of Object.entries(storage.options || {})) out[prefix + k.toUpperCase()] = typeof v === "string" ? v : JSON.stringify(v);
  if (storage.type === "sftp" && knownHosts) out[prefix + "KNOWN_HOSTS_FILE"] = knownHosts;
  return out;
}

// lean keeps what a sign-in needs to last: the refresh token (rclone gets a
// fresh access token on first use), so even a work account's fits a secret.
export function lean(token) {
  return { ...token, access_token: "", expiry: "2000-01-01T00:00:00Z" };
}

// connectionOf is the place this storage offers COGNIX[WS]: its id follows
// the storage, never its name, so renaming one keeps its destinations.
export function connectionOf(storage) {
  const id = "rc-" + createHash("sha256").update(storage.id).digest("hex").slice(0, 16);
  const text = storage.name + " · " + storage.folder;
  return { id, label: [...text].length <= 80 ? text : [...text].slice(0, 79).join("") + "…" };
}

// view is what the page sees of a storage: never a token or a password.
export function view(storage) {
  return { id: storage.id, type: storage.type, kind: TYPES[storage.type]?.label || storage.type, name: storage.name, folder: storage.folder, appendOnly: !!storage.appendOnly };
}
