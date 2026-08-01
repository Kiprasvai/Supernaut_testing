# Agent Instructions

This repository is a Supernaut-managed PocketBase app. Follow these rules when editing it.

## Stack boundaries

- Use PocketBase for the backend and persistence.
- Do not add another backend runtime or database such as Express, Workers, D1, Postgres, Rails, Django, Go, or Python unless the user explicitly asks to leave the managed stack.
- Backend schema changes belong in `pb_migrations/`.
- Backend behavior belongs in `pb_hooks/`.
- Optional static fallback assets served by PocketBase belong in `pb_public/`.
- Frontend source, if added, must be TypeScript or JavaScript and must build into `public/` for Cloudflare static Worker deployment.
- Browser code must use an explicit PocketBase API URL, normally `VITE_POCKETBASE_URL`; do not assume the frontend and API share an origin.
- The production frontend is deployed with Supernaut's Cloudflare static Worker/custom-domain flow. The PocketBase API remains on Fly.io.
- Do not mention PocketBase in user-facing frontend or landing page copy; it is an internal implementation tool.
- Do not add user-facing links, buttons, or navigation to the PocketBase admin UI.

## Payments (platform-managed)

Payments are managed by the Supernaut platform through Stripe. The platform owns these PocketBase collections: `supernaut_payments_settings`, `supernaut_products`, `supernaut_customers`, `supernaut_subscriptions`, `supernaut_payments`.

- Never create, modify, rename, or delete these collections, their fields, rules, or indexes in migrations or hooks — the platform provisions and maintains them.
- Render pricing and Buy/Subscribe buttons from the `supernaut_products` collection; `payment_link_url` holds the checkout URL. Never hardcode payment link URLs, amounts, or Stripe ids in code: the platform swaps links when the company goes from test to live mode, without a redeploy.
- Read the single `supernaut_payments_settings` row for the current mode (`test` or `live`); show a discreet test-mode indicator while in test mode.
- Gate premium features by querying `supernaut_subscriptions` filtered by the logged-in user's email: status `active` or `trialing` means entitled; `past_due`/`canceled` means locked. For one-time purchases, check `supernaut_payments` (status `paid`) by customer email.
- These collections are read-only for app code and app users; per-customer rows are visible only to the authed user whose email matches.
- Do not mention Stripe in user-facing copy beyond the checkout handoff.

## Deployment files

- Keep `fly.toml` and `Dockerfile.supernaut-pocketbase` in the repo.
- Keep `wrangler.toml` when a frontend exists; it configures the Cloudflare static asset deploy.
- Do not commit `pb_data/`; it is persisted on the Fly volume.
- Do not replace or remove the `pb_data` volume during redeploys.

## Migration safety

PocketBase migrations run against persistent data. Never assume the database is empty.

- Before creating a collection, check whether it already exists.
- If the collection exists, update it instead of creating it again.
- Do not write migrations that fail when a collection already exists.
- Do not reset or delete existing collections/data unless the user explicitly asks for destructive reset behavior.
- A migration file runs only once. PocketBase records each applied migration by file name in the internal `_migrations` table and never re-runs it. On `serve` it applies only files it has not already recorded, so editing a migration that already ran on the live volume is a silent no-op — the schema change never reaches the running database.
- To change schema after a migration has shipped, add a NEW migration file with a later timestamp. Never edit an already-applied migration to fix a live app; the `pb_data` volume persists across redeploys, so the old schema stays.
- If a migration fails partway (for example the machine is killed mid-run), it is NOT recorded as applied and runs again on the next boot. A migration that failed after already creating a collection, field, or index will then abort startup with "already exists" and the app never comes up. Every operation must be safe to re-run: guard collection AND index creation with existence checks (create only when missing), never blindly create an index that a prior partial run may have created.

Example pattern. Fields use typed constructors (`new TextField(...)`, `new NumberField(...)`, `new DateField(...)`, `new SelectField(...)`, `new BoolField(...)`, `new RelationField(...)`, etc.) — do not assign plain `{ name, type }` object literals to `.fields`, that is pre-0.23 syntax and will crash `app.save` on this PocketBase version:

```js
migrate((app) => {
  let collection;
  try {
    collection = app.findCollectionByNameOrId("cards");
  } catch {
    collection = new Collection({
      name: "cards",
      type: "base",
    });
  }

  collection.fields = [
    new TextField({ name: "title", required: true, max: 160 }),
    new NumberField({ name: "amount", required: true, min: 0 }),
  ];

  // Add or update indexes/rules here.
  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("cards");
  return app.delete(collection);
});
```

