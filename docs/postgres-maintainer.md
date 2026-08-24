# PostgreSQL Backend (Maintainer Doc)

> **Supported for the maintainer, not part of the 0.x preview.** The preview
> path is SQLite (`DATABASE_TYPE=sqlite`, the default). The Postgres backend
> works and is what the maintainer's own deployment runs, but it is not part
> of the documented fresh-install path: its test coverage is asymmetric
> (adapter-level against a mocked pool in the main suite, plus the env-gated
> executed-SQL suite — see CONTRIBUTING.md), and the quick-start tooling
> (`npm run backup` / `restore:verify`) is SQLite-only. If you are not the
> maintainer and you want KOPENG on Postgres anyway, read this whole page
> first and expect to own the operational side (backups via `pg_dump`)
> yourself.

## Selecting the backend

Postgres replaces SQLite rather than adding a layer, so it has no `*_ENABLED` flag and no standup doc — it's selected with `DATABASE_TYPE=postgres`. Compose reads two variables that the other services don't:

```bash
# .env
DATABASE_TYPE=postgres
POSTGRES_PASSWORD=<choose one>            # REQUIRED — Compose fails fast if unset (the container will not initialize without it)
POSTGRES_HOST_PORT=5432                   # optional; host side only, override if 5432 is taken by a native install
POSTGRES_URL=postgresql://kopeng:<same password>@localhost:5432/kopeng
```

```bash
docker compose -f docker-compose.postgres.yml up -d
npm start                                  # migrations run on boot
curl http://localhost:3200/api/stats       # confirm it came up on the new backend
```

The container, database, user, and volume are named `kopeng*`. To migrate an existing SQLite corpus across, see `npm run migrate:postgres` (verify with `npm run migrate:verify`).

## `.env` reference

These are the Postgres lines that used to live in `.env.example`:

```bash
# Database Backend (sqlite or postgres)
DATABASE_TYPE=sqlite
# POSTGRES_URL=postgresql://kopeng:password@localhost:5432/kopeng
#
# docker-compose.postgres.yml reads these two directly — POSTGRES_PASSWORD has no
# default, so Compose warns and starts with an EMPTY password if you skip it:
# POSTGRES_PASSWORD=                     # REQUIRED by docker-compose.postgres.yml; must match the password in POSTGRES_URL
# POSTGRES_HOST_PORT=5432                # Host-side port only (container stays 5432). Override if 5432 is taken by a native install
#
# The container/db/user/volume are named `kopeng*`.
```

## Windows: reserve the Postgres port from winnat

SETUP.md §6b explains the underlying failure mode: on every reboot, Windows'
NAT driver (winnat) reserves random port ranges, and a range landing on a
Docker-published port makes the container come up "healthy" while its host
port silently never binds. **If it lands on the Postgres port, KOPENG is fully
down** — the server waits in a connection-retry loop until the port is freed,
and it will wait forever.

The Postgres row of the §6b reservation block (run as admin, winnat stopped):

```powershell
netsh int ipv4 add excludedportrange protocol=tcp startport=5432 numberofports=1   # Postgres (POSTGRES_HOST_PORT)
```

Adjust the port if `POSTGRES_HOST_PORT` differs (default 5432, matching the
Compose file). Follow the full ordering/verification procedure in SETUP.md §6b.

## Backups

`npm run backup` / `npm run restore:verify` are SQLite-only and exit with an
error when `DATABASE_TYPE=postgres` — the Postgres corpus is backed up with
`pg_dump` instead (the maintainer's own offsite pipeline is a pg_dump-based
scheduled task; that setup is not part of this repo's supported surface).
