// Build the single-file userscript from local sources and search data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(base, file), 'utf8');

const words = read('data/rujaword-headwords.txt').trim().split(/\r?\n/);
if (words.length !== 44534 || new Set(words).size !== words.length) {
  throw Error('Unexpected Russian dictionary size');
}
const japanese = JSON.parse(read('data/jaru-headwords.json'));
if (japanese.length !== 5977) throw Error('Unexpected Japanese dictionary size');
const aliases = JSON.parse(read('data/suggest-aliases.json'));
const pageWords = new Set(japanese.map(row => row[0]));
for (const [word, readings, target] of aliases) {
  if (!word || !Array.isArray(readings) || !readings.length || !pageWords.has(target)) {
    throw Error('Invalid Japanese alias');
  }
}
japanese.push(...aliases);

const core = read('src/corrections.js');
const css = read('src/corrections.css');
let script = read('src/userscript.js');
function include(marker, content) {
  if (script.split(marker).length !== 2) throw Error('Missing or repeated marker: ' + marker);
  script = script.replace(marker, () => content);
}
include('/* @include corrections */', `// BEGIN GENERATED CORRECTIONS
  const corrections = (() => {
    const module = { exports: {} };
${core}
    return module.exports;
  })();
  const CORRECTION_CSS = ${JSON.stringify(css)};
  // END GENERATED CORRECTIONS`);
include('/* @include search-data */', `// BEGIN GENERATED RUJA HEADWORDS
  // サイトマップ・和露見出し取得日: 2026-10-12。入力時に通信しないため同梱。
  const RUJA_HEADWORDS = ${JSON.stringify(words.join('\n'))};
  const JARU_HEADWORDS = ${JSON.stringify(JSON.stringify(japanese))};
  installSuggestions(document, () => createBilingualIndex(RUJA_HEADWORDS.split('\\n'), JSON.parse(JARU_HEADWORDS)));
  // END GENERATED RUJA HEADWORDS`);
// A failed build must not overwrite the last working distribution.
new vm.Script(script, { filename: 'kotobank-russian.user.js' });
fs.writeFileSync(path.join(base, 'kotobank-russian.user.js'), script);
console.log(`Bundled corrections + ${words.length} Russian headwords; userscript ${Buffer.byteLength(script)} bytes`);
