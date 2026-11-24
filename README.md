# Open WebUI for Pollinations

[![Made with Pollinations](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai)

Pollinations deployment and integration for upstream Open WebUI. The runtime
image, database, accounts, chat history, OAuth registration and current domains
are retained from the monorepo deployment.

Hosted [Open WebUI](https://github.com/open-webui/open-webui) with Pollinations
as its **only** login provider. Users sign in with their Pollinations account;
the consent screen mints a budgeted `sk_` which Open WebUI forwards to
`gen.pollinations.ai` per user (`auth_type: system_oauth`), so every chat is
paid from the signed-in user's own wallet.

- Public: https://openwebui.pollinations.app (alias https://openwebui.myceli.ai)
- Legacy: https://openwebui.pollinations.ai redirects to the public hostname.
- Staging: https://openwebui-staging.elliot-b6e.workers.dev
- Login: OAuth 2.1 code + PKCE against the environment's Enter URL. Public
  client, no secret. Discovery is the RFC 8414 document; Pollinations serves no
  `openid-configuration` alias.

## Layout

| File | Role |
|------|------|
| `worker.js` | Container class with every Open WebUI setting as env vars, plus a keepalive cron |
| `ui-defaults.js` | Pinned models, prompt suggestions and banner new users see first |
| `scripts/apply-ui-defaults.mjs` | Write those defaults into an existing database through the admin API |
| `wrangler.jsonc` | Container (pre-built image), custom domains, staging env |
| `scripts/push-image.sh` | Mirror the upstream image into the Cloudflare registry |
| `scripts/push-secrets.mjs` | Push `secrets/secrets.vars.json` (sops) to the Worker |
| `.github/workflows/deploy.yml` | Checks pull requests; deploys the existing Worker from `production` |
| `scripts/verify.mjs` | Checks both production addresses and their database health |

No Dockerfile. Cloudflare cannot pull `ghcr.io`, so the upstream `-slim` image is
pushed once to `registry.cloudflare.com` and referenced from `wrangler.jsonc`.
Deploys then need no Docker, locally or in CI.

## State

Users, chats, configuration, and pgvector indexes live in Azure PostgreSQL.
Production and staging use separate databases. Container disk is ephemeral.
Uploaded files kept only on that disk need to be uploaded again after a restart.

RAG embeds locally with the bundled `sentence-transformers/all-MiniLM-L6-v2`
(`RAG_EMBEDDING_ENGINE` unset). RAG, image and audio all authenticate with a
single static key rather than the per-user OAuth token the chat connection uses,
so pointing them at gen would bill every user's documents to one wallet. The
cost is a ~90 MB model download onto the ephemeral disk after a restart.

Runtime secrets already stored on each Cloudflare Worker (the encrypted backup
is `secrets/secrets.vars.json`, with separate production and staging sections):

- `WEBUI_SECRET_KEY`: session signing key. Changing it logs everyone out.
- `DATABASE_URL`: Postgres connection string (staging uses its own database).

## Config vars are seeded once, not on every boot

Production uses Chat Completions; staging uses Responses with
`ENABLE_RESPONSES_API_STATEFUL=false`. Staging connects only to staging Gen
and staging Enter, and has no external MCP tool server. Both discover the full
model catalog (`MODEL_IDS=[]`). Managed agents' own configured MCP tools are independent of Open
WebUI's external tool servers.

Titles, tags and follow-up suggestions use `openai/gpt-5-nano`, not the selected
chat model. For existing databases, set `task.model.external` to that ID; this
global setting applies to existing users too.

On an existing staging database, also update `openai.api_base_urls`,
`openai.api_configs` (`api_type` and `model_ids`), and
`tool_server.connections` to match the staging configuration. Preserve
users/chats and unrelated settings. Restart the staging container to apply
the new OAuth environment. Its `OAUTH_CLIENT_ID` must be registered in staging
Enter; production client registrations do not exist in staging automatically.

Every setting in `DEFAULT_CONFIG` (`OPENAI_API_CONFIGS`, `TOOL_SERVER_CONNECTIONS`,
...) is written to the Postgres `config` table only when the key is *missing*:
`Config.seed_defaults` inserts new keys and `Config.get` reads the stored row
first. Editing one of those env vars on a database that has already booted does
nothing. Change the stored row instead, or use the admin API where one exists
(`POST /api/v1/retrieval/embedding/update` both writes the config and rebuilds
the in-memory embedding function, which a bare `UPDATE` does not):

```bash
ssh community-monitor "sudo docker exec openwebui-postgres \
  psql -U openwebui -d openwebui -c \
  \"select key, value::text from config where key = 'tool_server.connections';\""
```

## What a new user sees

The catalog behind the connection has 300+ entries, media and community models
included, so the defaults in [`ui-defaults.js`](ui-defaults.js) shape the first
minute:

- Four everyday models that need no paid balance are pinned for users who have
  not pinned any, and new chats open on `openai/gpt-5.4-nano`. The rest of the
  picker keeps the order gen serves it in.
- Four prompt suggestions replace the upstream ones.
- A dismissible banner links directly to the user's balance and top-up pages.
- No "share to Open WebUI Community" button (it uploads chats to openwebui.com)
  and no arena models.

Edit `ui-defaults.js` to change them. `worker.js` seeds them as env vars, which
Open WebUI reads only while the setting is missing (see above), so a database
that has already booted keeps the old values. Apply them with the admin API
instead; an admin key or JWT is needed, and the script reads each form before
changing it so `DEFAULT_MODEL_METADATA` (builtin tools off) is not reset:

```bash
OWUI_URL=https://openwebui.pollinations.app OWUI_ENTER_URL=https://enter.pollinations.ai OWUI_TOKEN=<admin key> node scripts/apply-ui-defaults.mjs
```

No restart is needed; users see the change on their next page load. A user's
own pins and settings are not overwritten.

## Restarting the container

`envVars` on the Container class are applied when the container *starts*, and a
`wrangler deploy` does not restart a running instance (nor does a shorter
`sleepAfter`). To force a fresh container, delete the container application and
deploy again. Users, chats and configuration remain in Postgres; uploaded
files on the ephemeral disk are lost, so check for files before restarting:

```bash
npx wrangler containers list                     # find the app id
npx wrangler containers delete <ID>
npx wrangler deploy --env staging                # retry once; the first
                                                 # attempt after a delete can
                                                 # fail on the durable object
```

The new container cold-starts in a few minutes while it pulls the ~1.5 GB image.
For production the deploy half must run through this repository’s
`Deploy / Cloudflare production` GitHub Actions workflow on `production`.

## Tool servers

`https://mcp.pollinations.ai/` (the endpoint is the root path; `/mcp` 404s) is
registered as an MCP tool server with `auth_type: system_oauth`, the same
per-user consent key as the model connection, so a generation started from a
tool call is billed to the signed-in user. Two fields are easy to miss:
`config.enable` must be true, and `config.access_grants` must carry an explicit
public read grant — an empty grant list means admin-only, not everyone.

That MCP server is opt-in per chat. Open WebUI's *builtin* tools are not: it
appends their specs to every request coming from its UI unless the model sets
`meta.capabilities.builtin_tools` false (`utils/middleware.py`). Models fetched
from a connection have no row in the `model` table, so the only lever is the
global default, `DEFAULT_MODEL_METADATA` / `models.default_metadata`, which
`utils/models.py` applies to them wholesale. We set it to
`{"capabilities": {"builtin_tools": false}}` — without it, managed agents and
community models that reject a `tools` field 400 on every UI chat.

`models.base_models_cache` is false and `Config.get_many` reads the row per
request, so changing that config row takes effect immediately, for existing
chats and users too. No container restart, no per-chat migration.

## Update the image

```bash
# Requires access to a Docker daemon.
npm run push-image -- 0.11.3
# then bump containers[].image in wrangler.jsonc (both envs)
```

## Development and deployment

```bash
npm ci --ignore-scripts
npm test
npm run check -- --env=""          # production dry run, no deployment
npm run check -- --env staging     # staging dry run, no deployment
npm run verify                    # read-only production health checks
```

Changes go through a pull request into `main`, then a separate promotion pull
request from `main` to `production`. A push to `production` deploys automatically;
manual runs must also select `production`. Pull requests and `main` only run
checks. Production deployment always runs through GitHub Actions.

The `production` GitHub environment needs `CLOUDFLARE_API_TOKEN` for the existing
Cloudflare account and Worker. Restrict that environment to the `production`
branch. The check job has no deployment credential; the deployment job installs
locked dependencies with lifecycle scripts disabled and exposes the token only
to Wrangler. The account ID is public configuration in the workflow.

Ordinary deploys retain the Worker’s existing `DATABASE_URL` and
`WEBUI_SECRET_KEY`. For an approved database connection change, use the
production workflow's `sync_database_url` and `cutover_test_ip` inputs.
Verify the app's database connection before dispatching without inputs to
restore general access.

Staging uses its own configuration and database. After deploying with
`npm run deploy:staging`, check `/health` and `/health/db` on its staging URL.

The Cloudflare `pollinations.app` zone has an exact `openwebui.pollinations.app/*`
route with no Worker assigned. It lets the Open WebUI custom domain handle
requests to that hostname while Gen serves its wildcard route.

Run `npm run verify -- --redirect` to check both live hostnames and the legacy
redirect.

To roll back a code change, revert it through `main` and promote the revert to
`production`. An immediate Worker rollback requires a recorded version that
uses the current Azure database.

## Placement

Production Cloudflare containers are constrained to `ENAM`. Azure PostgreSQL
runs in Sweden Central. If Cloudflare replaces the container, verify its egress
address and the Azure PostgreSQL firewall rule, then check `/health/db`.

## Login requirements on the Pollinations side

- The production App Key (`pk_`) needs the exact callback URI
  `https://openwebui.pollinations.app/oauth/oidc/callback`. Staging has its own
  App Key and callback.
- `OAUTH_CLIENT_SECRET` stays empty. With a secret, authlib switches to Basic
  auth and drops `client_id` from the token request, which the Pollinations
  token endpoint rejects.
- `OAUTH_SCOPES=profile`: email is only returned with that scope. A user who
  unticks "profile" on the consent screen cannot log in.
- There is no refresh grant. The consent key expiry (`OAUTH_AUTHORIZE_PARAMS`)
  is the re-login interval for API access.

## Source and attribution

Extracted from [Pollinations’ Open WebUI integration at `7689807758`](https://github.com/pollinations/pollinations/tree/76898077586a6047046772e3566fcb27307cc1ae/apps/openwebui).
[Earlier integration history and contributors](https://github.com/pollinations/pollinations/commits/76898077586a6047046772e3566fcb27307cc1ae/apps/openwebui)
remain available in the original repository. This integration is MIT licensed;
[upstream Open WebUI](https://github.com/open-webui/open-webui) retains its own
license and attribution. This repository consumes its pre-built image.
