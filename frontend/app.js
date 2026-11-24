// docs-browser frontend (PRD 5 to 8). Pure helpers live in lib.js (global DocsLib).
(function () {
  'use strict';

  var L = window.DocsLib;
  var ID_PREFIX = 'user-content-';
  var $ = function (sel) { return document.querySelector(sel); };
  var els = { tree: $('#tree'), preview: $('#preview'), banners: $('#banners'), treeBanners: $('#tree-banners') };

  var state = {
    missing: false,
    tree: [],
    treePaths: new Set(),
    truncated: false,
    current: null,
    token: 0,
    expanded: new Set(),
  };

  // ------------------------------------------------------------ Markdown renderer
  var md = window.markdownit({ html: false, linkify: false, typographer: false })
    .use(window.markdownitTaskLists, { enabled: false, label: false });

  md.core.ruler.push('docs_links', function (s) {
    var env = s.env;
    s.tokens.forEach(function (block) {
      if (block.type !== 'inline' || !block.children) return;
      var kids = block.children;
      for (var i = 0; i < kids.length; i++) {
        var t = kids[i];
        if (t.type !== 'link_open') continue;
        var close = i + 1;
        while (close < kids.length && kids[close].type !== 'link_close') close++;
        var c = L.classifyLink(t.attrGet('href'), env.path, env.treePaths);
        if (c.kind === 'external') {
          t.attrSet('target', '_blank');
          t.attrSet('rel', 'noopener noreferrer');
        } else if (c.kind === 'internal') {
          t.attrSet('href', L.buildUrl(c.path, c.hash));
          t.attrSet('data-internal', c.path);
          t.attrSet('data-hash', c.hash || '');
        } else if (c.kind === 'anchor') {
          t.attrSet('href', '#' + encodeURIComponent(c.hash));
          t.attrSet('data-anchor', c.hash);
        } else if (c.kind === 'asset') {
          t.attrSet('href', '/files/' + L.encodePath(c.path));
          t.attrSet('target', '_blank');
          t.attrSet('rel', 'noopener noreferrer');
        } else {
          // inert scheme, outside the root, not whitelisted, not visible: plain text, no href
          t.tag = 'span';
          t.attrs = [['class', 'plain-link']];
          if (kids[close]) kids[close].tag = 'span';
        }
      }
    });
  });

  var defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    var token = tokens[idx];
    var src = L.rewriteImageSrc(token.attrGet('src'), env.path);
    if (src === null) {
      return '<span class="blocked-image">' + md.utils.escapeHtml(token.content || '') + '</span>';
    }
    token.attrSet('src', src);
    return defaultImage(tokens, idx, options, env, self);
  };

  // The slug comes from the rendered text (not the Markdown source) and ids carry a prefix, as on
  // GitHub, so a heading such as "# Tree" cannot clobber an element of the page itself.
  function inlineText(inline) {
    var out = '';
    ((inline && inline.children) || []).forEach(function (c) {
      if (c.type === 'text' || c.type === 'code_inline') out += c.content;
      else if (c.type === 'softbreak') out += ' ';
    });
    return out;
  }

  md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrSet('id', ID_PREFIX + env.slugger(inlineText(tokens[idx + 1])));
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.fence = function (tokens, idx) {
    var token = tokens[idx];
    var lang = (token.info || '').trim().split(/\s+/)[0];
    if (lang === 'mermaid') {
      return '<div class="mermaid-block" data-source="' + md.utils.escapeHtml(token.content) + '"></div>\n';
    }
    var code = token.content;
    if (lang && window.hljs && window.hljs.getLanguage(lang)) {
      try {
        var out = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        return '<pre><code class="hljs language-' + md.utils.escapeHtml(lang) + '">' + out + '</code></pre>\n';
      } catch (e) { /* fall through to plain text */ }
    }
    return '<pre><code>' + md.utils.escapeHtml(code) + '</code></pre>\n';
  };

  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

  // ------------------------------------------------------------ small DOM helpers
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function banner(text, target) {
    var div = document.createElement('div');
    div.className = 'banner';
    div.setAttribute('role', 'status');
    div.textContent = text;
    (target || els.banners).appendChild(div);
  }

  function showState(text) {
    clear(els.preview);
    var div = document.createElement('div');
    div.className = 'state';
    div.textContent = text;
    els.preview.appendChild(div);
  }

  function setReady() { document.body.dataset.state = 'ready'; }

  // ------------------------------------------------------------ tree
  function renderTree() {
    clear(els.tree);
    els.tree.appendChild(buildList(state.tree, ''));
    markSelected();
  }

  function buildList(entries, prefix) {
    var ul = document.createElement('ul');
    entries.forEach(function (e) {
      var li = document.createElement('li');
      if (e.type === 'directory') {
        var dirPath = prefix ? prefix + '/' + e.name : e.name;
        var details = document.createElement('details');
        details.dataset.dir = dirPath;
        if (state.expanded.has(dirPath)) details.open = true;
        details.addEventListener('toggle', function () {
          if (details.open) state.expanded.add(dirPath); else state.expanded.delete(dirPath);
        });
        var summary = document.createElement('summary');
        summary.textContent = e.name;
        details.appendChild(summary);
        details.appendChild(buildList(e.children || [], dirPath));
        li.appendChild(details);
      } else {
        var a = document.createElement('a');
        a.href = L.buildUrl(e.path, '');
        a.dataset.path = e.path;
        a.textContent = e.name;
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    return ul;
  }

  function markSelected() {
    var prev = els.tree.querySelector('a.selected');
    if (prev) prev.classList.remove('selected');
    if (!state.current) return;
    L.ancestors(state.current).forEach(function (dir) {
      state.expanded.add(dir);
      var d = els.tree.querySelector('details[data-dir="' + CSS.escape(dir) + '"]');
      if (d) d.open = true;
    });
    var link = Array.prototype.find.call(els.tree.querySelectorAll('a[data-path]'), function (a) {
      return a.dataset.path === state.current;
    });
    if (link) {
      link.classList.add('selected');
      link.scrollIntoView({ block: 'nearest' });
    }
  }

  async function loadTree() {
    var res = await fetch('/api/tree');
    if (!res.ok) throw new Error('tree request failed: ' + res.status);
    state.tree = await res.json();
    state.treePaths = L.collectPaths(state.tree);
    clear(els.treeBanners);
    state.truncated = res.headers.get('x-tree-truncated') === '1';
    if (state.truncated) banner('Tree truncated', els.treeBanners);
    renderTree();
  }

  // ------------------------------------------------------------ preview
  function scrollToHash(hash) {
    if (!hash) return;
    var target = document.getElementById(ID_PREFIX + hash);
    if (target) target.scrollIntoView({ block: 'start' });
  }

  // Images load after layout; wait for them (bounded) so an anchor scroll lands on the right place.
  function waitForImages(root, timeout) {
    var pending = Array.prototype.filter.call(root.querySelectorAll('img'), function (i) { return !i.complete; });
    if (!pending.length) return Promise.resolve();
    var loaded = Promise.all(pending.map(function (img) {
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
    return Promise.race([loaded, new Promise(function (resolve) { setTimeout(resolve, timeout); })]);
  }

  async function renderMermaid(root, token) {
    var blocks = root.querySelectorAll('.mermaid-block');
    var n = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (token !== state.token) return;
      var block = blocks[i];
      var source = block.getAttribute('data-source') || '';
      var id = 'mmd-' + token + '-' + (n++);
      try {
        await window.mermaid.parse(source);
        var out = await window.mermaid.render(id, source);
        block.className = 'mermaid';
        block.innerHTML = out.svg;
      } catch (e) {
        var stray = document.getElementById('d' + id);
        if (stray) stray.remove();
        block.className = 'mermaid-error';
        clear(block);
        var title = document.createElement('div');
        title.className = 'mermaid-error-title';
        title.textContent = 'Mermaid diagram could not be rendered: ' + String((e && e.message) || e).split('\n')[0];
        var pre = document.createElement('pre');
        pre.textContent = source;
        block.appendChild(title);
        block.appendChild(pre);
      }
      block.removeAttribute('data-source');
    }
  }

  async function renderMarkdown(path, hash, token) {
    var res = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (token !== state.token) return;
    if (res.status === 404) { state.missing = true; return showState('File not found'); }
    if (res.status === 415) return showState('Unsupported file type');
    if (res.status === 413) return showState('File too large');
    if (!res.ok) return showState('Could not load the file (HTTP ' + res.status + ')');
    var decoded = L.decodeMarkdownBytes(await res.arrayBuffer());
    if (token !== state.token) return;
    if (decoded.invalid) banner('File contained invalid UTF-8');
    els.preview.classList.remove('wide');
    els.preview.innerHTML = md.render(decoded.text, {
      path: path,
      treePaths: state.treePaths,
      slugger: L.makeSlugger(),
    });
    await renderMermaid(els.preview, token);
    await waitForImages(els.preview, 3000);
    if (token !== state.token) return;
    scrollToHash(hash);
  }

  async function renderHtml(path, token) {
    var head = await fetch('/files/' + L.encodePath(path), { method: 'HEAD' });
    if (token !== state.token) return;
    if (!head.ok) { state.missing = true; return showState('File not found'); }
    var frame = document.createElement('iframe');
    frame.className = 'html-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', path);
    els.preview.classList.add('wide');
    clear(els.preview);
    await new Promise(function (resolve) {
      frame.addEventListener('load', resolve, { once: true });
      frame.src = '/files/' + L.encodePath(path);
      els.preview.appendChild(frame);
    });
  }

  // `opts.keepScroll` is used by live reload: the page is re-rendered in place.
  async function showFile(path, hash, opts) {
    var keepScroll = !!(opts && opts.keepScroll);
    var savedScroll = $('#main').scrollTop;
    var token = ++state.token;
    document.body.dataset.state = 'rendering';
    clear(els.banners);
    state.missing = false;
    if (!keepScroll) {
      // Every navigation starts from the top with the default layout; only an anchor scrolls later.
      els.preview.classList.remove('wide');
      $('#main').scrollTop = 0;
    }
    state.current = path;
    markSelected();
    if (!path) {
      document.title = 'docs-browser';
      showState('Select a file from the list');
      return setReady();
    }
    document.title = path + ' - docs-browser';
    try {
      if (L.isHtml(path)) await renderHtml(path, token);
      else await renderMarkdown(path, hash, token); // other types: the server answers 404 or 415
    } catch (e) {
      if (token === state.token) showState('Could not load the file: ' + (e && e.message ? e.message : e));
    }
    if (token === state.token) {
      if (keepScroll) $('#main').scrollTop = savedScroll;
      setReady();
    }
  }

  function navigate(path, hash) {
    history.pushState({}, '', L.buildUrl(path, hash));
    return showFile(path, hash || '');
  }

  // ------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var internal = a.getAttribute('data-path') || a.getAttribute('data-internal');
    if (internal) {
      e.preventDefault();
      navigate(internal, a.getAttribute('data-hash') || '');
      return;
    }
    var anchor = a.getAttribute('data-anchor');
    if (anchor !== null) {
      e.preventDefault();
      history.pushState({}, '', L.buildUrl(state.current, anchor));
      scrollToHash(anchor);
    }
  });

  window.addEventListener('popstate', function () {
    var loc = L.parseLocation(location.search, location.hash);
    showFile(loc.file, loc.hash);
  });

  // ------------------------------------------------------------ live reload (PRD 8)
  var live = { down: false, timer: null, pendingSince: 0, source: null, retry: 0, reconnectTimer: null };

  function statusBanner(text) {
    var el = $('#live-status');
    el.textContent = text;
    el.hidden = !text;
  }

  function reloadCurrent() {
    if (!state.current) return Promise.resolve();
    return showFile(state.current, '', { keepScroll: true });
  }

  // A burst of saves re-renders once: trailing 250 ms debounce, but never wait more than 1 s.
  function scheduleReload() {
    var now = Date.now();
    if (!live.pendingSince) live.pendingSince = now;
    clearTimeout(live.timer);
    var wait = Math.min(250, Math.max(0, 1000 - (now - live.pendingSince)));
    live.timer = setTimeout(function fire() {
      // Never re-render under a navigation that is still loading; try again shortly.
      if (document.body.dataset.state === 'rendering') {
        live.timer = setTimeout(fire, 100);
        return;
      }
      live.pendingSince = 0;
      reloadCurrent();
    }, wait);
  }

  function reloadHtml() {
    var frame = els.preview.querySelector('iframe.html-frame');
    if (frame) frame.src = frame.src;
  }

  function resync() {
    return loadTree().then(reloadCurrent).catch(function () { /* the next event retries */ });
  }

  function handleLive(ev) {
    var current = state.current;
    switch (ev.type) {
      case 'changed':
        if (!current) return;
        if (ev.path === current) {
          if (L.isHtml(current)) reloadHtml(); else scheduleReload();
        } else if (L.isHtml(current) && !L.isSupported(ev.path)) {
          reloadHtml(); // an asset of the open HTML page (CSS, JS, image)
        }
        break;
      case 'removed':
        if (ev.path === current) {
          // Cancel a pending or running re-render first, or it would overwrite this state with an error.
          clearTimeout(live.timer);
          live.pendingSince = 0;
          state.token++;
          state.missing = true;
          showState('File no longer exists');
          setReady();
        }
        break;
      case 'tree':
        loadTree().then(function () {
          if (state.current && state.missing && state.treePaths.has(state.current)) {
            state.missing = false;
            scheduleReload(); // the file is back: restore the preview
          }
        }).catch(function () { /* the next event retries */ });
        break;
      case 'resync': resync(); break;
      case 'unavailable': statusBanner('Live reload unavailable'); break;
      case 'bye': statusBanner('Server stopped'); break;
      default: break;
    }
  }

  function connectLive() {
    if (!window.EventSource) return;
    if (live.source) live.source.close();
    var source = new EventSource('/api/events');
    live.source = source;
    source.onopen = function () {
      live.retry = 0;
      if (live.down) {
        live.down = false;
        statusBanner('');
        resync(); // events may have been missed while the connection was down
      }
    };
    source.onmessage = function (m) {
      var ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      handleLive(ev);
    };
    source.onerror = function () {
      live.down = true;
      if (source.readyState === EventSource.CLOSED) {
        // The browser gave up (for example a 503 because the server is at its stream limit):
        // reconnect by hand with a growing delay, and do not claim that it is retrying meanwhile.
        statusBanner('Live reload unavailable');
        live.retry = Math.min(live.retry + 1, 5);
        clearTimeout(live.reconnectTimer);
        live.reconnectTimer = setTimeout(connectLive, 1000 * Math.pow(2, live.retry));
      } else {
        // EventSource reconnects by itself; keep the last rendered content and say so.
        statusBanner('Server unreachable, retrying');
      }
    };
  }

  // ------------------------------------------------------------ start
  (async function start() {
    connectLive(); // before the first fetch: nothing that changes from here on can be missed
    try {
      await loadTree();
    } catch (e) {
      banner('Server unreachable, retrying');
    }
    var loc = L.parseLocation(location.search, location.hash);
    await showFile(loc.file, loc.hash);
  })();
})();
