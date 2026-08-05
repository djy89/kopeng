# Dream Reasoner Provider Setup (D2.1)

The dreaming layer's reasoner (`LocalOllamaReasoner`) talks to a local
Ollama-compatible HTTP endpoint. This doc covers installing the provider,
arming the flag, runtime knobs, and what to carry over when KOPENG moves to a
different host.

The reasoner is **classify-only** (invariant #3): it labels candidate pairs
(`duplicate` / `preference_change` / `conditional` / `unrelated` /
`contested`); the deterministic engine owns every write. With the flag off, or
the provider down, behavior is identical to Phase 1 (NoOp — empty verdicts,
store untouched).

## Reference deployment

| What | Value |
|---|---|
| Host | The machine running KOPENG — any ~12GB-VRAM consumer GPU is sufficient |
| Provider | Ollama, default install (`winget install Ollama.Ollama` on Windows) |
| Endpoint | `http://localhost:11434` |
| Model | `qwen3:8b` (Q4_K_M, ~5.2GB — fits fully in VRAM; ~1.9s/classify warm) |
| Flag | `DREAM_REASONER_ENABLED` — off by default (operator action to arm) |

Model choice and the classify-pair JSON contract were locked by the D2.1
prototype evals ("prototype first"): qwen3:8b scored 40/40 with 0
forbidden verdicts — including the R13 class (template-shaped memories about
*different* files must be `unrelated`, never `duplicate`). qwen3:4b was
rejected: it over-applied the template rule (called a reworded duplicate
`unrelated` — a forbidden miss) and was slower.

## Install (any host)

```powershell
# Windows
winget install Ollama.Ollama   # installs + starts the service on :11434
ollama pull qwen3:8b
```

```bash
# Linux (e.g. a dedicated GPU box)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:8b
```

Verify: `curl http://localhost:11434/api/version`.

Hardware note: qwen3:8b wants ~6GB VRAM (or patient CPU inference). On a
GPU-less host, evaluate a smaller model first — **but re-run the prompt evals
before switching models** (see below); qwen3:4b already failed them.

## Arming the reasoner

The enable flag is **env-only and restart-gated** — arming the first LLM
dependency is a deliberate operator action, mirroring `DREAMING_ENABLED`:

```ini
# .env
DREAM_REASONER_ENABLED=true
# defaults shown — only set to override:
DREAM_REASONER_URL=http://localhost:11434
DREAM_REASONER_MODEL=qwen3:8b
DREAM_REASONER_TIMEOUT_MS=30000
DREAM_REASONER_MAX_TOKENS=300
```

Then `npm run build` + restart the server (e.g. `nssm restart kopeng` if running as a Windows service). Boot log line confirms:
`Dream reasoner enabled (D2.1, classify-only): qwen3:8b @ http://localhost:11434 …`

## Runtime knobs (no restart)

Everything except the enable flag is hot-editable via the
`dream_reasoner` blob in `operator_config.config` — resolved **per call**, DB
over env:

```jsonc
// set_operator_config / PATCH /api/operator-config — config is a JSON OBJECT,
// merged shallowly server-side (send only the keys you're changing)
{ "config": { "dream_reasoner": {
    "url": "http://<gpu-host>:11434",   // remote endpoint
    "model": "qwen3:8b",
    "timeout_ms": 30000,
    "max_tokens": 300,
    "think": false                       // omit to auto-detect by family
  } } }
```

(The blob is shared with `dream_window_cursor` — the server merges top-level
keys, so a partial patch never clobbers the cursor.)

## Moving KOPENG to another host

1. Install Ollama + pull the model on the new host (above).
2. Carry the `.env` reasoner block. If the model runs on a *different* box
   than KOPENG (e.g. the GPU stays on the old host), point `DREAM_REASONER_URL`
   (or the blob's `url`) at it over your private network — e.g.
   `http://<gpu-host>:11434` — and set `OLLAMA_HOST=0.0.0.0` on the GPU box so
   Ollama listens beyond localhost.
3. Re-run the gold-set eval against the new endpoint before the first armed
   nightly: `npm run eval:reasoner -- --url http://<host>:11434`.

## Re-validating after any model/prompt change

```bash
npm run eval:reasoner                      # default: qwen3:8b @ localhost
npm run eval:reasoner -- --models qwen3:8b,candidate:tag --runs 3
```

Exit code 1 on any forbidden verdict or unparseable response. The eval
exercises the EXACT prompt + schema the adapter ships
(`src/dreaming/reasoner/prompts.ts`); fixtures (gold band cases + R13 class,
both directions) live in `tests/fixtures/dreaming/eval-pairs.ts`. The test
suite and `npm run dream:replay` stay zero-LLM — they never need Ollama.

## Failure posture (verified)

- Provider down / HTTP error / garbage output → retry once → fallback verdict
  (`unrelated`, confidence 0) — a downstream no-op; the pass completes, store
  untouched.
- Hung provider → adapter aborts at `min(timeout_ms, ctx.timeoutMs)`; even an
  abort-ignoring adapter is cut off by the pipeline's own `Promise.race` +
  8-minute pass budget (R4b) — dream marked `failed`, zero writes.


## Keep Ollama running: boot task (T21)

`DREAM_REASONER_ENABLED=true` arms the LLM path, but if `ollama serve` isn't
running the reasoner silently degrades to NoOp — "armed but dark." Two things
close that gap:

1. **Boot task** — register `ollama serve` as an at-boot Windows Scheduled Task
   so the provider is up before nightly consolidation fires:

   ```powershell
   # elevated PowerShell, from the repo root
   powershell -ExecutionPolicy Bypass -File scripts\ops\install-ollama-task.ps1
   # verify
   Start-ScheduledTask -TaskName 'KOPENG Ollama Serve'
   Get-ScheduledTaskInfo -TaskName 'KOPENG Ollama Serve'   # LastTaskResult 0 or 267009 (running)
   curl http://localhost:11434/api/tags
   ```

   Task shape: runs as the operator via **S4U** (never SYSTEM — it must read
   `~/.ollama`), **no execution time limit** (it's a long-lived service),
   **at-startup** trigger, restart-on-crash, and `IgnoreNew` so a boot fire is a
   no-op when a manual `ollama serve` already holds port 11434. Auto-detects
   `ollama.exe` (PATH, then `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`);
   override with `-OllamaPath`. Uninstall: `... install-ollama-task.ps1 -Uninstall`.
   The task survives a reboot (operator-verifiable).

2. **Ops visibility** — `GET /api/ops/reasoner-status` (viz ops tab → "reasoner"
   card) reports `armed` / `reachable` / `model` / `last_classify_at`. Armed +
   unreachable lights **red** ("armed · DARK"); armed + reachable is green;
   disarmed is neutral (NoOp is a valid config). The probe is fail-soft — a down
   provider yields `reachable:false`, never a 500. When the reasoner is armed,
   the server also writes `operator_config.reasoner_provider = 'ollama'` for
   display truth (a column-targeted, read-merge-write update — the `config` JSON
   blob is untouched).
