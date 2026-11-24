// Unit tests for frontend/lib.js. Run with: node --test frontend/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib.js');

test('ac_16 slugs follow the GitHub rules', () => {
  assert.equal(L.slugify('Data Flow'), 'data-flow');
  assert.equal(L.slugify('中文 標題'), '中文-標題');
  assert.equal(L.slugify('  Hello, World! (v2)  '), 'hello-world-v2');
  assert.equal(L.slugify('snake_case and-dash'), 'snake_case-and-dash');
  const slug = L.makeSlugger();
  assert.deepEqual(['Intro', 'Intro', 'Intro', 'Other'].map(slug), ['intro', 'intro-1', 'intro-2', 'other']);
});

test('extension handling matches the server (dot files have none)', () => {
  assert.equal(L.ext('docs/UPPER.MD'), 'md');
  assert.equal(L.ext('.env'), '');
  assert.equal(L.ext('a/b.tar.gz'), 'gz');
  assert.ok(L.isMarkdown('x.markdown') && L.isHtml('y.HTM') && !L.isSupported('z.css'));
});

test('resolveRelative stays inside the root', () => {
  assert.equal(L.resolveRelative('docs/a.md', './b.md'), 'docs/b.md');
  assert.equal(L.resolveRelative('docs/a.md', '../README.md'), 'README.md');
  assert.equal(L.resolveRelative('docs/a.md', '../../x.md'), null);
  assert.equal(L.resolveRelative('README.md', 'docs//api.md'), 'docs/api.md');
  assert.equal(L.resolveRelative('docs/a.md', '/other/x.md'), 'other/x.md');
  assert.equal(L.resolveRelative('a.md', '%E4%B8%AD%20x.md'), '中 x.md');
  assert.equal(L.resolveRelative('a.md', '%zz'), null);
});

test('classifyLink applies the PRD 6 link rules', () => {
  const tree = new Set(['README.md', 'docs/api.md', 'docs/architecture.md']);
  const c = (href, from = 'docs/links.md') => L.classifyLink(href, from, tree);
  assert.equal(c('./api.md').kind, 'internal');
  assert.equal(c('./api.md').path, 'docs/api.md');
  assert.equal(c('../README.md#top').hash, 'top');
  assert.equal(c('https://example.com').kind, 'external');
  assert.equal(c('mailto:a@b.c').kind, 'external');
  assert.equal(c('javascript:alert(1)').kind, 'inert');
  assert.equal(c('data:text/html,x').kind, 'inert');
  assert.equal(c('file:///etc/passwd').kind, 'inert');
  assert.equal(c('//evil.example/x').kind, 'inert');
  assert.equal(c('../../outside.md').kind, 'text');
  assert.equal(c('../notes.txt').kind, 'text');
  assert.equal(c('./missing.md').kind, 'text');
  assert.equal(c('./diagram.svg').kind, 'asset');
  assert.equal(c('../node_modules/x/y.css').kind, 'text');
  assert.equal(c('#section').kind, 'anchor');
});

test('rewriteImageSrc resolves against the Markdown file', () => {
  assert.equal(L.rewriteImageSrc('./diagram.svg', 'docs/architecture.md'), '/files/docs/diagram.svg');
  assert.equal(L.rewriteImageSrc('../diagram.svg', 'docs/subdir/rel.md'), '/files/docs/diagram.svg');
  assert.equal(L.rewriteImageSrc('https://x.example/a.png', 'a.md'), 'https://x.example/a.png');
  assert.equal(L.rewriteImageSrc('http://x.example/a.png', 'a.md'), null);
  assert.equal(L.rewriteImageSrc('../../x.png', 'docs/a.md'), null);
  assert.equal(L.rewriteImageSrc('notes.txt', 'a.md'), null);
  assert.equal(L.rewriteImageSrc('中文 圖.png', 'a.md'), '/files/%E4%B8%AD%E6%96%87%20%E5%9C%96.png');
});

test('URL state round-trips, including CJK, spaces and plus signs', () => {
  for (const file of ['docs/architecture.md', 'docs/中文 筆記.md', 'a+b/c d.md', 'x&y.md']) {
    const url = L.buildUrl(file, 'sec tion');
    const u = new URL(url, 'http://127.0.0.1:4100');
    const got = L.parseLocation(u.search, u.hash);
    assert.equal(got.file, file);
    assert.equal(got.hash, 'sec tion');
  }
  assert.equal(L.parseLocation('?file=a+b.md', '').file, 'a+b.md'); // a literal plus stays a plus
  assert.equal(L.parseLocation('?file=a%20b.md', '').file, 'a b.md');
  assert.equal(L.buildUrl(null, ''), '/');
  assert.equal(L.parseLocation('', '').file, null);
  assert.deepEqual(L.ancestors('docs/sub/x.md'), ['docs', 'docs/sub']);
  assert.deepEqual(L.ancestors('README.md'), []);
});

test('collectPaths and decodeMarkdownBytes', () => {
  const tree = [{ name: 'docs', type: 'directory', children: [{ name: 'a.md', type: 'file', path: 'docs/a.md' }] },
    { name: 'R.md', type: 'file', path: 'R.md' }];
  assert.deepEqual([...L.collectPaths(tree)].sort(), ['R.md', 'docs/a.md']);
  assert.equal(L.decodeMarkdownBytes(new TextEncoder().encode('# hi 中')).invalid, false);
  const bad = L.decodeMarkdownBytes(new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x41]));
  assert.equal(bad.invalid, true);
  assert.ok(bad.text.includes('A'));
});

