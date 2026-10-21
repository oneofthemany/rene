#!/usr/bin/env node
// Compares ftsTokens (src/db/fts-tokens.ts) with SQLite FTS5's unicode61
// tokenizer on real text: every name, qualified name, docstring and
// signature in the nodes of storage-parity recordings. Usage:
//   node scripts/fts-token-parity.mjs <recording-dir>
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ftsTokens } = require("../dist/db/fts-tokens.js");
const [dir] = process.argv.slice(2);
const rows = readdirSync(dir).filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).tables.nodes.map((n) => JSON.parse(n)));
const fts = new DatabaseSync(":memory:");
fts.exec("CREATE VIRTUAL TABLE t USING fts5(x); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');");
const insert = fts.prepare("INSERT INTO t(rowid, x) VALUES (?, ?)");
const texts = [];
for (const row of rows)
  for (const text of [row.name, row.qualified_name, row.docstring, row.signature]) if (text) texts.push(text);
// Beyond what code usually holds: accents precomposed and decomposed, other
// scripts, symbols, emoji, private use, digit forms, case-fold specials.
texts.push(
  "Café résumé naïve façade Ångström Øre Œuvre ß straße İstanbul ıi",
  "Cafe\u0301 re\u0301sume\u0301 n\u0303",
  "日本語のテキスト 中文字符 한국어 텍스트",
  "Привет мир ΣΊΣΥΦΟΣ σίσυφος ς ϐϑϕϖϰϱϵ µs",
  "emoji 🙂👍 snake_case kebab-case dot.name a+b x=y <tag> $var @attr #hash",
  "private \ue000\ue001 use and ① ½ ٣ ²³ Ⅻ",
  "ﬁnance ﬂow ＦＵＬＬＷＩＤＴＨ ｆｕｌｌ",
  "Ǆ ǅ ǆ ǈ ﬀ ﬃ ẞ",
);
fts.exec("BEGIN");
texts.forEach((text, i) => insert.run(i + 1, text));
fts.exec("COMMIT");
const expected = new Map();
for (const { doc, term, offset } of fts.prepare("SELECT doc, term, offset FROM v ORDER BY doc, offset").iterate()) {
  const list = expected.get(doc) ?? [];
  list[offset] = term;
  expected.set(doc, list);
}
let mismatched = 0;
const examples = [];
texts.forEach((text, i) => {
  const want = expected.get(i + 1) ?? [];
  const got = ftsTokens(text);
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    mismatched++;
    const at = want.findIndex((token, k) => token !== got[k]);
    const from = Math.max(0, (at === -1 ? Math.min(want.length, got.length) : at) - 2);
    if (examples.length < 8) examples.push({ at, want: want.slice(from, from + 6), got: got.slice(from, from + 6), chars: [...(want[at] ?? "")].concat(["|"], [...(got[at] ?? "")]).map((c) => c.codePointAt(0).toString(16)) });
  }
});
console.log(`${texts.length} texts, ${mismatched} tokenized differently`);
for (const e of examples) console.log(JSON.stringify(e));
process.exitCode = mismatched === 0 ? 0 : 1;
