# Neo4j Standup — Operator Steps

Run on the KOPENG host. The KOPENG service must be restarted after .env changes.

## Step 1 — Generate password and start container

```powershell
$pw = -join (1..32 | ForEach-Object { [char](Get-Random -InputObject ((48..57) + (97..102))) })
Write-Host "Password: $pw"
# SAVE THIS PASSWORD before continuing

$env:NEO4J_PASSWORD = $pw
docker compose -f docker-compose.neo4j.yml up -d

# Wait for Neo4j (takes ~30s)
do { Start-Sleep 3; $r = try { (Invoke-WebRequest http://localhost:7474 -UseBasicParsing).StatusCode } catch { 0 } } while ($r -ne 200)
Write-Host "Neo4j ready"
```

## Step 2 — Update .env

Add to the repo-root .env:

```dotenv
NEO4J_ENABLED=true
NEO4J_URL=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<password from step 1>
```

## Step 3 — Restart KOPENG service

```powershell
Restart-Service -Name kopeng
Start-Sleep 5
curl -s http://localhost:3200/api/health
```

## Step 4 — Verify Neo4j routes

```powershell
curl -s http://localhost:3200/api/graph/stats
# Should return 200 with a stats payload (not 404)
```

## Step 5 — Backfill entities

```powershell
cd C:\path\to\kopeng
npm run backfill:graph
# Roughly a minute per ~100 memories
```

## Step 6 — Verify graph populated

```powershell
curl -s http://localhost:3200/api/graph/stats
# Should show node/edge counts > 0

# Via Neo4j browser at http://localhost:7474
# MATCH (m:Memory)-[r]->(e) RETURN m, r, e LIMIT 50
```