test('sidebar width is clamped to 180 px .. 60% of the window and stored values are validated', () => {
  assert.equal(L.clampSidebarWidth(300, 1280), 300);
  assert.equal(L.clampSidebarWidth(5, 1280), 180);
  assert.equal(L.clampSidebarWidth(5000, 1280), 768);
  assert.equal(L.clampSidebarWidth(500, 400), 240); // 60% of 400
  assert.equal(L.clampSidebarWidth(500, 200), 180); // the minimum wins in a tiny window
  assert.equal(L.clampSidebarWidth(NaN, 1280), 300);
  assert.equal(L.clampSidebarWidth('420.4', 1280), 420);
  assert.equal(L.parseStoredWidth('420'), 420);
  assert.equal(L.parseStoredWidth('99'), 99);
  for (const bad of [null, undefined, '', 'abc', '-5', '12.5', '99999', '1e3', '0x10', ' ', ' 420 ', '0420', '420\n', '+420']) {
    assert.equal(L.parseStoredWidth(bad), null, String(bad));
  }
});

const FTREE = [
  { name: 'docs', type: 'directory', children: [
    { name: 'architecture.md', type: 'file', path: 'docs/architecture.md' },
    { name: 'API.md', type: 'file', path: 'docs/API.md' },
    { name: 'search-target.md', type: 'file', path: 'docs/search-target.md' },
    { name: 'sub', type: 'directory', children: [{ name: 'deep.html', type: 'file', path: 'docs/sub/deep.html' }] },
  ] },
  { name: 'README.md', type: 'file', path: 'README.md' },
];
const order = (q) => L.fuzzyFiles(FTREE, q).map((r) => r.path);

test('fuzzyMatch: letters in order, any case; null otherwise', () => {
  assert.ok(L.fuzzyMatch('arcmd', 'docs/architecture.md'));
  assert.ok(L.fuzzyMatch('ARCH', 'docs/architecture.md'));
  assert.equal(L.fuzzyMatch('mda', 'docs/architecture.md'), null);   // wrong order
  assert.equal(L.fuzzyMatch('zzz', 'docs/architecture.md'), null);
  assert.deepEqual(L.fuzzyMatch('md', 'a.md').pos, [2, 3]);
  assert.equal(L.fuzzyMatch('', 'a.md'), null);
});

test('fuzzyMatch ranks substring > word start > scattered, and file name > folder', () => {
  const sub = L.fuzzyMatch('arch', 'docs/architecture.md').score;
  const scattered = L.fuzzyMatch('arch', 'docs/search-target.md').score; // s-e-a-r-c-h contains "arch" too
  assert.ok(sub > L.fuzzyMatch('actur', 'docs/architecture.md').score);   // scattered letters
  assert.ok(L.fuzzyMatch('ar', 'docs/architecture.md').score > L.fuzzyMatch('ar', 'docs/search-target.md').score); // word start beats the middle of a word
  assert.ok(sub > 0 && scattered > 0);
  // the same word in the file name beats it in a folder name
  assert.ok(L.fuzzyMatch('guide', 'x/guide.md').score > L.fuzzyMatch('guide', 'guide/x.md').score);
});

test('fuzzyFiles: all words must match, best first, ties by path, folders are not listed', () => {
  assert.deepEqual(order('  '), []);
  assert.equal(order('arcmd')[0], 'docs/architecture.md');
  assert.equal(order('docs/arch')[0], 'docs/architecture.md');
  assert.deepEqual(order('docs deep'), ['docs/sub/deep.html']);
  assert.deepEqual(order('zzz'), []);
  assert.equal(order('md').length, 4);
  assert.ok(!order('sub').includes('docs/sub'));
  const r = L.fuzzyFiles(FTREE, 'api')[0];
  assert.equal(r.path, 'docs/API.md');
  assert.deepEqual(r.pos, [5, 6, 7]);
});

test('collectDirs lists every folder path', () => {
  assert.deepEqual(L.collectDirs(FTREE), ['docs', 'docs/sub']);
});

test('fuzzyFiles puts the better match first even when it comes later in the tree', () => {
  const tree = [
    { name: 'a', type: 'directory', children: [{ name: 'old-notes-readme-v2.md', type: 'file', path: 'a/old-notes-readme-v2.md' }] },
    { name: 'readme.md', type: 'file', path: 'readme.md' },
  ];
  assert.deepEqual(L.fuzzyFiles(tree, 'readme').map((r) => r.path), ['readme.md', 'a/old-notes-readme-v2.md']);
});

test('parseColor reads the computed rgb forms', () => {
  assert.deepEqual(L.parseColor('rgb(255, 243, 205)'), [255, 243, 205, 1]);
  assert.deepEqual(L.parseColor('rgba(0, 0, 0, 0.5)'), [0, 0, 0, 0.5]);
  assert.deepEqual(L.parseColor('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
  assert.equal(L.parseColor('none'), null);
  assert.equal(L.parseColor('#fff'), null);
});

test('contrastRatio and pickTextColor: keep a readable colour, fix an unreadable one', () => {
  const white = [255, 255, 255, 1], black = [0, 0, 0, 1], dark = [30, 31, 41, 1], light = [248, 248, 242, 1];
  assert.ok(Math.abs(L.contrastRatio(white, black) - 21) < 0.01);
  const cream = [255, 243, 205, 1];
  assert.ok(L.contrastRatio(cream, light) < 2);                       // the problem in dark mode
  assert.equal(L.pickTextColor(cream, light, dark, light), dark);     // light text on a light fill -> dark text
  assert.equal(L.pickTextColor(cream, dark, dark, light), dark);      // already readable: unchanged
  assert.equal(L.pickTextColor([30, 30, 30, 1], dark, dark, light), light); // dark text on a dark fill -> light text
  assert.equal(L.pickTextColor([68, 71, 90, 1], light, dark, light), light); // the Dracula node colour is fine
});
