# Security

This file is for the engineer or security reviewer deciding whether to run the Latency usage export.

## What it does

`latency-export.mjs` is one file, about 400 lines, with no dependencies. Reading it takes under 10 minutes.

1. Asks for your key in a hidden prompt. The key stays in memory. It is never written to disk, printed, logged, or put in the output.
2. Makes read only `GET` requests to two Anthropic endpoints, and nothing else:
   * `/v1/organizations/analytics/usage` (token counts)
   * `/v1/organizations/analytics/cost` (cost in USD)
3. Replaces every workspace ID, API key ID, user ID and email with a salted hash. Drops all names.
4. Writes two files in the current folder:
   * `latency-bundle.json`, the file you send. See [`sample-bundle.json`](sample-bundle.json) for exactly what it looks like.
   * `latency-names.local.json`, which maps hashes back to real names. It is created readable only by you, and it stays with you.

## What it never does

* Sends anything anywhere except the two Anthropic endpoints above. There is no telemetry and no call to any Latency server. You send the file yourself, if you choose to.
* Reads prompts, outputs, conversations, files, or payment details. The endpoints don't return them.
* Changes anything in your Anthropic organization. It only reads.
* Runs other programs or writes outside the two output files.

## Checks built into the code

* Requests to any host other than the base URL are blocked, and the base URL must use HTTPS.
* Before writing, the script checks the whole bundle and refuses to write it if it finds your key, anything that looks like an Anthropic key, an `@`, or any text that isn't a number, date, hash, or short API label.
* The SHA256 of the script is recorded in the bundle, so we can confirm you ran the published version.

## About the key

Anthropic's usage and cost endpoints require an Admin key, and Anthropic offers no read only scope for them. That's why the key never leaves your machine. We recommend:

* Create a key just for this run and set it to expire after 1 day.
* Revoke it as soon as the run finishes.
* For Claude Enterprise, use an Analytics key (`read:analytics` scope) instead.

## Verify your download

```
shasum -a 256 latency-export.mjs
```

Compare it with the fingerprint on the release page.

## Optional: restrict file access

On Node 22.13 or newer you can run the script with Node's permission model, so it can only write in the current folder:

```
node --permission --allow-fs-read=. --allow-fs-write=. latency-export.mjs --audit <id> --salt <salt>
```

This limits file access only. Node 22 does not restrict network access this way.

## Reporting a problem

Email kevin@latency.systems with "Security" in the subject. We reply within one business day.
