#!/usr/bin/env node
// Browser acceptance checks (PRD 13) driven over the Chrome DevTools Protocol, no extra packages
// (Node 22 has a global WebSocket and fetch). Usage:
//   node tests/browser.mjs --base http://127.0.0.1:4100 [--chrome PATH] [--ids AC-04,AC-05] [--verbose]
// Prints one JSON array of {id, ok, note} on stdout. Chrome runs headless with a throw-away profile.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = opt('--base', 'http://127.0.0.1:4100');
const CHROME = opt('--chrome', process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const IDS = (opt('--ids', '') || '').split(',').filter(Boolean);
const VERBOSE = args.includes('--verbose');
const log = (...a) => { if (VERBOSE) console.error('[browser]', ...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 10000, every = 50) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = null; }
    await sleep(every);
  }
  return null;
}

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((l) => l(msg));
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME);
  const dir = mkdtempSync(join(tmpdir(), 'docs-browser-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  const ok = await waitFor(() => existsSync(portFile), 15000, 100);
  if (!ok) { proc.kill(); throw new Error('Chrome did not start'); }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await CDP.connect(`ws://127.0.0.1:${port}${path}`);
  return { cdp, proc, dir };
}

// ---------------------------------------------------------------- page helper
async function openPage(cdp, url, { waitReady = true } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const contexts = [];
  const childSessions = [];
  cdp.on((msg) => {
    if (msg.method === 'Target.attachedToTarget' && msg.sessionId === sessionId
        && msg.params.targetInfo.type === 'iframe') {
      childSessions.push(msg.params.sessionId); // a sandboxed iframe may live in its own process
    }
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    if (msg.method === 'Runtime.executionContextsCleared') contexts.length = 0;
  });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // Collect postMessage reports sent by the fixture page inside the sandboxed iframe.
  await s('Page.addScriptToEvaluateOnNewDocument', { source:
    "window.__reports = []; window.addEventListener('message', function (e) { if (e.data && e.data.type === 'fixture-report') window.__reports.push(e.data); });" });
  const page = {
    targetId, sessionId, contexts,
    async ev(expression, contextId) {
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(u) { await s('Page.navigate', { url: BASE + u }); },
    async ready(timeout = 10000) {
      return waitFor(() => page.ev("document.body && document.body.dataset.state === 'ready'"), timeout);
    },
    // Evaluates inside the (sandboxed) child frame: in its own session if it is out-of-process,
    // otherwise in its execution context.
    async childEval(expression) {
      if (childSessions.length) {
        const sid = childSessions[childSessions.length - 1];
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      }
      const ctx = await page.childContextId();
      if (ctx === null) return null;
      return page.ev(expression, ctx);
    },
    async childContextId() {
      const { frameTree } = await s('Page.getFrameTree');
      const child = frameTree.childFrames && frameTree.childFrames[0];
      if (!child) return null;
      const ctx = contexts.filter((c) => c.auxData && c.auxData.frameId === child.frame.id).pop();
      return ctx ? ctx.id : null;
    },
    async close() { try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ } },
  };
  if (url) {
    await page.goto(url);
    if (waitReady) await page.ready();
  }
  return page;
}

// ---------------------------------------------------------------- the checks
const enc = encodeURIComponent;
const checks = {};

checks['AC-03b'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=README.md');
  const r = await p.ev("({tables: document.querySelectorAll('#preview table').length, boxes: document.querySelectorAll('#preview input[type=checkbox]').length})");
  await p.close();
  return [r.tables === 1 && r.boxes === 2, JSON.stringify(r)];
};

checks['AC-04'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/architecture.md');
  const n = await p.ev("document.querySelectorAll('.mermaid svg').length");
  await p.close();
  return [n === 1, `.mermaid svg count=${n}`];
};

checks['AC-05'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/bad-mermaid.md');
  const r = await p.ev("({box: !!document.querySelector('.mermaid-error'), text: (document.querySelector('.mermaid-error')||{}).textContent || '', h1: (document.querySelector('#preview h1')||{}).textContent || ''})");
  await p.close();
  const ok = r.box && r.text.includes('flowchart LR') && r.text.includes('A --> --> B') && r.h1 === 'Bad Mermaid Page';
  return [ok, `box=${r.box} source_in_box=${r.text.includes('A --> --> B')} h1=${JSON.stringify(r.h1)}`];
};

checks['AC-06'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/flow.html');
  const frames = await p.ev("Array.from(document.querySelectorAll('iframe')).map(f => f.getAttribute('sandbox'))");
  const report = await waitFor(() => p.ev('window.__reports[0] || null'), 8000);
  const color = await waitFor(() => p.childEval("getComputedStyle(document.querySelector('h1')).color"), 5000);
  await p.close();
  const ok = frames.length === 1 && frames[0] === 'allow-scripts allow-popups' && report
    && report.ran === true && report.parentAccess === 'blocked' && report.apiFetch === 'blocked'
    && color === 'rgb(255, 0, 0)';
  return [!!ok, `iframes=${JSON.stringify(frames)} report=${JSON.stringify(report)} h1color=${color}`];
};

checks['AC-07b'] = async (cdp) => {
  const p = await openPage(cdp, '/files/docs/flow.html', { waitReady: false });
  const report = await waitFor(() => p.ev("(function(){var t=document.getElementById('report'); try { var j=JSON.parse(t.textContent); return j.apiFetch==='pending'?null:j; } catch(e){ return null; } })()"), 8000);
  await p.close();
  const ok = report && report.ran === true && report.apiFetch === 'blocked' && report.parentAccess !== 'LEAK';
  return [!!ok, `top-level report=${JSON.stringify(report)}`];
};

checks['AC-09'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=README.md');
  await p.ev("window.__marker = 42; document.querySelector('a[data-internal=\"docs/architecture.md\"]').click(); true");
  const moved = await waitFor(() => p.ev("location.search === '?file=docs/architecture.md' && document.body.dataset.state === 'ready' && document.title.startsWith('docs/architecture.md')"), 8000);
  const r = await p.ev("({marker: window.__marker, search: location.search, selected: (document.querySelector('#tree a.selected')||{}).dataset && document.querySelector('#tree a.selected').dataset.path})");
  await p.close();
  return [!!moved && r.marker === 42 && r.selected === 'docs/architecture.md', JSON.stringify(r)];
};

checks['AC-10'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/links.md');
  const r = await p.ev(`({
    jsHref: document.querySelectorAll('#preview a[href^="javascript"]').length,
    internal: !!document.querySelector('#preview a[data-internal="docs/api.md"]'),
    plain: Array.from(document.querySelectorAll('#preview .plain-link')).map(e => e.tagName + ':' + e.textContent),
    anchorsWithoutHref: Array.from(document.querySelectorAll('#preview a')).filter(a => !a.getAttribute('href')).length
  })`);
  await p.ev("document.querySelector('#preview a[data-internal=\"docs/api.md\"]').click(); true");
  const moved = await waitFor(() => p.ev("location.search === '?file=docs/api.md' && document.body.dataset.state === 'ready' && document.title.startsWith('docs/api.md')"), 8000);
  await p.close();
  const plainOk = r.plain.includes('SPAN:out') && r.plain.includes('SPAN:t');
  return [r.jsHref === 0 && r.internal && plainOk && r.anchorsWithoutHref === 0 && !!moved, JSON.stringify(r) + ` navigated=${!!moved}`];
};

checks['AC-12b'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/big.md');
  const t = await p.ev("(document.querySelector('#preview .state')||{}).textContent");
  await p.close();
  return [t === 'File too large', `state=${JSON.stringify(t)}`];
};

checks['AC-13b'] = async (cdp) => {
  const file = 'docs/中文 筆記.md';
  const p = await openPage(cdp, '/?file=' + file.split('/').map(enc).join('/'));
  const r = await p.ev("({h1: (document.querySelector('#preview h1')||{}).textContent, selected: document.querySelector('#tree a.selected') && document.querySelector('#tree a.selected').dataset.path})");
  await p.close();
  return [r.h1 === 'CJK name' && r.selected === file, JSON.stringify(r)];
};

checks['AC-14b'] = async (cdp) => {
  const p = await openPage(cdp, '/');
  const t = await p.ev("document.getElementById('tree-banners').textContent");
  await p.close();
  return [t.includes('Tree truncated'), `tree banner=${JSON.stringify(t)}`];
};

checks['AC-15'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/utf8-bad.md');
  const r = await p.ev("({banner: document.getElementById('banners').textContent, h1: (document.querySelector('#preview h1')||{}).textContent})");
  await p.close();
  return [r.banner.includes('File contained invalid UTF-8') && r.h1 === 'Bad bytes', JSON.stringify(r)];
};

checks['AC-17'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/subdir/rel.md');
  const w = await waitFor(() => p.ev("(function(){var i=document.querySelector('#preview img'); return i && i.complete && i.naturalWidth>0 ? i.naturalWidth : null;})()"), 8000);
  await p.close();
  return [!!w, `image naturalWidth=${w}`];
};

checks['AC-40'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/architecture.md');
  const first = await p.ev("({open: !!document.querySelector('details[data-dir=\"docs\"]').open, sel: document.querySelector('#tree a.selected') && document.querySelector('#tree a.selected').dataset.path})");
  await p.ev('location.reload(); true');
  await sleep(300);
  await p.ready();
  const reloaded = await p.ev("({search: location.search, open: !!document.querySelector('details[data-dir=\"docs\"]').open, sel: document.querySelector('#tree a.selected') && document.querySelector('#tree a.selected').dataset.path})");
  await p.ev("document.querySelector('#tree a[data-path=\"README.md\"]').click(); true");
  await waitFor(() => p.ev("location.search === '?file=README.md' && document.body.dataset.state === 'ready' && document.title.startsWith('README.md')"), 8000);
  await p.ev('history.back(); true');
  const back = await waitFor(() => p.ev("location.search === '?file=docs/architecture.md' && document.body.dataset.state === 'ready' && document.title.startsWith('docs/architecture.md')"), 8000);
  await p.ev('history.forward(); true');
  const fwd = await waitFor(() => p.ev("location.search === '?file=README.md' && document.body.dataset.state === 'ready' && document.title.startsWith('README.md')"), 8000);
  await p.close();
  const ok = first.open && first.sel === 'docs/architecture.md' && reloaded.search === '?file=docs/architecture.md'
    && reloaded.open && reloaded.sel === 'docs/architecture.md' && back && fwd;
  return [!!ok, JSON.stringify({ first, reloaded, back: !!back, forward: !!fwd })];
};

checks['AC-41'] = async (cdp) => {
  const urls = ['/?file=does/not/exist.md', '/?file=../../etc/hosts', '/?file=.env'];
  const got = [];
  for (const u of urls) {
    const p = await openPage(cdp, u);
    const r = await p.ev(`(async () => ({ state: (document.querySelector('#preview .state')||{}).textContent, shell: (await fetch(location.href)).status }))()`);
    got.push([u, r.state, r.shell]);
    await p.close();
  }
  const ok = got.every(([, state, shell]) => state === 'File not found' && shell === 200);
  return [ok, JSON.stringify(got)];
};

checks['AC-42'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/long.md#bottom');
  await sleep(300);
  const r = await p.ev("(function(){var h=document.getElementById('bottom'); if(!h) return null; var b=h.getBoundingClientRect(); return {top: Math.round(b.top), inView: b.top >= 0 && b.bottom <= window.innerHeight}; })()");
  await p.close();
  return [!!(r && r.inView), JSON.stringify(r)];
};

// ---------------------------------------------------------------- run
const wanted = IDS.length ? IDS : Object.keys(checks);
const out = [];
let browser;
try {
  browser = await launchChrome();
  log('chrome up');
  for (const id of wanted) {
    if (!checks[id]) { out.push({ id, ok: false, note: 'no such browser check' }); continue; }
    try {
      const [ok, note] = await checks[id](browser.cdp);
      out.push({ id, ok, note });
    } catch (e) {
      out.push({ id, ok: false, note: 'exception: ' + e.message });
    }
    log(id, out[out.length - 1].ok);
  }
} catch (e) {
  for (const id of wanted) out.push({ id, ok: false, note: 'browser unavailable: ' + e.message });
} finally {
  if (browser) {
    browser.cdp.close(); browser.proc.kill();
    await sleep(200);
    try { rmSync(browser.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}
console.log(JSON.stringify(out));
process.exit(0);
