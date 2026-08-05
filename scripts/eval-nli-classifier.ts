/**
 * D2.2 NLI classifier eval — `npm run eval:nli`
 *
 * The other half of the plan §2.2 decision: "measure a small dedicated NLI
 * model vs the local LLM on the gold set — decide empirically." Runs a local
 * ONNX NLI cross-encoder (via @xenova/transformers, same runtime as the
 * embedder) over the SAME eval pairs and scoring contract as
 * eval-reasoner-prompt.ts, so the two reports are directly comparable.
 *
 * Mapping (bidirectional NLI → PairRelation):
 *   entailment(A→B) AND entailment(B→A)  → duplicate
 *   contradiction in either direction    → contested
 *   anything else                        → unrelated
 *
 * `preference_change` and `conditional` are STRUCTURALLY unreachable — pure
 * NLI has no notion of temporal supersession or branch conditions. That is
 * the central question this eval answers: how much does that cost on the gold
 * set, and does the NLI's contradiction detection at least avoid the
 * forbidden (memory-corrupting) verdicts?
 *
 * NOT part of the test suite or replay harness (both stay zero-model).
 * Downloads the NLI model on first run (cached in models/, like the embedder).
 *
 *   npx tsx scripts/eval-nli-classifier.ts [--model Xenova/nli-deberta-v3-xsmall]
 */
import { EVAL_PAIRS } from '../tests/fixtures/dreaming/eval-pairs.js';
import { PAIR_RELATIONS } from '../src/dreaming/reasoner/prompts.js';
import type { PairRelation, CandidateMemory } from '../src/dreaming/reasoner/reasoner.js';
import config from '../src/config/config.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MODEL = arg('model', 'Xenova/nli-deberta-v3-xsmall');

function softmax(logits: Float32Array | number[]): number[] {
  const max = Math.max(...logits);
  const exps = Array.from(logits, v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function perClassTable(rows: Array<{ expected: PairRelation; predicted: PairRelation | null }>): string {
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

async function main(): Promise<void> {
  console.log(`D2.2 NLI classifier eval — ${MODEL} · ${EVAL_PAIRS.length} pairs (bidirectional)\n`);

  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@xenova/transformers');
  env.cacheDir = config.embedding.cacheDir;
  env.allowRemoteModels = true;

  const loadStart = Date.now();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  const model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { quantized: true });
  const id2label = (model.config as { id2label: Record<number, string> }).id2label;
  console.log(`model loaded in ${Date.now() - loadStart}ms · labels: ${JSON.stringify(id2label)}\n`);

  async function nli(premise: string, hypothesis: string): Promise<{ label: string; prob: number }> {
    const inputs = tokenizer(premise, { text_pair: hypothesis, padding: true, truncation: true });
    const { logits } = await model(inputs);
    const probs = softmax(logits.data as Float32Array);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    return { label: String(id2label[best]).toLowerCase(), prob: probs[best] };
  }

  function mapToRelation(ab: { label: string }, ba: { label: string }): PairRelation {
    if (ab.label === 'contradiction' || ba.label === 'contradiction') return 'contested';
    if (ab.label === 'entailment' && ba.label === 'entailment') return 'duplicate';
    return 'unrelated';
  }

  const content = (m: CandidateMemory): string => m.content;
  const rows: Array<{ expected: PairRelation; predicted: PairRelation | null }> = [];
  let pass = 0, forbidden = 0, totalMs = 0;

  for (const pair of EVAL_PAIRS) {
    const start = Date.now();
    const ab = await nli(content(pair.a), content(pair.b));
    const ba = await nli(content(pair.b), content(pair.a));
    const ms = Date.now() - start;
    totalMs += ms;

    const predicted = mapToRelation(ab, ba);
    rows.push({ expected: pair.expected, predicted });

    const ok = predicted === pair.expected || (pair.acceptable ?? []).includes(predicted);
    const hard = pair.forbidden.includes(predicted);
    if (ok) pass++;
    if (hard) forbidden++;
    const mark = hard ? '‼ FORBIDDEN' : ok ? '✓' : '✗ miss';
    console.log(`  ${mark} ${pair.id}: ${predicted} (A→B ${ab.label} ${ab.prob.toFixed(2)}, B→A ${ba.label} ${ba.prob.toFixed(2)}, ${ms}ms, want ${pair.expected})`);
  }

  console.log(`\n  → ${pass}/${EVAL_PAIRS.length} pass · ${forbidden} forbidden · avg ${(totalMs / EVAL_PAIRS.length).toFixed(0)}ms/pair (both directions)`);
  console.log(perClassTable(rows));
  console.log(`\nNote: preference_change/conditional are unreachable by construction — misses there are the structural cost of a pure-NLI classifier.`);
  process.exit(forbidden > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('eval failed:', err);
  process.exit(1);
});
