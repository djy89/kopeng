/**
 * D2.1/D2.2 reasoner prompt eval — `npx tsx scripts/eval-reasoner-prompt.ts`
 *
 * Manual prompt-eval CLI (plan §2.1 "prototype first"): runs the LOCKED
 * classify-pair prompt + JSON output contract from
 * `src/dreaming/reasoner/prompts.ts` against a live Ollama endpoint, over the
 * eval pairs in `tests/fixtures/dreaming/eval-pairs.ts` (gold-set band cases +
 * the R13 template/different-referent class), and scores each model.
 *
 * NOT part of the test suite or the replay harness — both stay zero-LLM.
 * Requires a reachable Ollama with the candidate models pulled.
 *
 *   npx tsx scripts/eval-reasoner-prompt.ts [--url http://localhost:11434]
 *     [--models qwen3:8b,qwen3:4b] [--runs 1] [--extract]
 *
 * Scoring per pair: PASS when the verdict is `expected` or in `acceptable`;
 * FORBIDDEN (hard fail) when it's in `forbidden` — the misclassification that
 * would corrupt memory if D2.2 acted on it. Exit code 1 if any model produces
 * a forbidden verdict or an unparseable response.
 *
 * D2.2 additions: a per-class precision/recall table (gold = `expected`, so the
 * NLI comparison in eval-nli-classifier.ts scores on identical axes), and
 * `--extract` — the extract-condition prototype eval (plan §2.2): conditional
 * pairs must yield a real branch extraction; a contested control pair must
 * trigger the empty-string escape hatch (null).
 */
import {
  CLASSIFY_PAIR_SYSTEM, buildClassifyPairPrompt, parsePairVerdict, PAIR_VERDICT_JSON_SCHEMA,
  EXTRACT_CONDITION_SYSTEM, buildExtractConditionPrompt, parseConditionExtraction, CONDITION_EXTRACTION_JSON_SCHEMA,
} from '../src/dreaming/reasoner/prompts.js';
import { EVAL_PAIRS, type EvalPair } from '../tests/fixtures/dreaming/eval-pairs.js';
import type { PairVerdict, PairRelation } from '../src/dreaming/reasoner/reasoner.js';
import { PAIR_RELATIONS } from '../src/dreaming/reasoner/prompts.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL_BASE = arg('url', 'http://localhost:11434');
const MODELS = arg('models', 'qwen3:8b,qwen3:4b').split(',').map(s => s.trim()).filter(Boolean);
const RUNS = parseInt(arg('runs', '1'), 10);
const RUN_EXTRACT = process.argv.includes('--extract');

/** Per-class precision/recall over (expected, predicted) pairs — gold is `expected` only. */
export function perClassTable(rows: Array<{ expected: PairRelation; predicted: PairRelation | null }>): string {
  const lines: string[] = ['  class              precision      recall'];
  for (const cls of PAIR_RELATIONS) {
    const predicted = rows.filter(r => r.predicted === cls).length;
    const gold = rows.filter(r => r.expected === cls).length;
    const tp = rows.filter(r => r.predicted === cls && r.expected === cls).length;
    if (predicted === 0 && gold === 0) continue;
    const p = predicted ? (tp / predicted).toFixed(2) : '  — ';
    const r = gold ? (tp / gold).toFixed(2) : '  — ';
    lines.push(`  ${cls.padEnd(18)} ${String(p).padStart(9)} ${String(r).padStart(11)}  (${tp}/${predicted} pred, ${tp}/${gold} gold)`);
  }
  return lines.join('\n');
}

/** Thinking-capable model families where we disable thinking for latency. */
function thinkOption(model: string): { think?: boolean } {
  return /^(qwen3|deepseek-r1|gpt-oss)/.test(model) ? { think: false } : {};
}

interface CallResult {
  verdict: PairVerdict | null;
  ms: number;
  raw: string;
  error?: string;
}

async function classifyOnce(model: string, pair: EvalPair): Promise<CallResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${URL_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: PAIR_VERDICT_JSON_SCHEMA,
        ...thinkOption(model),
        options: { temperature: 0, num_predict: 300 },
        messages: [
          { role: 'system', content: CLASSIFY_PAIR_SYSTEM },
          { role: 'user', content: buildClassifyPairPrompt(pair.a, pair.b) },
        ],
      }),
    });
    if (!res.ok) {
      return { verdict: null, ms: Date.now() - start, raw: '', error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const body = await res.json() as { message?: { content?: string } };
    const raw = body.message?.content ?? '';
    return { verdict: parsePairVerdict(raw), ms: Date.now() - start, raw };
  } catch (err) {
    return { verdict: null, ms: Date.now() - start, raw: '', error: err instanceof Error ? err.message : String(err) };
  }
}

interface ModelScore {
  model: string;
  pass: number;
  fail: number;
  forbidden: number;
  unparseable: number;
  totalMs: number;
  calls: number;
}

