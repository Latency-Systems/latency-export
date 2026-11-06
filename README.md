# Latency collector

One file you run on your own machine. It reads usage and cost totals from your Anthropic organization and writes `latency-bundle.json` for your Latency audit.

Your key never leaves your machine. You see exactly what we see before you send it.

## What it reads, and what it doesn't

It calls two read only Anthropic endpoints, and nothing else:

* `GET /v1/organizations/analytics/usage` (token counts)
* `GET /v1/organizations/analytics/cost` (cost in USD)

It never sees prompts, outputs, conversations, or payment details. Those endpoints don't return them.

Before writing the file it:

* Replaces every ID and email with a salted hash
* Drops all names
* Checks that every value in the file is a number, a date, a hash, or a short label such as a model name, and stops if anything else slipped in (spaces, an `@`, anything that looks like a key)

The code is about 400 lines with no dependencies. Reading it takes under 10 minutes.

## Which key to use

| Your setup | Key | Where to create it |
|---|---|---|
| Claude Console (API) | Admin key, starts with `sk-ant-admin` | Console, Settings, Admin keys. Set it to expire after 1 day. |
| Claude Enterprise | Analytics key (`read:analytics` scope) | claude.ai, Organization settings, API. Primary owner only. |

If you have both, run once and add the second organization when the script asks.

Admin keys have no read only option. That's why the key stays with you: the script holds it in memory only, never writes it to disk or logs, and you can revoke it as soon as the run finishes.

## Run it

Requires Node 22 or newer. Use the exact command Latency sent you. It looks like this:

```
node latency-collect.mjs --audit <audit id> --salt <salt>
```

### Check your download (optional)

Each release lists a SHA256 fingerprint of `latency-collect.mjs`. Compare it with yours:

```
shasum -a 256 latency-collect.mjs
```

The same fingerprint is recorded in the bundle (`collector.sha256`), so we can confirm you ran the published version.

Paste the key when asked (the input is hidden). Most organizations finish in under five minutes.

You'll see a short summary: spend by month, model and product, cache usage, batch share. Then two files:

* `latency-bundle.json`: **send this one.** Open it first if you like.
* `latency-names.local.json`: **keep this one.** It maps the hashes back to your real IDs and emails, so you can tell who is who when we talk through findings. Don't send it.

Then revoke the key.

## Checking the file

Every string in `latency-bundle.json` is a date, a hash (`h_` followed by 32 hex characters), a label from Anthropic's API (model names, tiers, products), or an amount. Amounts are decimal strings in cents, exactly as Anthropic returns them: `"41280.000000"` is $412.80.

| Table | One row per | Holds |
|---|---|---|
| `usage_daily` | day, model, workspace, API key, service tier, region | tokens by type (uncached, cache write 5m and 1h, cache read, output), web searches, requests |
| `cost_daily` | same, split by cost type and token type | cost and list price |
| `people_daily` | day, person or service account, product, model | cost and requests |
| `modes_daily` | day, model, product, service tier, speed, context window | cost and requests |
| `month_total` | month | total cost, used to check the daily rows add up |

`collector.sha256` is a fingerprint of the script you ran, so we can confirm it matches the published version.

## Options

```
--months <n>        Full months to collect (default 3)
--out <file>        Bundle path
--names-out <file>  Name map path
--no-names          Skip the name map
--base-url <url>    API base URL (default https://api.anthropic.com)
--bearer            Send the key as a Bearer token (OAuth tokens)
```

Set `LATENCY_KEY` instead of pasting the key if you run it from a script.
