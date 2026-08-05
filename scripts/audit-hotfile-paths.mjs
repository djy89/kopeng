// One-shot audit: count backslash run-lengths in stored hot_file paths.
import Database from 'better-sqlite3';
const mem = new Database('data/memory.db', { readonly: true });
const all = mem.prepare(`SELECT id, content FROM memories WHERE type='discovery' AND content LIKE 'The file %frequent edit target%' ORDER BY id DESC`).all();

const has2 = '\\\\';       // 2 actual backslash chars
const has4 = '\\\\\\\\';   // 4 actual backslash chars

const buckets = { no_backslash: 0, single: 0, doubled: 0, quadrupled: 0 };
const examples = { single: [], doubled: [], quadrupled: [] };

for (const m of all) {
  const file = m.content.match(/The file (.+?) is a frequent/)?.[1] || '';
  if (!file.includes('\\')) {
    buckets.no_backslash++;
  } else if (file.includes(has4)) {
    buckets.quadrupled++;
    if (examples.quadrupled.length < 3) examples.quadrupled.push({ id: m.id, file });
  } else if (file.includes(has2)) {
    buckets.doubled++;
    if (examples.doubled.length < 3) examples.doubled.push({ id: m.id, file });
  } else {
    buckets.single++;
    if (examples.single.length < 3) examples.single.push({ id: m.id, file });
  }
}

console.log('Total hot_file memories:', all.length);
console.log('Backslash run distribution:');
for (const k of Object.keys(buckets)) console.log('  ' + k + ': ' + buckets[k]);

console.log('\nExamples (using JSON.stringify so backslashes display 1:1 as literal chars):');
for (const cat of ['single', 'doubled', 'quadrupled']) {
  if (examples[cat].length === 0) continue;
  console.log(`\n${cat}:`);
  for (const e of examples[cat]) console.log(`  #${e.id}  ${JSON.stringify(e.file).slice(0, 110)}`);
}
mem.close();