/**
 * Extract-condition prototype eval (D2.2). Conditional pairs must extract a
 * genuine branch; the contested control must use the escape hatch (→ null —
 * fabricating a distinguisher for a flat contradiction is the failure mode).
 * Returns true when any case hard-fails.
 */
async function runExtractEval(model: string): Promise<boolean> {
  console.log(`  ── extract-condition (${model}) ──`);
  const cases = [
    ...EVAL_PAIRS.filter(p => p.expected === 'conditional').map(p => ({ pair: p, wantExtraction: true })),
    ...EVAL_PAIRS.filter(p => p.id === 'contradiction-deploy-day').map(p => ({ pair: p, wantExtraction: false })),
  ];
  let failed = false;

  for (const { pair, wantExtraction } of cases) {
    const start = Date.now();
    try {
      const res = await fetch(`${URL_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: CONDITION_EXTRACTION_JSON_SCHEMA,
          ...thinkOption(model),
          options: { temperature: 0, num_predict: 300 },
          messages: [
            { role: 'system', content: EXTRACT_CONDITION_SYSTEM },
            { role: 'user', content: buildExtractConditionPrompt(pair.a, pair.b) },
          ],
        }),
      });
      const body = await res.json() as { message?: { content?: string } };
      const raw = body.message?.content ?? '';
      const extraction = parseConditionExtraction(raw);
      const ms = Date.now() - start;
      const ok = wantExtraction ? extraction !== null : extraction === null;
      if (!ok) failed = true;
      if (extraction) {
        console.log(`  ${ok ? '✓' : '✗'} ${pair.id}: "${extraction.conditionA}" / "${extraction.conditionB}" (${ms}ms)${ok ? '' : ' — expected escape hatch'}`);
      } else {
        console.log(`  ${ok ? '✓' : '✗'} ${pair.id}: no extraction (${ms}ms)${ok ? ' — escape hatch honored' : ` — expected a branch; raw: ${raw.slice(0, 120)}`}`);
      }
    } catch (err) {
      failed = true;
      console.log(`  ✗ ${pair.id}: extract call failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('');
  return failed;
}

async function main(): Promise<void> {
  console.log(`D2.1 reasoner prompt eval — ${URL_BASE} · models: ${MODELS.join(', ')} · ${EVAL_PAIRS.length} pairs × ${RUNS} run(s)\n`);

  const scores: ModelScore[] = [];
  let anyHardFail = false;

  for (const model of MODELS) {
    console.log(`── ${model} ──`);
    const score: ModelScore = { model, pass: 0, fail: 0, forbidden: 0, unparseable: 0, totalMs: 0, calls: 0 };
    const rows: Array<{ expected: PairRelation; predicted: PairRelation | null }> = [];

    for (const pair of EVAL_PAIRS) {
      for (let run = 0; run < RUNS; run++) {
        const r = await classifyOnce(model, pair);
        score.calls++;
        score.totalMs += r.ms;
        rows.push({ expected: pair.expected, predicted: r.verdict?.relation ?? null });

        if (!r.verdict) {
          score.unparseable++;
          anyHardFail = true;
          console.log(`  ✗ ${pair.id}: UNPARSEABLE (${r.ms}ms) ${r.error ?? `raw: ${r.raw.slice(0, 120)}`}`);
          continue;
        }
        const v = r.verdict;
        const ok = v.relation === pair.expected || (pair.acceptable ?? []).includes(v.relation);
        const hard = pair.forbidden.includes(v.relation);
        if (hard) {
          score.forbidden++;
          anyHardFail = true;
        }
        if (ok) score.pass++;
        else score.fail++;
        const mark = hard ? '‼ FORBIDDEN' : ok ? '✓' : '✗ miss';
        console.log(`  ${mark} ${pair.id}: ${v.relation} (conf ${v.confidence.toFixed(2)}, ${r.ms}ms, want ${pair.expected})`);
        if (!ok) console.log(`      rationale: ${v.rationale.slice(0, 160)}`);
      }
    }

    scores.push(score);
    console.log(`  → ${score.pass}/${score.calls} pass · ${score.forbidden} forbidden · ${score.unparseable} unparseable · avg ${(score.totalMs / score.calls).toFixed(0)}ms`);
    console.log(perClassTable(rows));
    console.log('');

    if (RUN_EXTRACT) {
      const extractFailed = await runExtractEval(model);
      if (extractFailed) anyHardFail = true;
    }
  }

  console.log('── Summary ──');
  for (const s of scores) {
    console.log(`${s.model}: ${((s.pass / s.calls) * 100).toFixed(0)}% pass, ${s.forbidden} forbidden, avg ${(s.totalMs / s.calls).toFixed(0)}ms/call`);
  }
  process.exit(anyHardFail ? 1 : 0);
}

main().catch(err => {
  console.error('eval failed:', err);
  process.exit(1);
});
