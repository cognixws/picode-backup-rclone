# More storage for COGNIX[WS] backups (rclone)

A COGNIX[WS] extension that keeps encrypted copies of your backups in
**Dropbox**, **OneDrive**, an **SFTP server** or **WebDAV** (Nextcloud,
ownCloud and others), through [rclone](https://rclone.org).

COGNIX[WS] encrypts and deduplicates every copy on your computer before it
reaches this extension (ADR-0368). Each storage holds only encrypted objects
named by their hash: it can lose a copy, and COGNIX[WS]'s checks will find it,
but it cannot read or change one.

## Set up

1. In COGNIX[WS], open **Backups → Destinations → Add destination** and
   install **More storage (rclone)**, or install this repository from
   **Extensions**.
2. Open the extension's page and add a storage (up to four):
   - **Dropbox** or **OneDrive**: your browser opens the storage's sign-in for
     rclone; allow it.
   - **SFTP server** or **WebDAV**: type the address, the user and the
     password. An SFTP server's key is recorded when you add it and checked on
     every connection after.
3. Back in **Add destination**, choose **More storage (rclone)** and the
   storage.

Removing a storage on the page stops copies there; the copies already there
stay.

## How it works

- **rclone 1.74.3**, downloaded once from rclone's GitHub release and checked
  against the SHA-256 rclone publishes. A new rclone is a new version of this
  extension.
- Each storage runs its own `rclone serve restic` on this computer only, with
  credentials kept in its environment (never on a command line); the
  extension passes COGNIX[WS]'s requests to it and passes back only status
  codes.
- Each storage is a sealed secret the extension keeps itself in COGNIX[WS]'s
  encrypted store, handed to rclone through environment variables: no rclone
  config file is read or written, and the page never sees a password or a
  sign-in.
- Every object is kept in a file of the extension's own until all of it
  arrived and its SHA-256 matches its name; only then does rclone send it, so
  a cut upload or a wrong body never reaches a storage.

## Test

```bash
node --test test/*.test.mjs
```

The tests need `rclone` on the PATH (and `ssh-keygen`, `ssh-keyscan`). They
run COGNIX[WS]'s conformance kit through rclone to SFTP and WebDAV servers that
rclone itself serves from a temporary folder.

## License

Apache-2.0. rclone is MIT licensed and downloaded, not bundled.
