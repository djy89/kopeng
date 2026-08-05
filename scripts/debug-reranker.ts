/**
 * Debug script to find the right way to get raw cross-encoder scores
 */
const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@xenova/transformers');
env.cacheDir = 'models'; // run from the repo root
env.allowRemoteModels = true;

const modelName = 'Xenova/ms-marco-MiniLM-L-6-v2';

console.log('Loading tokenizer + model...');
const tokenizer = await AutoTokenizer.from_pretrained(modelName);
const model = await AutoModelForSequenceClassification.from_pretrained(modelName, { quantized: true });

const query = 'what graph database are we using';
const passages = [
  'Neo4j Community Edition is the chosen graph database for KOPENG Phase 2.',
  'The operator prefers 2-space indentation and single quotes in TypeScript.',
  'REST API contract is sacred in KOPENG.',
  'The HOMELAB desktop at 192.0.2.10 is the current compute host.',
];

for (const passage of passages) {
  const inputs = tokenizer(query, { text_pair: passage, padding: true, truncation: true });
  const output = await model(inputs);

  // Raw logits
  const logits = output.logits.data;
  console.log(`"${passage.slice(0, 60)}..." → logits: [${Array.from(logits).map((v: any) => v.toFixed(4)).join(', ')}]`);
}
