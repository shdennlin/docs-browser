// Takes README screenshots of the demo docs through the Chrome DevTools Protocol (Node 22, no dependencies).
// Usage: node tests/screenshot.mjs --base http://127.0.0.1:4790 --out docs/images
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:4790'), OUT = arg('--out', 'docs/images');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'docs-browser-shot-'));
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const pf = join(dir, 'DevToolsActivePort');
for (let i = 0; i < 150 && !existsSync(pf); i++) await sleep(100);
const [port, path] = readFileSync(pf, 'utf8').trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (m, p) => send(m, p, sessionId);
await s('Page.enable'); await s('Runtime.enable');
await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const ev = async (expression) => (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
for (const scheme of ['dark', 'light']) {
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await s('Page.navigate', { url: `${BASE}/?file=architecture/overview.md` });
  for (let i = 0; i < 100; i++) { await sleep(200); if (await ev("document.querySelectorAll('#preview svg, .mermaid svg, article svg').length >= 2")) break; }
  await sleep(800);
  const shot = await s('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `screenshot-${scheme}.png`), Buffer.from(shot.data, 'base64'));
  console.log(scheme, 'svgs:', await ev("document.querySelectorAll('svg').length"));
}
proc.kill(); process.exit(0);
