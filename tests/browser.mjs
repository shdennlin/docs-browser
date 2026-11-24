#!/usr/bin/env node
// Browser acceptance checks (PRD 13) driven over the Chrome DevTools Protocol, no extra packages
// (Node 22 has a global WebSocket and fetch). Usage:
//   node tests/browser.mjs --base http://127.0.0.1:4100 [--chrome PATH] [--ids AC-04,AC-05] [--verbose]
// Prints one JSON array of {id, ok, note} on stdout. Chrome runs headless with a throw-away profile.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = opt('--base', 'http://127.0.0.1:4100');
const CHROME = opt('--chrome', process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const IDS = (opt('--ids', '') || '').split(',').filter(Boolean);
const VERBOSE = args.includes('--verbose');
// Fixture edits for the live-reload checks. Local mode edits files directly; with --docker NAME the
// server runs inside a Linux container and files are edited there with `docker exec`.
const ROOT = opt('--root', '');
const BIN = opt('--bin', '');
const DOCKER = opt('--docker', '');
const CROOT = opt('--croot', '/tmp/work/tests/fixtures/site');
const CBIN = opt('--cbin', '/tmp/target/release/docs-browser');
const fx = (rel) => `${DOCKER ? CROOT : ROOT}/${rel}`;
const ops = DOCKER ? {
  read: (p) => spawnSync('docker', ['exec', DOCKER, 'cat', p], { encoding: 'utf8' }).stdout,
  write: (p, c) => { spawnSync('docker', ['exec', '-i', DOCKER, 'sh', '-c', 'cat > "$1"', 'sh', p], { input: c }); },
  remove: (p) => { spawnSync('docker', ['exec', DOCKER, 'rm', '-f', p]); },
  // 50 rewrites in one container-side loop, so the burst really fits in about a second.
  burst: async (p, n, delayMs) => {
    const script = 'i=0; while [ $i -lt ' + n + ' ]; do { printf "# API\\n\\nwrite %s\\n" $i; [ $i -eq ' + (n - 1) + ' ] && printf "\\nFINAL-47\\n"; } > "$1"; i=$((i+1)); sleep ' + (delayMs / 1000) + '; done';
    spawnSync('docker', ['exec', DOCKER, 'sh', '-c', script, 'sh', p]);
  },
} : {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, c) => writeFileSync(p, c),
  remove: (p) => rmSync(p, { force: true }),
  burst: async (p, n, delayMs) => {
    for (let i = 0; i < n; i++) {
      writeFileSync(p, `# API\n\nwrite ${i}\n` + (i === n - 1 ? '\nFINAL-47\n' : ''));
      await sleep(delayMs);
    }
  },
};
// Runs `fn` with a fixture file edited, and always puts the original content back.
async function withEdit(rel, edit, fn) {
  const original = ops.read(fx(rel));
  try {
    ops.write(fx(rel), edit(original));
    return await fn();
  } finally {
    ops.write(fx(rel), original);
  }
}
function startServer(port) {
  if (DOCKER) {
    spawnSync('docker', ['exec', '-d', DOCKER, CBIN, CROOT, '--port', String(port)]);
    return { stop: () => { spawnSync('docker', ['exec', DOCKER, 'pkill', '-INT', '-f', `docs-browser.*--port ${port}`]); } };
  }
  const proc = spawn(BIN, [ROOT, '--port', String(port)], { stdio: 'ignore' });
  return { stop: () => proc.kill('SIGINT') };
}
async function portAnswers(port, want, timeout = 10000) {
  return waitFor(async () => { try { const r = await fetch(`http://127.0.0.1:${port}/`); return want ? r.ok : false; } catch (e) { return !want; } }, timeout, 100);
}
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
  const flags = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--window-size=1280,800', 'about:blank',
  ];
  // Inside a Linux container Chromium cannot create its sandbox and has a tiny /dev/shm. These flags are
  // used for the throw-away test browser only, never on a desktop.
  if (process.platform === 'linux') flags.splice(1, 0, '--no-sandbox', '--disable-dev-shm-usage');
  const proc = spawn(CHROME, flags, { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  const ok = await waitFor(() => existsSync(portFile), 15000, 100);
  if (!ok) { proc.kill(); throw new Error('Chrome did not start'); }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await CDP.connect(`ws://127.0.0.1:${port}${path}`);
  return { cdp, proc, dir };
}

// ---------------------------------------------------------------- page helper
async function openPage(cdp, url, { waitReady = true, base = BASE, fakeEventSource = false } = {}) {
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
  if (fakeEventSource) {
    // Test-only: the page gets an EventSource that never connects. The test then delivers events itself,
    // at exact moments, so interleavings that depend on server timing can be made deterministic.
    await s('Page.addScriptToEvaluateOnNewDocument', { source:
      "window.__es = []; window.EventSource = function (url) { this.url = url; this.readyState = 1; window.__es.push(this); };" });
  }
  const page = {
    targetId, sessionId, contexts,
    async ev(expression, contextId) {
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(u) { await s('Page.navigate', { url: base + u }); },
    async media(scheme) {
      await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    },
    async viewport(w, h) {
      await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    },
    async mouse(type, x, y, extra = {}) {
      await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    },
    async key(key, code, vk) {
      await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
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
  await p.ev('window.__beforeReload = 1; location.reload(); true');
  await waitFor(() => p.ev("window.__beforeReload === undefined && document.body.dataset.state === 'ready'"), 10000);
  const reloaded = await p.ev("({search: location.search, open: !!document.querySelector('details[data-dir=\"docs\"]').open, sel: document.querySelector('#tree a.selected') && document.querySelector('#tree a.selected').dataset.path})");
  await p.ev("document.querySelector('#tree a[data-path=\"README.md\"]').click(); true");
  await waitFor(() => p.ev("location.search === '?file=README.md' && document.body.dataset.state === 'ready' && document.title.startsWith('README.md')"), 8000);
  await p.ev('history.back(); true');
  const back = await waitFor(() => p.ev("location.search === '?file=docs/architecture.md' && document.body.dataset.state === 'ready' && document.title.startsWith('docs/architecture.md') && (document.querySelector('#preview h1')||{}).textContent === 'Architecture'"), 8000);
  await p.ev('history.forward(); true');
  const fwd = await waitFor(() => p.ev("location.search === '?file=README.md' && document.body.dataset.state === 'ready' && document.title.startsWith('README.md') && (document.querySelector('#preview h1')||{}).textContent === 'Root README'"), 8000);
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
  const r = await p.ev("(function(){var h=document.getElementById('user-content-bottom'); if(!h) return null; var b=h.getBoundingClientRect(); return {top: Math.round(b.top), inView: b.top >= 0 && b.bottom <= window.innerHeight, mainScroll: document.getElementById('main').scrollTop}; })()");
  // Re-opening the same long file without a hash must start at the top. A short file would not prove
  // this (the browser clamps the offset itself), so the page must be as tall as the one just left.
  await p.ev("document.querySelector('#tree a[data-path=\"docs/long.md\"]').click(); true");
  await waitFor(() => p.ev("location.search === '?file=docs/long.md' && location.hash === '' && document.body.dataset.state === 'ready'"), 8000);
  await sleep(200);
  const after = await p.ev("document.getElementById('main').scrollTop");
  await p.close();
  return [!!(r && r.inView && r.mainScroll > 0) && after === 0, JSON.stringify({ anchor: r, scrollAfterNavigation: after })];
};


checks['AC-70'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=README.md');
  const width = () => p.ev("Math.round(document.getElementById('sidebar').getBoundingClientRect().width)");
  const handle = () => p.ev("(function(){var r=document.getElementById('resizer').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + 200};})()");
  const dragTo = async (toX) => {
    const h = await handle();
    await p.mouse('mousePressed', h.x, h.y);
    for (const x of [h.x + (toX - h.x) / 2, toX]) await p.mouse('mouseMoved', x, h.y);
    await p.mouse('mouseReleased', toX, h.y);
    return width();
  };
  const reload = async () => { await p.ev('location.reload(); true'); await sleep(300); await p.ready(); };
  const store = (v) => p.ev(`localStorage.setItem('docs-browser.sidebarWidth', ${JSON.stringify(v)}); true`);
  const out = {};
  try {
    out.start = await width();
    // The grab point inside the 6 px divider must not make the first move jump: +120 px gives exactly +120.
    const h0 = await handle();
    await p.mouse('mousePressed', h0.x, h0.y);
    await p.mouse('mouseMoved', h0.x + 120, h0.y);
    out.duringDrag = await width();
    out.resizingDuringDrag = await p.ev("document.body.classList.contains('resizing')");
    // Losing pointer capture without a pointerup must not leave the drag state stuck.
    await p.ev("document.getElementById('resizer').releasePointerCapture(1); true");
    // Chromium fires `lostpointercapture` when the next pointer event is processed, so move the mouse once
    // (with a real mouse this happens at once).
    await p.mouse('mouseMoved', h0.x + 121, h0.y);
    await sleep(80);
    out.resizingAfterLostCapture = await p.ev("document.body.classList.contains('resizing')");
    await p.mouse('mouseReleased', h0.x + 120, h0.y);
    out.afterDrag = await width();
    out.stored = await p.ev("localStorage.getItem('docs-browser.sidebarWidth')");
    await reload();
    out.afterReload = await width();
    out.tooWide = await dragTo(1270);   // 60% of the 1280 px test window is 768
    out.tooNarrow = await dragTo(5);    // the minimum is 180
    // A stored value from another screen or version is clamped, or ignored when it is not a plain integer.
    await store('5000'); await reload(); out.storedTooBig = await width();
    await store('12');   await reload(); out.storedTooSmall = await width();
    await store(' 420 '); await reload(); out.storedPadded = await width();
    await store('abc');  await reload(); out.storedGarbage = await width();
    // The chosen width survives a smaller window and comes back when the window grows again.
    await store('600');  await reload(); out.chosen600 = await width();
    await p.viewport(800, 800); await sleep(150); out.inSmallWindow = await width();   // 60% of 800 is 480
    await p.viewport(1280, 800); await sleep(150); out.afterRegrow = await width();
    const h = await handle();
    for (const n of [1, 2]) {           // two clicks: a double click resets the width
      await p.mouse('mousePressed', h.x, h.y, { clickCount: n });
      await p.mouse('mouseReleased', h.x, h.y, { clickCount: n });
    }
    await sleep(100);
    out.afterDoubleClick = await width();
    out.aria = await p.ev("(function(){var r=document.getElementById('resizer'); return [r.getAttribute('aria-valuemin'), r.getAttribute('aria-valuenow'), r.getAttribute('aria-valuemax')].join('/');})()");
    await p.ev("document.getElementById('resizer').focus(); true");
    await p.key('ArrowRight', 'ArrowRight', 39);
    out.keyRight = await width();
    await p.key('ArrowLeft', 'ArrowLeft', 37);
    out.keyLeft = await width();
  } finally {
    await p.ev("localStorage.removeItem('docs-browser.sidebarWidth'); true");
    await p.close();
  }
  const near = (a, b, d = 1) => Math.abs(a - b) <= d;
  const ok = out.start === 300 && near(out.duringDrag, 420) && out.resizingDuringDrag === true
    && out.resizingAfterLostCapture === false && near(out.afterDrag, 420) && out.stored === String(out.afterDrag)
    && near(out.afterReload, out.afterDrag) && out.tooWide === 768 && out.tooNarrow === 180
    && out.storedTooBig === 768 && out.storedTooSmall === 180 && out.storedPadded === 300 && out.storedGarbage === 300
    && out.chosen600 === 600 && out.inSmallWindow === 480 && out.afterRegrow === 600
    && out.afterDoubleClick === 300 && out.aria === '180/300/768' && out.keyRight === 316 && out.keyLeft === 300;
  return [ok, JSON.stringify(out)];
};

// ---------------------------------------------------------------- live reload (M4)
const READY = "document.body.dataset.state === 'ready'";
const loadCounter = "(function(){ var f=document.querySelector('iframe.html-frame'); window.__loads=0; f.addEventListener('load', function(){ window.__loads++; }); return true; })()";

checks['AC-43'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/long.md');
  await p.ev("document.getElementById('main').scrollTop = 3000; window.__marker = 43; true");
  const before = await p.ev("document.getElementById('main').scrollTop");
  const t0 = Date.now();
  const res = await withEdit('docs/long.md', (c) => c + '\n\nLIVE-43-MARK\n', async () => {
    const shown = await waitFor(() => p.ev("document.getElementById('preview').textContent.includes('LIVE-43-MARK')"), 2000, 25);
    return { shown: !!shown, ms: Date.now() - t0 };
  });
  const after = await p.ev("({scroll: document.getElementById('main').scrollTop, marker: window.__marker})");
  await p.close();
  const ok = res.shown && after.marker === 43 && Math.abs(after.scroll - before) <= 5;
  return [ok, JSON.stringify({ ...res, scrollBefore: before, scrollAfter: after.scroll, marker: after.marker })];
};

checks['AC-44'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/flow.html');
  await p.ev(loadCounter);
  const loads = await withEdit('docs/flow.html', (c) => c, async () => waitFor(() => p.ev('window.__loads >= 1 ? window.__loads : null'), 2000, 25));
  await p.close();
  return [!!loads, `iframe load events after the edit=${loads}`];
};

// The same behaviour as the AC-45 steps above, but with the events delivered by the test at exact moments
// (a fake EventSource), so it does not depend on how the server's debounce lines up with the client's.
async function deterministicRaces(cdp) {
  const emit = (p, ev) => p.ev(`window.__es[0].onmessage({ data: ${JSON.stringify(JSON.stringify(ev))} }); true`);
  const out = { staleTimer: null, notFoundThenCreated: null };

  // A: `changed` arrives (a 250 ms re-render timer starts), then the file is deleted and `removed`
  // arrives before the timer fires. The timer must not turn "no longer exists" into an error page, and
  // the preview must come back when the file returns.
  const relA = 'docs/live-45-race.md';
  ops.write(fx(relA), '# Race A\n');
  let p = await openPage(cdp, '/?file=' + relA, { fakeEventSource: true });
  try {
    await emit(p, { type: 'changed', path: relA });
    ops.remove(fx(relA));
    await emit(p, { type: 'removed', path: relA });
    await sleep(900); // the stale timer would have fired by now
    const text = await p.ev("(document.querySelector('#preview .state')||{}).textContent");
    ops.write(fx(relA), '# Race A back\n');
    await sleep(700); // the real server's watcher must list the file before the client re-reads the tree
    await emit(p, { type: 'tree' });
    const back = await waitFor(() => p.ev("(document.querySelector('#preview h1')||{}).textContent === 'Race A back'"), 3000, 50);
    out.staleTimer = { stateAfterTimer: text, restored: !!back };
  } finally {
    ops.remove(fx(relA));
    await p.close();
  }

  // B: a deep link to a file that does not exist yet shows "File not found"; when the file appears and a
  // `tree` event lists it, the preview must restore itself (a 404 must mark the file as missing).
  const relB = 'docs/live-45-late.md';
  ops.remove(fx(relB));
  p = await openPage(cdp, '/?file=' + relB, { fakeEventSource: true });
  try {
    const first = await p.ev("(document.querySelector('#preview .state')||{}).textContent");
    ops.write(fx(relB), '# Late file\n');
    await sleep(700);
    await emit(p, { type: 'tree' });
    const shown = await waitFor(() => p.ev("(document.querySelector('#preview h1')||{}).textContent === 'Late file'"), 3000, 50);
    out.notFoundThenCreated = { first, restored: !!shown };
  } finally {
    ops.remove(fx(relB));
    await p.close();
  }
  out.ok = !!(out.staleTimer && out.staleTimer.stateAfterTimer === 'File no longer exists' && out.staleTimer.restored
    && out.notFoundThenCreated && out.notFoundThenCreated.first === 'File not found' && out.notFoundThenCreated.restored);
  return out;
}

checks['AC-45'] = async (cdp) => {
  const rel = 'docs/live-45.md';
  ops.remove(fx(rel));
  const p = await openPage(cdp, '/?file=docs/api.md');
  try {
    ops.write(fx(rel), '# Live 45\n');
    const listed = await waitFor(() => p.ev(`!!document.querySelector('#tree a[data-path="${rel}"]')`), 2500, 50);
    await p.goto('/?file=' + rel);
    await p.ready();
    const first = await p.ev("(document.querySelector('#preview h1')||{}).textContent");
    ops.remove(fx(rel));
    const gone = await waitFor(() => p.ev("(document.querySelector('#preview .state')||{}).textContent === 'File no longer exists'"), 2000, 25);
    const urlKept = await p.ev(`location.search === '?file=${rel}'`);
    ops.write(fx(rel), '# Live 45 again\n');
    const back = await waitFor(() => p.ev("(document.querySelector('#preview h1')||{}).textContent === 'Live 45 again'"), 2500, 25);
    // An edit followed by a delete inside the debounce window must not leave an error page behind:
    // a re-render still pending for the edit must not overwrite "no longer exists".
    ops.write(fx(rel), '# Live 45 edited\n');
    await sleep(300); // the `changed` event has arrived and the client's 250 ms re-render timer is pending
    ops.remove(fx(rel));
    const goneStates = ['File no longer exists', 'File not found'];
    const gone2 = await waitFor(() => p.ev("['File no longer exists', 'File not found'].indexOf((document.querySelector('#preview .state')||{}).textContent) >= 0"), 2500, 25);
    await sleep(1200); // long enough for the stale re-render and the removal event to both land
    const stillGone = await p.ev("(document.querySelector('#preview .state')||{}).textContent");
    ops.write(fx(rel), '# Live 45 third\n');
    const back2 = await waitFor(() => p.ev("(document.querySelector('#preview h1')||{}).textContent === 'Live 45 third'"), 2500, 25);
    const det = await deterministicRaces(cdp);
    return [!!listed && first === 'Live 45' && !!gone && urlKept && !!back && !!gone2 && goneStates.includes(stillGone) && !!back2 && det.ok,
      JSON.stringify({ listed: !!listed, first, goneMessage: !!gone, urlKept, restored: !!back, quickDeleteGone: !!gone2, afterWait: stillGone, restoredAgain: !!back2, deterministic: det })];
  } finally {
    ops.remove(fx(rel));
    await p.close();
  }
};

checks['AC-46'] = async (cdp) => {
  const rel = 'docs/new-46.md';
  ops.remove(fx(rel));
  const p = await openPage(cdp, '/?file=docs/architecture.md');
  try {
    ops.write(fx(rel), '# New 46\n');
    const appeared = await waitFor(() => p.ev(`!!document.querySelector('#tree a[data-path="${rel}"]')`), 2500, 50);
    const stillOpen = await p.ev("!!document.querySelector('details[data-dir=\"docs\"]').open");
    ops.remove(fx(rel));
    const vanished = await waitFor(() => p.ev(`!document.querySelector('#tree a[data-path="${rel}"]')`), 2500, 50);
    return [!!appeared && stillOpen && !!vanished, JSON.stringify({ appeared: !!appeared, docsStillExpanded: stillOpen, vanished: !!vanished })];
  } finally {
    ops.remove(fx(rel));
    await p.close();
  }
};

checks['AC-47'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/api.md');
  const count = () => p.ev("performance.getEntriesByType('resource').filter(function(e){ return e.name.indexOf('/api/file') >= 0; }).length");
  const base = await count();
  const original = ops.read(fx('docs/api.md'));
  try {
    const t0 = Date.now();
    await ops.burst(fx('docs/api.md'), 50, 20);
    const burstMs = Date.now() - t0;
    await sleep(2000);
    const renders = (await count()) - base;
    const final = await p.ev("document.getElementById('preview').textContent.includes('FINAL-47')");
    return [renders <= 5 && final && burstMs <= 2000, JSON.stringify({ rerenders: renders, finalContentShown: final, burstMs })];
  } finally {
    ops.write(fx('docs/api.md'), original);
    await p.close();
  }
};

checks['AC-52'] = async (cdp) => {
  const PORT = 4103;
  const rel = 'docs/after-restart-52.md';
  ops.remove(fx(rel));
  let server = startServer(PORT);
  try {
    if (!(await portAnswers(PORT, true))) return [false, 'test server did not start'];
    const p = await openPage(cdp, '/?file=README.md', { base: `http://127.0.0.1:${PORT}` });
    await p.ev('window.__marker = 52; true');
    await sleep(500); // let the EventSource connect
    server.stop();
    const down = await waitFor(() => p.ev("document.getElementById('live-status').textContent.indexOf('Server unreachable') >= 0 && !document.getElementById('live-status').hidden"), 15000, 100);
    ops.write(fx(rel), '# After restart\n');
    await portAnswers(PORT, false, 5000);
    server = startServer(PORT);
    await portAnswers(PORT, true);
    const cleared = await waitFor(() => p.ev("document.getElementById('live-status').hidden"), 25000, 100);
    const refetched = await waitFor(() => p.ev(`!!document.querySelector('#tree a[data-path="${rel}"]')`), 10000, 100);
    const marker = await p.ev('window.__marker');
    await p.close();
    return [!!down && !!cleared && !!refetched && marker === 52,
      JSON.stringify({ bannerShown: !!down, bannerCleared: !!cleared, treeRefetched: !!refetched, noManualReload: marker === 52 })];
  } finally {
    server.stop();
    ops.remove(fx(rel));
    await sleep(300);
  }
};

checks['AC-53'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=link-in/architecture.md');
  const shown = await withEdit('docs/architecture.md', (c) => c + '\n\nALIAS-53-MARK\n', async () =>
    waitFor(() => p.ev("document.getElementById('preview').textContent.includes('ALIAS-53-MARK')"), 2000, 25));
  await p.close();
  return [!!shown, `view of link-in/architecture.md re-rendered after editing docs/architecture.md: ${!!shown}`];
};

checks['AC-54'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/flow.html');
  await p.ev(loadCounter);
  const loads = await withEdit('docs/style.css', (c) => c + '\n/* live-54 */\n', async () => waitFor(() => p.ev('window.__loads >= 1 ? window.__loads : null'), 2000, 25));
  await p.close();
  return [!!loads, `iframe load events after editing style.css=${loads}`];
};

// ---- AC-71: Dracula in dark mode, rainbow headings, light mode unchanged
checks['AC-71'] = async (cdp) => {
  const p = await openPage(cdp, null);
  try {
    await p.media('dark');
    await p.goto('/?file=docs/code.md'); await p.ready();
    const cs = (sel, prop) => p.ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}))['${prop}']`);
    const dark = {
      bg: await cs('body', 'backgroundColor'), fg: await cs('body', 'color'),
      h1: await cs('#preview h1', 'color'), h2: await cs('#preview h2', 'color'),
      kw: await p.ev("(function(){var k=document.querySelector('#preview .hljs-keyword');return k?getComputedStyle(k).color:null})()"),
      link: await cs('#preview a', 'color'),
    };
    await p.goto('/?file=docs/architecture.md'); await p.ready();
    await waitFor(() => p.ev("!!document.querySelector('#preview .mermaid svg')"), 10000, 100);
    const mer = await p.ev("(function(){var n=document.querySelector('#preview .mermaid svg .node rect, #preview .mermaid svg .node polygon, #preview .mermaid svg .node path');return n?getComputedStyle(n).fill:null})()");
    const edge = await p.ev("(function(){var e=document.querySelector('#preview .mermaid svg .flowchart-link, #preview .mermaid svg path.flowchart-link');return e?getComputedStyle(e).stroke:null})()");
    await p.media('light');
    await p.goto('/?file=docs/code.md'); await p.ready();
    const light = { bg: await cs('body', 'backgroundColor'), h1: await cs('#preview h1', 'color'), fg: await cs('body', 'color') };
    const want = { bg: 'rgb(40, 42, 54)', fg: 'rgb(248, 248, 242)', h1: 'rgb(255, 85, 85)', h2: 'rgb(255, 184, 108)', link: 'rgb(139, 233, 253)' };
    const ok = dark.bg === want.bg && dark.fg === want.fg && dark.h1 === want.h1 && dark.h2 === want.h2 && dark.link === want.link
      && dark.kw !== null && dark.kw !== dark.fg
      && mer === 'rgb(68, 71, 90)' && edge === 'rgb(139, 233, 253)'
      && light.bg !== want.bg && light.h1 === light.fg;
    return [ok, JSON.stringify({ dark, mer, edge, light })];
  } finally { await p.close(); }
};

// ---- AC-72: type badges and expand/collapse all
checks['AC-72'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=README.md');
  try {
    const badges = await p.ev("(function(){var o={};document.querySelectorAll('#tree a[data-path]').forEach(function(a){o[a.dataset.path]=(a.querySelector('.badge')||{}).textContent});return o})()");
    const openCount = () => p.ev("document.querySelectorAll('#tree details[open]').length");
    const total = await p.ev("document.querySelectorAll('#tree details').length");
    await p.ev("document.getElementById('collapse-all').click(); true");
    const afterCollapse = await openCount();
    await p.ev("document.getElementById('expand-all').click(); true");
    const afterExpand = await openCount();
    await p.ev("document.getElementById('collapse-all').click(); true");
    const again = await openCount();
    const ok = badges['README.md'] === 'MD' && badges['docs/flow.html'] === 'HTML' && badges['docs/architecture.md'] === 'MD'
      && total >= 2 && afterCollapse === 0 && afterExpand === total && again === 0;
    return [ok, JSON.stringify({ badges: [badges['README.md'], badges['docs/flow.html']], total, afterCollapse, afterExpand, again })];
  } finally { await p.close(); }
};

// ---- AC-73: fuzzy file name search (flat list, best match first, full path)
checks['AC-73'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=README.md');
  try {
    const typeIn = (v) => p.ev(`(function(){var i=document.getElementById('search');i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const files = () => p.ev("Array.from(document.querySelectorAll('#tree a[data-path]')).map(function(a){return a.dataset.path})");
    await p.ev("document.getElementById('collapse-all').click(); true");
    await typeIn('arcmd');                      // letters in order, not a substring
    const f1 = await files();
    const shape = await p.ev("(function(){var a=document.querySelector('#tree a[data-path]');return {text:a.textContent,marks:Array.from(a.querySelectorAll('mark')).map(function(m){return m.textContent}).join(''),flat:!document.querySelector('#tree details'),badge:(a.querySelector('.badge')||{}).textContent}})()");
    await typeIn('mda');                        // wrong order: nothing
    const wrongOrder = await p.ev("(document.querySelector('#tree .tree-empty')||{}).textContent");
    await typeIn('docs flow');                  // two words, all must match
    const f2 = await files();
    await typeIn('zzzz-nothing');
    const none = await p.ev("(document.querySelector('#tree .tree-empty')||{}).textContent");
    await typeIn('');
    const tree = await p.ev("({details:document.querySelectorAll('#tree details').length, open:document.querySelectorAll('#tree details[open]').length, flat:!!document.querySelector('#tree ul.fuzzy-list')})");
    // clicking a result opens the file
    await typeIn('srch-tar');
    await p.ev("document.querySelector('#tree a[data-path]').click(); true");
    await waitFor(() => p.ev("(document.querySelector('#preview h1')||{}).textContent === 'Search target'"), 5000, 50);
    await typeIn('');
    await p.ev("document.activeElement && document.activeElement.blur(); true");
    await p.key('/', 'Slash', 191);
    const focused = await p.ev("document.activeElement && document.activeElement.id");
    const ok = f1[0] === 'docs/architecture.md' && shape.text.includes('docs/architecture.md') && shape.marks.length >= 5 && shape.flat && shape.badge === 'MD'
      && wrongOrder === 'No file name matches' && f2[0] === 'docs/flow.html' && none === 'No file name matches'
      && tree.details >= 2 && tree.open === 0 && !tree.flat && focused === 'search';
    return [ok, JSON.stringify({ f1: f1.slice(0, 3), shape, wrongOrder, f2: f2.slice(0, 2), none, tree, focused })];
  } finally { await p.close(); }
};

// ---- AC-74: full-text search
checks['AC-74'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=README.md');
  try {
    await p.ev("document.getElementById('mode-contents').click(); true");
    const typeIn = (v) => p.ev(`(function(){var i=document.getElementById('search');i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await typeIn('x');
    await waitFor(() => p.ev("/at least 2/.test(document.getElementById('search-results').textContent)"), 3000, 50);
    await typeIn('ZEBRA-needle');
    await waitFor(() => p.ev("document.querySelectorAll('#search-results a.result').length > 0"), 5000, 50);
    const shown = await p.ev("(function(){var r=document.querySelector('#search-results a.result');return {path:r.dataset.path,mark:(r.querySelector('mark')||{}).textContent,line:r.querySelector('.lineno').textContent,treeHidden:document.getElementById('tree').hidden,n:document.querySelectorAll('#search-results a.result').length}})()");
    await p.ev("document.querySelector('#search-results a.result').click(); true");
    await waitFor(() => p.ev("(document.querySelector('#preview h1')||{}).textContent === 'Search target'"), 5000, 50);
    const url = await p.ev('location.search');
    await typeIn('nothing-matches-this-text');
    await waitFor(() => p.ev("/No file contains/.test(document.getElementById('search-results').textContent)"), 5000, 50);
    // the API: short query and hidden folder
    const api = await p.ev("(async function(){var a=await fetch('/api/search?q=a');var b=await (await fetch('/api/search?q=hidden')).json();return {short:a.status,hiddenFiles:b.results.map(function(r){return r.path})}})()");
    const ok = shown.path === 'docs/search-target.md' && shown.mark === 'zebra-needle' && shown.line === '3:' && shown.treeHidden && shown.n === 1
      && url === '?file=docs/search-target.md' && api.short === 400 && !api.hiddenFiles.some((x) => x.startsWith('.hidden'));
    return [ok, JSON.stringify({ shown, url, api })];
  } finally { await p.close(); }
};

// ---- AC-75: folder buttons, full-panel HTML, outline, wrap toggle, settings
checks['AC-75'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/code.md');
  try {
    const q = (e) => p.ev(e);
    const tops = await q("Array.from(document.querySelectorAll('#mode-row button')).map(function(b){return Math.round(b.getBoundingClientRect().top)})");
    const rowFits = await q("(function(){var r=document.getElementById('mode-row');return r.scrollWidth <= r.clientWidth})()");
    const oneLine = tops.length === 5 && Math.max(...tops) - Math.min(...tops) <= 2 && rowFits;
    // outline: hidden panel, hover/pin shows it, entries scroll
    const outline = await q("(function(){var w=document.getElementById('outline-wrap');var a=Array.from(document.querySelectorAll('#outline a')).map(function(x){return x.textContent+'|'+x.className});return {shown:!w.hidden,a:a,panel:getComputedStyle(document.getElementById('outline')).display}})()");
    await q("document.getElementById('outline-toggle').click(); true");
    const pinned = await q("getComputedStyle(document.getElementById('outline')).display");
    const curStyle = await q("(function(){var a=document.querySelector('#outline a.current');var s=getComputedStyle(a);return {shadow:s.boxShadow,border:s.borderLeftWidth,weight:s.fontWeight,bg:s.backgroundColor}})()");
    await q("document.querySelector('#outline a.l2').click(); true");
    const hashAfter = await q('location.hash');
    await q("document.getElementById('outline-toggle').click(); true");
    // folder buttons: collapse all, then expand only docs/ subtree
    await q("document.getElementById('collapse-all').click(); true");
    await q("document.querySelector('#tree details[data-dir=\"docs\"] > summary .folder-btn[data-action=expand]').click(); true");
    const docsOpen = await q("(function(){var d=document.querySelector('#tree details[data-dir=\"docs\"]');return d.open && d.querySelectorAll('details[open]').length === d.querySelectorAll('details').length})()");
    await q("document.querySelector('#tree details[data-dir=\"docs\"] > summary .folder-btn[data-action=collapse]').click(); true");
    const docsClosed = await q("document.querySelectorAll('#tree details[open]').length");
    // wrap toggle
    const wrap0 = await q("getComputedStyle(document.querySelector('#tree a')).whiteSpace");
    await q("document.getElementById('wrap-toggle').click(); true");
    const wrap1 = await q("getComputedStyle(document.querySelector('#tree a')).whiteSpace");
    // settings: open, uncheck wrap sync, full width markdown, reset
    await q("document.getElementById('settings-open').click(); true");
    const dlg = await q("({open:!document.getElementById('settings').hidden, wrapChecked:document.getElementById('set-wrap').checked})");
    await q("document.getElementById('set-wide').click(); true");
    const wide = await q("getComputedStyle(document.getElementById('preview')).maxWidth");
    await q("document.getElementById('settings-reset').click(); true");
    const afterReset = await q("({wrap:getComputedStyle(document.querySelector('#tree a')).whiteSpace, max:getComputedStyle(document.getElementById('preview')).maxWidth, ls:localStorage.getItem('docs-browser.fullWidth')})");
    await p.key('Escape', 'Escape', 27);
    const closed = await q("document.getElementById('settings').hidden");
    // folder icons: a closed and an open one
    const icons = await q("(function(){var d=document.querySelector('#tree details[data-dir=\"docs\"]');var s=d.querySelector('summary');var m=function(){var c=getComputedStyle(s,'::before');return (c.maskImage&&c.maskImage!=='none'?c.maskImage:c.webkitMaskImage)||'none'};var o=d.open;d.open=false;var closed=m();d.open=true;var open=m();d.open=o;return {closedSet:closed!=='none',differs:closed!==open,w:getComputedStyle(s,'::before').width}})()");
    // outline colours (dark) and the highlighted section while scrolling
    await p.media('dark');
    await p.goto('/?file=docs/outline.md'); await p.ready();
    const colours = await q("Array.from(document.querySelectorAll('#outline a')).slice(0,3).map(function(a){return a.className+':'+getComputedStyle(a).color})");
    const heads = await q("Array.from(document.querySelectorAll('#preview h1[id],#preview h2[id],#preview h3[id]')).length");
    await q("(function(){var h=document.querySelectorAll('#preview h2[id]')[2]; var m=document.getElementById('main'); m.scrollTop = h.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop; return true})()");
    await sleep(150);
    const spy = await q("(function(){var c=document.querySelectorAll('#outline a.current');var hs=document.querySelectorAll('#preview h2[id]');return {n:c.length,text:c[0]&&c[0].textContent,want:hs[2].textContent}})()");
    await p.media('light');
    // nowrap + narrow list: selecting a wide name must not scroll the list sideways
    await q("localStorage.setItem('docs-browser.sidebarWidth','180'); localStorage.setItem('docs-browser.wrapNames','0'); true");
    await p.goto('/?file=README.md'); await p.ready();
    await q("document.getElementById('sidebar').style.fontSize = '26px'; true"); // make the rows wider than the list
    // a real mouse click, as a user does, on the visible part of the row
    await q("document.querySelector('#tree details[data-dir=\"docs\"]').open = true; true");
    const pt = await q("(function(){var a=document.querySelector('#tree a[data-path=\"docs/search-target.md\"]');a.scrollIntoView({block:'center'});document.getElementById('side-scroll').scrollLeft=0;var r=a.getBoundingClientRect();var s=document.getElementById('sidebar').getBoundingClientRect();return {x:Math.min(r.left+60,s.right-30),y:r.top+r.height/2}})()");
    await p.mouse('mousePressed', pt.x, pt.y); await p.mouse('mouseReleased', pt.x, pt.y);
    await sleep(400);
    const dbg = await q("(function(){var a=document.querySelector('#tree a[data-path=\"docs/search-target.md\"]').getBoundingClientRect();var s=document.getElementById('sidebar');return {linkW:Math.round(a.width),linkL:Math.round(a.left),vw:s.clientWidth,sw:s.scrollWidth}})()");
    const side = await q("({sl:document.getElementById('side-scroll').scrollLeft, wide:document.getElementById('side-scroll').scrollWidth > document.getElementById('side-scroll').clientWidth, tb:Math.round(document.getElementById('toolbar').getBoundingClientRect().left - document.getElementById('sidebar').getBoundingClientRect().left)})");
    // scrolled far to the right, every control is still in view
    // the outer panel must never scroll (a browser may do it on focus); it snaps back at once
    const outerBefore = await q("(function(){var s=document.getElementById('sidebar');var d=document.createElement('div');d.id='probe-wide';d.style.cssText='width:2000px;height:1px';s.appendChild(d);s.scrollLeft=60;return s.scrollLeft})()");
    await sleep(100);
    const outerLeft = await q("document.getElementById('sidebar').scrollLeft");
    await q("document.getElementById('probe-wide').remove(); true");
    await q("document.getElementById('side-scroll').scrollLeft = 10000; true");
    const farRight = await q("(function(){var sb=document.getElementById('sidebar').getBoundingClientRect();var bs=Array.from(document.querySelectorAll('#search-row > *, #mode-row > button')).map(function(b){return b.getBoundingClientRect()});return {all:bs.every(function(r){return r.left>=sb.left-1&&r.right<=sb.right+1}),n:bs.length,moved:document.getElementById('side-scroll').scrollLeft>0}})()");
    await q("localStorage.clear(); true");
    // HTML fills the right panel
    await p.goto('/?file=docs/flow.html'); await p.ready();
    await waitFor(() => p.ev("!!document.querySelector('iframe.html-frame')"), 5000, 50);
    const full = await q("(function(){var m=document.getElementById('main').getBoundingClientRect(),f=document.querySelector('iframe.html-frame').getBoundingClientRect();return {dw:Math.round(m.width-f.width),dl:Math.round(f.left-m.left),dt:Math.round(f.top-m.top),outlineHidden:document.getElementById('outline-wrap').hidden}})()");
    const ok = oneLine && outline.shown && outline.a.length >= 2 && outline.a.some((x) => x.endsWith('|l2')) && outline.panel === 'none'
      && pinned === 'block' && curStyle.shadow === 'none' && curStyle.border === '0px' && Number(curStyle.weight) >= 600 && curStyle.bg !== 'rgba(0, 0, 0, 0)' && hashAfter.length > 1 && docsOpen === true && docsClosed === 0
      && wrap0 !== 'nowrap' && wrap1 === 'nowrap' && dlg.open && dlg.wrapChecked === false && wide === 'none'
      && afterReset.wrap !== 'nowrap' && afterReset.max !== 'none' && closed === true
      && colours[0] === 'l1 current:rgb(255, 85, 85)' && colours[1] === 'l2:rgb(255, 184, 108)' && spy.n === 1 && spy.text === spy.want && icons.closedSet && icons.differs && icons.w === '14px'
      && side.wide && dbg.linkW > dbg.vw && side.sl === 0 && side.tb === 8 && outerBefore > 0 && outerLeft === 0 && farRight.all && farRight.moved && farRight.n === 8
      && full.dw <= 1 && full.dl === 0 && full.dt === 0 && full.outlineHidden === true;
    return [ok, JSON.stringify({ outline, pinned, curStyle, hashAfter, docsOpen, docsClosed, wrap0, wrap1, dlg, wide, afterReset, closed, tops, colours, spy, side, outerLeft, farRight, dbg, icons, full })];
  } finally { await p.close(); }
};

// ---- AC-76: light/dark toggle, quote contrast
checks['AC-76'] = async (cdp) => {
  const p = await openPage(cdp, null);
  try {
    const q = (e) => p.ev(e);
    const bg = () => q("getComputedStyle(document.body).backgroundColor");
    const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    await p.media('light');
    await p.goto('/?file=README.md'); await p.ready();
    const light0 = await bg();
    await q("localStorage.removeItem('docs-browser.theme'); true");
    await q("document.getElementById('theme-toggle').click(); true");           // light -> dark
    const dark1 = await bg();
    const links = await q("({l:document.getElementById('hl-light').media,d:document.getElementById('hl-dark').media})");
    await q("document.getElementById('theme-toggle').click(); true");           // dark -> light
    const light2 = await bg();
    await q("document.getElementById('theme-toggle').click(); true");           // dark again, then reload
    await p.goto('/?file=docs/code.md'); await p.ready();
    const afterReload = await bg();
    const stored = await q("localStorage.getItem('docs-browser.theme')");
    // quote contrast in dark
    await q("(function(){var b=document.createElement('blockquote');b.textContent='quote';document.getElementById('preview').appendChild(b);return true})()");
    const qc = await q("(function(){var b=document.querySelector('#preview blockquote');return [getComputedStyle(b).color,getComputedStyle(document.body).backgroundColor]})()");
    // reset follows the system again (system is light here)
    await q("document.getElementById('settings-open').click(); document.getElementById('settings-reset').click(); true");
    const afterReset = await bg();
    const storedAfter = await q("localStorage.getItem('docs-browser.theme')");
    // a bad stored value is ignored
    await q("localStorage.setItem('docs-browser.theme','purple'); true");
    await p.goto('/?file=README.md'); await p.ready();
    const bad = await q("document.documentElement.dataset.theme || 'none'");
    await q("localStorage.clear(); true");
    const D = 'rgb(40, 42, 54)';
    const ok = light0 !== D && dark1 === D && links.l === 'not all' && links.d === 'all' && light2 === 'rgb(255, 255, 255)'
      && afterReload === D && stored === 'dark' && ratio(qc[0], qc[1]) >= 7
      && afterReset === 'rgb(255, 255, 255)' && storedAfter === null && bad === 'none';
    return [ok, JSON.stringify({ light0, dark1, links, light2, afterReload, stored, qc, ratio: ratio(qc[0], qc[1]).toFixed(1), afterReset, storedAfter, bad })];
  } finally { await p.close(); }
};

// ---- AC-77: contents links and the outline really jump (emoji, &, ?, duplicate headings)
checks['AC-77'] = async (cdp) => {
  const p = await openPage(cdp, '/?file=docs/toc.md');
  try {
    const q = (e) => p.ev(e);
    const topOf = (text, nth = 0) => q(`(function(){var hs=Array.from(document.querySelectorAll('#preview h1,#preview h2,#preview h3')).filter(function(h){return h.textContent.indexOf(${JSON.stringify(text)})===0});var h=hs[${nth}];if(!h)return 'no-heading';var m=document.getElementById('main').getBoundingClientRect();return Math.round(h.getBoundingClientRect().top-m.top)+0})()`);
    const results = {};
    const near = (v) => { v = Number(v); return v >= -2 && v <= 80; };
    // the document's own contents links
    for (const [href, text, nth] of [['#executive-summary', 'Executive Summary', 0], ['#-automation-mode', '🤖 Automation Mode', 0], ['#how-to-choose', 'How to Choose?', 0], ['#threat-detection--response', '🛡️ Threat', 0], ['#repeat-1', 'Repeat', 1], ['#%EF%B8%8F-threat-detection--response', '🛡️ Threat', 0]]) {
      await q("document.getElementById('main').scrollTop = 0; true");
      await q(`(function(){var a=document.querySelector('#preview a[data-anchor=${JSON.stringify(decodeURIComponent(href.slice(1)))}]');if(!a)return false;a.click();return true})()`);
      await sleep(250);
      results['toc ' + href] = [await topOf(text, nth), await q('location.hash')];
    }
    // the floating outline
    const n = await q("document.querySelectorAll('#outline a').length");
    results.outlineCount = n;
    for (const i of [2, 3, 4, 5, 6]) {
      await q("document.getElementById('main').scrollTop = 0; true");
      const label = await q(`document.querySelectorAll('#outline a')[${i}].textContent`);
      await q(`document.querySelectorAll('#outline a')[${i}].click(); true`);
      await sleep(250);
      results['outline ' + i] = [label, await q(`(function(){var h=Array.from(document.querySelectorAll('#preview h1[id],#preview h2[id],#preview h3[id]'))[${i}];if(!h)return 'no-heading';var m=document.getElementById('main').getBoundingClientRect();return String(Math.round(h.getBoundingClientRect().top-m.top)+0)})()`)];
    }
    // reload with the hash in the address: lands on the heading
    await p.goto('/?file=docs/toc.md#-automation-mode'); await p.ready();
    await sleep(300);
    results.deepLink = await topOf('🤖 Automation Mode');
    const tocOk = Object.keys(results).filter((k) => k.startsWith('toc ')).every((k) => near(results[k][0]) && results[k][1].length > 1);
    const outOk = [2, 3, 4, 5, 6].every((i) => near(results['outline ' + i][1]));
    const ok = tocOk && outOk && results.outlineCount === 8 && near(results.deepLink);
    return [ok, JSON.stringify(results)];
  } finally { await p.close(); }
};

// ---- AC-78: copy the file name
checks['AC-78'] = async (cdp) => {
  const p = await openPage(cdp, null);
  try {
    const q = (e) => p.ev(e);
    await p.goto('/'); await p.ready();
    const hiddenWithoutFile = await q("document.getElementById('copy-name').hidden");
    await p.goto('/?file=docs/subdir/rel.md'); await p.ready();
    await q("window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true");
    const shown = await q("!document.getElementById('copy-name').hidden");
    const title = await q("document.getElementById('copy-name').title");
    await q("document.getElementById('copy-name').click(); true");
    await sleep(100);
    const after = await q("({copied: window.__copied, text: document.getElementById('copy-name').textContent, cls: document.getElementById('copy-name').className})");
    await sleep(1400);
    const reset = await q("({text: document.getElementById('copy-name').textContent, cls: document.getElementById('copy-name').className})");
    // an HTML page: button visible, name copied
    await p.goto('/?file=docs/flow.html'); await p.ready();
    await q("window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true");
    const htmlShown = await q("!document.getElementById('copy-name').hidden");
    await q("document.getElementById('copy-name').click(); true");
    await sleep(100);
    const htmlCopied = await q("window.__copied");
    // the buttons do not overlap (a file with headings, so the outline button exists)
    await p.goto('/?file=docs/code.md'); await p.ready();
    const overlap = await q("(function(){var a=document.getElementById('copy-name').getBoundingClientRect();var b=document.getElementById('outline-toggle');if(document.getElementById('outline-wrap').hidden)return false;var r=b.getBoundingClientRect();return !(a.right<=r.left||r.right<=a.left)})()");
    const ok = hiddenWithoutFile === true && shown === true && title.includes('rel.md') && after.copied.length === 1 && after.copied[0] === 'rel.md'
      && after.text === '✓' && after.cls.includes('copied') && !reset.cls.includes('copied') && reset.text !== '✓'
      && htmlShown === true && htmlCopied.length === 1 && htmlCopied[0] === 'flow.html' && overlap === false;
    return [ok, JSON.stringify({ hiddenWithoutFile, shown, title, after, reset, htmlShown, htmlCopied, overlap })];
  } finally { await p.close(); }
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
