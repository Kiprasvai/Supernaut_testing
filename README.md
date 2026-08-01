# PocketBase app

This repository contains a Supernaut-managed PocketBase app.

- `pb_migrations/` stores PocketBase schema migrations.
- `pb_hooks/` stores PocketBase JavaScript hooks.
- `pb_public/` stores optional static fallback files served by PocketBase.
- `public/` stores the built frontend assets deployed as a Cloudflare static Worker.

PocketBase runtime data lives on the managed Fly.io volume and should not be committed.
The browser frontend is hosted separately on Cloudflare and calls the Fly.io PocketBase API URL explicitly.

## Grounded Q&A configuration

Set `OPENROUTER_API_KEY` in the managed backend environment to enable the server-only grounded Q&A route. `OPENROUTER_MODEL` is optional and defaults to `meta-llama/llama-3.1-8b-instruct:free`.
