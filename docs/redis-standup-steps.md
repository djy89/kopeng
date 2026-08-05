# Redis Standup — Operator Steps

## Step 1 — Update .env

Add to .env:

```env
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=memory:
REDIS_DEFAULT_TTL=3600
```

## Step 2 — Start container

```powershell
docker compose -f docker-compose.redis.yml up -d
```

## Step 3 — Restart KOPENG

```powershell
Restart-Service -Name kopeng
Start-Sleep 5
curl -s http://localhost:3200/api/health
```

## Step 4 — Verify

```powershell
curl -s http://localhost:3200/api/context
# Should return 200 with an empty keys list (not 404)

# Round-trip test:
curl -s -X PUT http://localhost:3200/api/context `
  -H "content-type: application/json" `
  -d '{"key":"test","value":"hello","ttl":60}'

curl -s http://localhost:3200/api/context/test
# Should return data with key "test" and value "hello"

curl -s -X DELETE http://localhost:3200/api/context/test
```
