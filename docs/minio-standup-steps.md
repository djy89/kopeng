# MinIO Standup — Operator Steps

MinIO provides S3-compatible artifact storage for KOPENG (`store_artifact` / `get_artifact` MCP tools). Runs as a Docker container on the same host as the KOPENG service.

---

## Step 1 — Generate credentials

Run this as a **single line** — do not let it wrap or split across two lines, or `$key` will be empty.

```powershell
$key = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object {[char]$_}); Write-Host "Access key: kopeng"; Write-Host "Secret key: $key"
```

Save the output. You will need `$key` in Steps 2, 3, and 4.

---

## Step 2 — Update .env

Add to `.env` in the repo root (use the same comment style as other optional service blocks):

```env
# MinIO (Artifact Storage) - Phase 2
MINIO_ENABLED=true
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=kopeng
MINIO_SECRET_KEY=<key from step 1>
MINIO_BUCKET=memory-artifacts
```

---

## Step 3 — Start container

The compose file reads `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` from the environment, so they must be set in the **same shell session** before running `docker compose up`:

```powershell
$env:MINIO_ACCESS_KEY = "kopeng"
$env:MINIO_SECRET_KEY = "<key from step 1>"
docker compose -f docker-compose.minio.yml up -d
```

Verify the container started:

```powershell
docker ps --filter name=kopeng-minio
```

---

## Step 4 — Create bucket

Use the web console at `http://localhost:9001` (on the KOPENG host). Log in with the access key and secret key from Step 1 (`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`). Create a bucket named **`memory-artifacts`**.

> **Note — two different `127.0.0.1:9001`s; don't confuse them.**
>
> - `command: server /data --console-address ":9001"` is the **container-side** listener. It must be `":9001"` (all container interfaces). If it is `"127.0.0.1:9001"`, the console listens only on the container's own loopback, so requests forwarded in from the host never reach it — `localhost:9001` returns an empty response even though the port mapping is correct.
> - `ports: - "127.0.0.1:9001:9001"` is the **host-side** publish. Loopback here is the deliberate safe default: the console is reachable from this machine only. Widening it (to `"0.0.0.0:9001:9001"`) exposes the MinIO admin console to your network — a separate decision from the one above, and one to make on purpose.
>
> So if you see an empty response at port 9001, the fix is the container-side flag, which touches only the `command:` line:
> ```powershell
> (Get-Content docker-compose.minio.yml) -replace '"127.0.0.1:9001"', '":9001"' | Set-Content docker-compose.minio.yml
> ```
> That pattern cannot match the host mapping — `"127.0.0.1:9001:9001"` has a trailing `:9001`, so it does not end where the pattern requires. Then re-run the `docker compose down` / `up -d` from Step 3.

---

## Step 5 — Restart KOPENG

> **Note:** `Restart-Service` requires an Administrator PowerShell session. If you get "Cannot open service", use NSSM directly instead:

```powershell
nssm stop kopeng
nssm start kopeng
```

Verify the service came back up:

```powershell
Invoke-WebRequest -Uri http://localhost:3200/api/health -UseBasicParsing
```

---

## Step 6 — Verify

```powershell
Invoke-WebRequest -Uri http://localhost:3200/api/storage/stats -UseBasicParsing
# Should return 200 with {"data":{"totalObjects":0,"totalSize":0}} — not 404
```

If you get `404`, MinIO is not enabled. Check that `.env` was saved correctly and that the service restarted cleanly (`Get-Service kopeng`).