## Seeding data

Migrations run at boot, before PocketBase starts serving. A slow seed blocks startup and fails the health check, which marks the deploy failed and boot-loops: the migration never records as applied, so it re-runs on every restart and never converges. Keep seeds fast and idempotent.

- Seed with bulk multi-row inserts, never one row at a time. Do not loop per-row lookups and `save`/`INSERT` across hundreds of rows — build a single batched `INSERT ... VALUES (...),(...),...` (or a small number of them) with `app.db()`. A per-row loop over hundreds of rows will time out on the shared VM.
- Make the seed a no-op on redeploy: guard on existing data (e.g. skip when the target collection already has rows) instead of re-inserting.
- Do not seed large or derived datasets in a boot migration. If you need hundreds+ of rows, insert them in bulk in as few statements as possible, or load them lazily at runtime — never with a per-row loop that runs at startup.

## Backend hooks (pb_hooks)

PocketBase runs each hook handler in its own isolated JavaScript VM at request time. A handler callback — the function passed to `routerAdd`, `onRecordCreateRequest`, `onRecordAfterCreateSuccess`, and similar — cannot see functions or variables declared at the top level of the hook file.

- Do not call a module-scope helper from inside a handler. At request time the helper is not defined, and the request fails with an opaque generic 400.
- Define helper logic inside the handler, or load it with `require()` INSIDE the handler body:

```js
routerAdd("POST", "/api/transactions/validate", (e) => {
  const { validateTransaction } = require(__hooks + "/utils.js");
  // use validateTransaction(...) here
});
```

- Keep shared helpers in a file under `pb_hooks/` and `require()` them inside every handler that needs them. Never rely on closure over the hook file's top-level scope.

## Test locally before redeploying

Redeploying the Fly.io backend is slow. Do not use live redeploys as your debug loop — reproduce and fix the problem locally first, then deploy once.

- Run the real PocketBase binary locally against this repo's `pb_migrations/` and `pb_hooks/`, then exercise the actual request (for example `curl` a record create) against the local server.
- Migration failures and hook handler errors only surface when a request runs against a running server; a passing build or type-check will not catch them.
- A fresh local data dir applies every migration from scratch and will pass even when the live volume is broken, because live already recorded the old migrations and skips them. So a clean local run does not prove a schema change reached production — when altering existing schema, add a new migration rather than editing an old one.
- Redeploy only after the create/read/update/delete path works locally.

## Verifying changes

A change is not done until the real data path works on the deployed backend.

- After a deploy or redeploy, confirm the migration actually applied on the live instance. A migration committed to `pb_migrations/` is not the same as one applied to the running database. Check this with the `query-pocketbase` tool (read-only, answers in seconds): `list_collections` shows the live schema, and `count_records`/`list_records` with a filter shows whether a data migration or backfill actually reached the rows it targeted.
- Smoke-test the deployed path ONCE by creating and then deleting a record through the live API — two calls, seconds. The slow part is the deploy, which the local loop above keeps to a single round; this final check is not a debug loop. A passing build, a healthy container, or a page that loads do not prove that create/read/update/delete works. This is the one check `query-pocketbase` cannot replace: the tool reads with platform superuser access and bypasses collection API rules, so only a real client call proves the public CRUD path works.
- Always delete the record you created, whether or not the collection already holds real data — never leave a test record in production. Use one fixed, obviously-fake value for every smoke test instead of inventing a new one per feature or run, for example the email `smoketest@pocketbase-check.invalid` (the `.invalid` TLD is reserved by RFC 2606 and can never belong to a real user). Reusing the same value means any record a previous run failed to clean up is easy to spot later, and a create call failing with "already exists" is a signal that a prior smoke test left a record behind — delete the stale record first, then continue.
- After deleting, re-fetch or list the record to confirm it is actually gone; do not assume a 200/204 response means the delete took effect.
- When live data looks wrong, inspect it with `query-pocketbase` (filtered `list_records`, `count_records`, or `list_logs` for request errors). Never deploy temporary diagnostic routes, hooks, or log statements just to look at data — that costs two full deploys per look (add, then remove).

Add future project-specific rules to this file.
