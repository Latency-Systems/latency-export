# Security

This file is for the engineer or security reviewer deciding whether to run the Latency usage export.

## What it does

`latency-export.mjs` is one file, about 400 lines, with no dependencies. Reading it takes under 10 minutes.

1. Asks for your key in a hidden prompt. The key stays in memory. It is never written to disk, printed, logged, or put in the output.
2. Makes read only `GET` requests to two Anthropic endpoints, and nothing else:
   * `/v1/organizations/analytics/usage` (token counts)
   * `/v1/organizations/analytics/cost` (cost in USD)
3. Replaces every workspace ID, API key ID, user ID and email with a salted hash. Drops all names.
4. Writes two files, in the current folder unless you choose other paths with `--out` and `--names-out`:
   * `latency-bundle.json`, the file you send. See [`sample-bundle.json`](sample-bundle.json) for exactly what it looks like (made up data). `"final": false` and the matching warning mean the latest month is still being revised by Anthropic, which happens until about the 7th of the next month.
   * `latency-names.local.json`, which maps hashes back to real names. It is created readable only by you, and it stays with you.

## What it never does

* Sends anything anywhere except the two Anthropic endpoints above. There is no telemetry and no call to any Latency server. You send the file yourself, if you choose to.
* Reads prompts, outputs, conversations, files, or payment details. The endpoints don't return them.
* Changes anything in your Anthropic organization. It only reads.
* Runs other programs or writes any file other than those two.

## Checks built into the code

* It only ever requests one base URL, `https://api.anthropic.com` by default. A different base URL must use HTTPS (plain HTTP is allowed only for `localhost`, for testing).
* Before writing, the script checks the whole bundle and refuses to write it if it finds your key, anything that looks like an Anthropic key, an `@`, or any text that isn't a number, date, hash, or short API label.
* The SHA256 of the script is recorded in the bundle, so we can confirm you ran the published version.

## About the key

There is no read only key for Anthropic's usage and cost endpoints. That's why the key never leaves your machine.

Two key types work on Claude Console organizations:

* **Your own API key, not tied to a workspace** (`sk-ant-usr`). It carries only your own permissions, and a Developer role is enough. This is the smaller ask. We tested it on Nov 20, 2026 with a Developer member and got the same data as an Admin key. Anthropic's docs currently describe Admin credentials for these endpoints, so if it ever stops working, use an Admin key.
* **An Admin key** (`sk-ant-admin`), created by an organization admin.

Whichever you use:

* Create a key just for this run and set it to expire after 1 day.
* Revoke it as soon as the run finishes.
* For Claude Enterprise, use an Analytics key (`read:analytics` scope) instead.

## Verify your download

```
shasum -a 256 latency-export.mjs
```

Compare it with the fingerprint listed on the release page for your version. The same fingerprint is recorded in the bundle, so we can confirm it too.

If you install from npm (`npx @latency-systems/export`), each version is published from this repository by GitHub Actions with npm provenance. To check the signatures:

```
npm audit signatures
```

Provenance proves which commit and workflow built the package. It doesn't prove the code is safe, so reading it is still the real check.

## Optional: restrict file access

On Node 22.13 or newer you can run the script with Node's permission model, so it can only write in the current folder:

```
node --permission --allow-fs-read=. --allow-fs-write=. latency-export.mjs --audit <id> --salt <salt>
```

This limits file access only. Node 22 does not restrict network access this way.

## After you send the file

How we use, protect and delete your data, and how to opt out of anonymous benchmarks, is covered in our [audit terms](https://latency.systems/audit-terms). A plain summary is at [latency.systems/usage-export](https://latency.systems/usage-export).

## Reporting a problem

Email kevin@latency.systems with "Security" in the subject. We reply within one business day.
