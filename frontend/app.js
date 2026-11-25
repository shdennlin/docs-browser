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
    expandedReady: false, // true once the saved folders were restored for this page
    rootKey: null,        // the served root's key from /api/version (keys the saved folders)
    tabs: [],      // [{ path, scroll }]
    active: -1,    // index into tabs, -1 when no file is open
    query: '',
    mode: 'names',
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

  // Dark mode uses the Dracula palette for diagrams (light mode keeps Mermaid's default theme).
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  var THEME_KEY = 'docs-browser.theme';
  function effectiveDark() {
    var t = document.documentElement.dataset.theme;
    return t === 'dark' || (t !== 'light' && darkQuery.matches);
  }
  // `choice` is 'light', 'dark' or null (follow the system).
  function applyTheme(choice, save) {
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    var hl = { light: document.getElementById('hl-light'), dark: document.getElementById('hl-dark') };
    if (choice) { hl.light.media = choice === 'light' ? 'all' : 'not all'; hl.dark.media = choice === 'dark' ? 'all' : 'not all'; }
    else { hl.light.media = '(prefers-color-scheme: light)'; hl.dark.media = '(prefers-color-scheme: dark)'; }
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = effectiveDark() ? '\u263E' : '\u2606'.replace('\u2606', '\u263C');
      btn.title = effectiveDark() ? 'Dark theme: switch to light' : 'Light theme: switch to dark';
      btn.setAttribute('aria-pressed', String(effectiveDark()));
    }
    if (save) { try { if (choice) localStorage.setItem(THEME_KEY, choice); else localStorage.removeItem(THEME_KEY); } catch (e) { /* storage may be off */ } }
  }
  (function () { var t = null; try { t = localStorage.getItem(THEME_KEY); } catch (e) { /* storage may be off */ } applyTheme(t === 'light' || t === 'dark' ? t : null, false); })();
  function initMermaid() {
    if (!window.mermaid) return;
    var cfg = { startOnLoad: false, securityLevel: 'strict' };
    if (effectiveDark()) {
      cfg.theme = 'base';
      cfg.themeVariables = {
        darkMode: true, background: '#282a36', fontFamily: 'inherit',
        primaryColor: '#44475a', primaryTextColor: '#f8f8f2', primaryBorderColor: '#bd93f9',
        secondaryColor: '#6272a4', secondaryTextColor: '#f8f8f2', secondaryBorderColor: '#8be9fd',
        tertiaryColor: '#21222c', tertiaryTextColor: '#f8f8f2', tertiaryBorderColor: '#6272a4',
        lineColor: '#8be9fd', textColor: '#f8f8f2', mainBkg: '#44475a', nodeBorder: '#bd93f9',
        clusterBkg: '#21222c', clusterBorder: '#6272a4', titleColor: '#ff79c6',
        edgeLabelBackground: '#282a36', noteBkgColor: '#44475a', noteTextColor: '#f8f8f2',
        noteBorderColor: '#f1fa8c', actorBkg: '#44475a', actorBorder: '#bd93f9', actorTextColor: '#f8f8f2',
        actorLineColor: '#6272a4', signalColor: '#f8f8f2', signalTextColor: '#f8f8f2',
        labelBoxBkgColor: '#44475a', labelBoxBorderColor: '#bd93f9', labelTextColor: '#f8f8f2',
        loopTextColor: '#f8f8f2', activationBkgColor: '#6272a4', sequenceNumberColor: '#282a36'
      };
    }
    window.mermaid.initialize(cfg);
  }
  initMermaid();
  var themeChange = function () { initMermaid(); if (state.current && !/\.html?$/i.test(state.current)) reloadCurrent(); };
  function switchTheme(choice, save) { applyTheme(choice, save); themeChange(); }
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', function () { if (!document.documentElement.dataset.theme) { applyTheme(null, false); themeChange(); } });
  document.getElementById('theme-toggle').addEventListener('click', function () { switchTheme(effectiveDark() ? 'light' : 'dark', true); });

  // ------------------------------------------------------------ icons
  // Line icons drawn with currentColor, so they follow the theme. Expand all: two chevrons pointing away
  // from each other. Collapse all: a framed box with a minus, in front of a second frame.
  var SVG_OPEN = '<svg class="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  var ICON_EXPAND = SVG_OPEN + '<path d="M4.5 5.5 8 2l3.5 3.5"/><path d="M4.5 10.5 8 14l3.5-3.5"/></svg>';
  var ICON_COLLAPSE = SVG_OPEN + '<path d="M5.5 3.5h7a1 1 0 0 1 1 1v7"/><rect x="2.5" y="5.5" width="8" height="8" rx="1"/><path d="M4.5 9.5h4"/></svg>';
  $('#expand-all').innerHTML = ICON_EXPAND;
  $('#collapse-all').innerHTML = ICON_COLLAPSE;

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
    if (state.mode === 'names' && L.queryTokens(state.query).length) { renderFuzzy(); markSelected(false); return; }
    els.tree.appendChild(buildList(state.tree, ''));
    markSelected(false); // a re-render must not re-open a folder the user closed
    saveExpanded();
  }

  var FUZZY_LIMIT = 200;

  // Matches as a flat list, best first: the full path with the matched letters marked.
  function renderFuzzy() {
    var res = L.fuzzyFiles(state.tree, state.query);
    if (!res.length) {
      var none = document.createElement('div');
      none.className = 'tree-empty';
      none.textContent = 'No file name matches';
      els.tree.appendChild(none);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'fuzzy-list';
    res.slice(0, FUZZY_LIMIT).forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = L.buildUrl(r.path, '');
      a.dataset.path = r.path;
      a.title = r.path;
      var badge = document.createElement('span');
      var fuzzyBadge = L.badgeFor(r.path);
      badge.className = 'badge ' + fuzzyBadge.cls;
      badge.textContent = fuzzyBadge.text;
      a.appendChild(badge);
      var cut = r.path.lastIndexOf('/') + 1;
      var hit = {};
      r.pos.forEach(function (x) { hit[x] = true; });
      [['fz-dir', 0, cut], ['fz-name', cut, r.path.length]].forEach(function (part) {
        if (part[1] === part[2]) return;
        var span = document.createElement('span');
        span.className = part[0];
        var i = part[1];
        while (i < part[2]) {
          var on = !!hit[i];
          var j = i;
          while (j < part[2] && !!hit[j] === on) j++;
          var chunk = r.path.slice(i, j);
          if (on) { var m = document.createElement('mark'); m.textContent = chunk; span.appendChild(m); }
          else span.appendChild(document.createTextNode(chunk));
          i = j;
        }
        a.appendChild(span);
      });
      li.appendChild(a);
      ul.appendChild(li);
    });
    els.tree.appendChild(ul);
    if (res.length > FUZZY_LIMIT) {
      var more = document.createElement('div');
      more.className = 'tree-empty';
      more.textContent = (res.length - FUZZY_LIMIT) + ' more matches; type more letters to narrow';
      els.tree.appendChild(more);
    }
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
          saveExpanded();
        });
        var summary = document.createElement('summary');
        var nameSpan = document.createElement('span');
        nameSpan.className = 'folder-name';
        nameSpan.textContent = e.name;
        nameSpan.title = dirPath;
        summary.appendChild(nameSpan);
        [['expand', ICON_EXPAND, 'Open this folder and everything in it'], ['collapse', ICON_COLLAPSE, 'Close this folder and everything in it']].forEach(function (b) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'folder-btn';
          btn.dataset.action = b[0];
          btn.innerHTML = b[1];
          btn.title = b[2];
          btn.setAttribute('aria-label', b[2] + ': ' + dirPath);
          btn.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation(); // do not toggle the folder itself
            var sub = [dirPath].concat(L.collectDirs(e.children || [], dirPath));
            sub.forEach(function (d) { if (b[0] === 'expand') state.expanded.add(d); else state.expanded.delete(d); });
            renderTree();
          });
          summary.appendChild(btn);
        });
        details.appendChild(summary);
        details.appendChild(buildList(e.children || [], dirPath));
        li.appendChild(details);
      } else {
        var a = document.createElement('a');
        a.href = L.buildUrl(e.path, '');
        a.dataset.path = e.path;
        a.title = e.path;
        var badge = document.createElement('span');
        var treeBadge = L.badgeFor(e.name);
        badge.className = 'badge ' + treeBadge.cls;
        badge.textContent = treeBadge.text;
        a.appendChild(badge);
        a.appendChild(document.createTextNode(e.name));
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    return ul;
  }

  // `expandAncestors` is true on navigation only (PRD 5): the folders of the opened file open then.
  function markSelected(expandAncestors) {
    var prev = els.tree.querySelector('a.selected');
    if (prev) prev.classList.remove('selected');
    if (!state.current) return;
    if (expandAncestors) {
      L.ancestors(state.current).forEach(function (dir) {
        state.expanded.add(dir);
        var d = els.tree.querySelector('details[data-dir="' + CSS.escape(dir) + '"]');
        if (d) d.open = true;
      });
    }
    saveExpanded();
    var link = Array.prototype.find.call(els.tree.querySelectorAll('a[data-path]'), function (a) {
      return a.dataset.path === state.current;
    });
    if (link) {
      link.classList.add('selected');
      if (state.mode === 'names') {
        // Vertical only: scrollIntoView would also scroll the list sideways when names do not wrap.
        var sb = $('#side-scroll');
        var top = sb.getBoundingClientRect().top;
        var lr = link.getBoundingClientRect();
        if (lr.top < top) sb.scrollTop -= top - lr.top + 4;
        else if (lr.bottom > sb.getBoundingClientRect().bottom) sb.scrollTop += lr.bottom - sb.getBoundingClientRect().bottom + 4;
      }
    }
  }

  // Expanded folders are remembered per served root (the server's rootKey), so two roots, or the
  // 4747 and 4748 fallbacks, keep separate state. Folders that no longer exist are dropped on restore.
  function expandedKey() { return state.rootKey ? EXPANDED_PREFIX + state.rootKey : null; }
  function restoreExpanded() {
    var key = expandedKey();
    if (key) {
      try {
        var saved = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(saved)) {
          var known = new Set(L.collectDirs(state.tree));
          state.expanded = new Set(saved.filter(function (d) { return typeof d === 'string' && known.has(d); }));
        }
      } catch (e) { /* storage may be off or damaged: start collapsed */ }
    }
    state.expandedReady = true;
  }
  function saveExpanded() {
    var key = expandedKey();
    if (!key || !state.expandedReady) return;
    try { localStorage.setItem(key, JSON.stringify(Array.from(state.expanded))); } catch (e) { /* storage may be off */ }
  }
  function forgetExpanded() {
    try {
      Object.keys(localStorage).filter(function (k) { return k.indexOf(EXPANDED_PREFIX) === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* storage may be off */ }
  }

  async function loadTree() {
    var res = await fetch('/api/tree');
    if (!res.ok) throw new Error('tree request failed: ' + res.status);
    state.tree = await res.json();
    state.treePaths = L.collectPaths(state.tree);
    if (!state.expandedReady) restoreExpanded();
    clear(els.treeBanners);
    state.truncated = res.headers.get('x-tree-truncated') === '1';
    if (state.truncated) banner('Tree truncated', els.treeBanners);
    renderTree();
    if (state.mode === 'contents' && state.query.trim().length >= 2) runSearch();
  }

  // ------------------------------------------------------------ preview
  // Heading ids keep the invisible emoji selectors (U+FE0E/U+FE0F) and the joiner (U+200D), as GitHub's
  // do, but contents links written by other tools often do not. Look for the exact id first, then for one
  // that is the same once those characters and leading hyphens are ignored.
  function anchorKey(s) { return String(s).replace(/[\uFE0E\uFE0F\u200D]/g, '').replace(/^-+/, ''); }
  function findAnchor(hash) {
    var exact = document.getElementById(ID_PREFIX + hash);
    if (exact) return exact;
    var want = anchorKey(hash);
    var all = els.preview.querySelectorAll('[id^="' + ID_PREFIX + '"]');
    for (var i = 0; i < all.length; i++) {
      if (anchorKey(all[i].id.slice(ID_PREFIX.length)) === want) return all[i];
    }
    return null;
  }

  // A contents link whose heading does not exist (an out-of-date table of contents) is shown struck
  // through and does nothing, so it is clear that the document is stale and not the viewer broken.
  function markDeadLinks() {
    Array.prototype.forEach.call(els.preview.querySelectorAll('a[data-anchor]'), function (a) {
      var hash = a.getAttribute('data-anchor');
      if (hash && !findAnchor(hash)) {
        a.classList.add('dead-link');
        a.title = '\u627E\u4E0D\u5230\u9019\u500B\u6A19\u984C';
      }
    });
  }

  function scrollToHash(hash) {
    if (!hash) return;
    var target = findAnchor(hash);
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

  // A diagram can set its own fill colours (`style X fill:#fff3cd`). The theme's text colour may then be
  // unreadable on them (white on cream in dark mode, dark on near-black in light mode), so every node and
  // cluster gets text of a readable colour measured against its own fill.
  var TEXT_DARK = [30, 31, 41, 1];
  var TEXT_LIGHT = [248, 248, 242, 1];
  function fixMermaidContrast(root) {
    Array.prototype.forEach.call(root.querySelectorAll('g.node, g.cluster'), function (node) {
      var shape = node.querySelector('rect, polygon, circle, ellipse, path');
      if (!shape) return;
      var fill = L.parseColor(getComputedStyle(shape).fill);
      if (!fill || fill[3] < 0.5) return; // no fill, or a see-through one: the page behind it decides
      var texts = node.querySelectorAll('text, tspan, foreignObject div, foreignObject span, foreignObject p');
      Array.prototype.forEach.call(texts, function (el) {
        var cs = getComputedStyle(el);
        var isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
        var cur = L.parseColor(isSvg ? cs.fill : cs.color);
        var want = L.pickTextColor(fill, cur, TEXT_DARK, TEXT_LIGHT);
        if (want === cur) return;
        var css = 'rgb(' + want[0] + ', ' + want[1] + ', ' + want[2] + ')';
        if (isSvg) el.style.setProperty('fill', css, 'important');
        el.style.setProperty('color', css, 'important');
      });
    });
  }

  // Dark mode: the theme gives every node and every sequence-diagram participant one colour. Give each its
  // own Dracula accent instead (a dark tint of the accent as fill, the accent itself as border), like the
  // light theme does for participants. Nodes the diagram styled itself (style/classDef) keep their colours.
  var ACCENTS = [[189, 147, 249], [139, 233, 253], [80, 250, 123], [255, 184, 108], [255, 121, 198], [255, 85, 85], [241, 250, 140]];
  var DARK_BG = [40, 42, 54];
  function accentCss(c) { return 'rgb(' + c.join(', ') + ')'; }
  function tintCss(c) { return 'rgb(' + c.map(function (v, i) { return Math.round(DARK_BG[i] + (v - DARK_BG[i]) * 0.24); }).join(', ') + ')'; }
  function paint(shape, i) {
    var c = ACCENTS[i % ACCENTS.length];
    shape.style.setProperty('fill', tintCss(c), 'important');
    shape.style.setProperty('stroke', accentCss(c), 'important');
  }
  function colorizeMermaid(root) {
    var i = 0;
    Array.prototype.forEach.call(root.querySelectorAll('g.node'), function (node) {
      if (node.getAttribute('class').replace(/\b(node|default)\b/g, '').trim()) return; // classDef / class
      var shape = node.querySelector('rect, polygon, circle, ellipse, path');
      if (!shape || /fill/.test(shape.getAttribute('style') || '')) return;                // style X fill:...
      paint(shape, i++);
    });
    var seen = {}, count = 0;
    var actors = Array.prototype.slice.call(root.querySelectorAll('rect.actor')).sort(function (a, b) { return a.getAttribute('x') - b.getAttribute('x'); });
    actors.forEach(function (r) {
      var name = r.getAttribute('name') || r.nextElementSibling && r.nextElementSibling.textContent || '';
      if (!(name in seen)) seen[name] = count++;
      paint(r, seen[name]);
    });
  }

  // Full-screen diagram viewer (PRD 7.4): a button on each diagram opens a copy of its SVG over the page.
  // Drag pans, the wheel zooms around the pointer, Escape closes.
  function addDiagramButton(block) {
    if (!block.querySelector('svg')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'mermaid-zoom';
    b.title = 'View full screen'; b.setAttribute('aria-label', 'View diagram full screen');
    b.textContent = '\u2922'; // a text glyph, not an <svg>: the page and its tests count a diagram's own svg
    b.addEventListener('click', function () { openDiagram(block); });
    block.appendChild(b);
  }

  // Copy button on every code block (PRD 7.4): copies the block's text, shows a tick for a moment.
  function addCodeCopy(root) {
    Array.prototype.forEach.call(root.querySelectorAll('pre'), function (pre) {
      if (pre.closest('.mermaid, .mermaid-block') || pre.querySelector('.code-copy')) return;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'code-copy';
      b.textContent = 'Copy'; b.title = 'Copy code'; b.setAttribute('aria-label', 'Copy code');
      b.addEventListener('click', function () {
        var code = pre.querySelector('code') || pre;
        copyText(code.textContent).then(function () {
          b.textContent = '\u2713'; b.classList.add('copied');
          setTimeout(function () { b.textContent = 'Copy'; b.classList.remove('copied'); }, 1200);
        }, function () { b.textContent = '!'; setTimeout(function () { b.textContent = 'Copy'; }, 1200); });
      });
      pre.appendChild(b);
    });
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
        if (effectiveDark()) colorizeMermaid(block);
        fixMermaidContrast(block);
        addDiagramButton(block);
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
    markDeadLinks();
    addCodeCopy(els.preview);
    await renderMermaid(els.preview, token);
    await waitForImages(els.preview, 3000);
    if (token !== state.token) return;
    scrollToHash(hash);
  }

  // Images and PDF files are shown straight from `/files/*` (PRD 7.4). A PDF gets the same sandbox header
  // as every `/files/*` response, which Chromium still renders inside the frame (measured in a spike).
  async function renderMedia(path, token) {
    var url = '/files/' + L.encodePath(path);
    var head = await fetch(url, { method: 'HEAD' });
    if (token !== state.token) return;
    if (!head.ok) { state.missing = true; return showState('File not found'); }
    clear(els.preview);
    if (L.isPdf(path)) {
      els.preview.classList.add('wide');
      var frame = document.createElement('iframe');
      frame.className = 'html-frame pdf-frame';
      frame.setAttribute('title', path);
      frame.src = url;
      els.preview.appendChild(frame);
    } else {
      var img = document.createElement('img');
      img.className = 'media-image';
      img.alt = path;
      img.src = url + '?v=' + Date.now(); // a file changed on disk shows its new picture
      els.preview.appendChild(img);
    }
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
  // Status bar under the preview (PRD 7.3): created and modified times and, in a git repository, the
  // branch, the last commit of the file and whether it has uncommitted changes. Quiet on any failure.
  function fmtTime(ms) {
    var d = new Date(ms), p2 = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function infoSpan(parent, cls, text, title) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    if (title) s.title = title;
    parent.appendChild(s);
    return s;
  }
  async function loadInfo(path, token) {
    var bar = $('#fileinfo');
    try {
      var r = await fetch('/api/info?path=' + encodeURIComponent(path), { cache: 'no-store' });
      if (!r.ok) throw new Error('no info');
      var info = await r.json();
      if (token !== state.token) return;
      clear(bar);
      var now = Date.now();
      // Only a loopback server sends absolutePath (PRD 7.3); the custom scheme opens the file in VS Code.
      if (typeof info.absolutePath === 'string') {
        var vs = document.createElement('a');
        vs.className = 'fi-vscode';
        vs.href = 'vscode://file' + L.encodePath(info.absolutePath);
        vs.textContent = 'Open in VS Code';
        vs.title = info.absolutePath;
        bar.appendChild(vs);
      }
      if (typeof info.created === 'number') infoSpan(bar, 'fi-created', 'Created ' + fmtTime(info.created), new Date(info.created).toString());
      if (typeof info.modified === 'number') infoSpan(bar, 'fi-modified', 'Modified ' + L.formatAgo(info.modified, now), new Date(info.modified).toString());
      if (info.git) {
        var g = document.createElement('span');
        g.className = 'fi-git';
        infoSpan(g, 'fi-branch', '\u2387 ' + info.git.branch, 'git branch');
        if (info.git.commit) {
          var c = info.git.commit;
          infoSpan(g, 'fi-commit', 'Committed ' + L.formatAgo(c.time * 1000, now) + ' \u00b7 ' + c.hash, new Date(c.time * 1000).toString());
          if (c.subject) infoSpan(g, 'fi-sub', c.subject, c.subject);
        } else {
          infoSpan(g, 'fi-commit', 'Not committed yet');
        }
        if (info.git.dirty) infoSpan(g, 'fi-dirty', '\u25cf uncommitted changes', 'The file differs from its last commit');
        bar.appendChild(g);
      }
      bar.hidden = bar.childNodes.length === 0;
    } catch (e) {
      if (token === state.token) { clear(bar); bar.hidden = true; }
    }
  }

  async function showFile(path, hash, opts) {
    var keepScroll = !!(opts && opts.keepScroll);
    var savedScroll = $('#main').scrollTop;
    if (!keepScroll) {
      if (state.active >= 0 && state.tabs[state.active]) state.tabs[state.active].scroll = savedScroll;
      adoptTab(path);
    }
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
    updateCopyButton();
    markSelected(true);
    if (!path) {
      document.title = 'docs-browser';
      $('#fileinfo').hidden = true;
      showState('Select a file from the list');
      return setReady();
    }
    document.title = path + ' - docs-browser';
    loadInfo(path, token);
    try {
      if (L.isImage(path) || L.isPdf(path)) await renderMedia(path, token);
      else if (L.isHtml(path)) await renderHtml(path, token);
      else await renderMarkdown(path, hash, token); // other types: the server answers 404 or 415
    } catch (e) {
      if (token === state.token) showState('Could not load the file: ' + (e && e.message ? e.message : e));
    }
    if (token === state.token) {
      if (keepScroll) $('#main').scrollTop = savedScroll;
      else if (opts && typeof opts.scroll === 'number' && !hash) $('#main').scrollTop = opts.scroll;
      setReady();
    }
  }

  // ------------------------------------------------------------ tabs (PRD 7.5)
  var tabsEl = $('#tabs');
  var TABS_KEY = 'docs-browser.tabs';
  var EXPANDED_PREFIX = 'docs-browser.expanded.';

  function saveTabs() {
    try { sessionStorage.setItem(TABS_KEY, JSON.stringify(state.tabs.map(function (t) { return t.path; }))); } catch (e) { /* storage may be off */ }
  }

  function tabLabel(path) {
    var parts = path.split('/');
    var name = parts[parts.length - 1];
    var same = state.tabs.filter(function (t) { return t.path.split('/').pop() === name; }).length > 1;
    return same && parts.length > 1 ? parts[parts.length - 2] + '/' + name : name;
  }

  function renderTabs() {
    clear(tabsEl);
    tabsEl.hidden = state.tabs.length === 0;
    state.tabs.forEach(function (t, i) {
      var tab = document.createElement('div');
      tab.className = 'tab' + (i === state.active ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(i === state.active));
      tab.dataset.index = String(i);
      tab.dataset.path = t.path;
      tab.title = t.path;
      var name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tabLabel(t.path);
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.setAttribute('aria-label', 'Close tab ' + t.path);
      close.textContent = '×';
      tab.appendChild(name);
      tab.appendChild(close);
      tabsEl.appendChild(tab);
    });
    saveTabs();
  }

  // Called by showFile for every navigation: the file being shown belongs to a tab. An open tab is activated;
  // otherwise the active tab is replaced (a plain click), or a first tab is made when none is open.
  function adoptTab(path) {
    if (!path) { state.active = -1; renderTabs(); return; }
    var i = state.tabs.findIndex(function (t) { return t.path === path; });
    if (i === -1) {
      if (state.active >= 0 && state.tabs[state.active]) { state.tabs[state.active] = { path: path, scroll: 0 }; i = state.active; }
      else { state.tabs.push({ path: path, scroll: 0 }); i = state.tabs.length - 1; }
    }
    state.active = i;
    renderTabs();
  }

  function activateTab(i) {
    var t = state.tabs[i];
    if (!t || i === state.active) return;
    history.pushState({}, '', L.buildUrl(t.path, ''));
    return showFile(t.path, '', { scroll: t.scroll || 0 });
  }

  function closeTab(i) {
    if (i < 0 || i >= state.tabs.length) return;
    var wasActive = i === state.active;
    state.tabs.splice(i, 1);
    if (!wasActive) {
      if (i < state.active) state.active -= 1;
      renderTabs();
      return;
    }
    var next = state.tabs[Math.min(i, state.tabs.length - 1)];
    state.active = -1;
    if (next) {
      history.replaceState({}, '', L.buildUrl(next.path, ''));
      showFile(next.path, '', { scroll: next.scroll || 0 });
    } else {
      history.replaceState({}, '', '/');
      showFile(null, '');
    }
  }

  function stepTab(delta) {
    if (state.tabs.length < 2 || state.active < 0) return;
    activateTab((state.active + delta + state.tabs.length) % state.tabs.length);
  }

  tabsEl.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('.tab');
    if (!tab) return;
    var i = Number(tab.dataset.index);
    if (e.target.closest('.tab-close')) closeTab(i); else activateTab(i);
  });
  tabsEl.addEventListener('auxclick', function (e) {
    var tab = e.target.closest && e.target.closest('.tab');
    if (tab && e.button === 1) { e.preventDefault(); closeTab(Number(tab.dataset.index)); }
  });
  tabsEl.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); }); // no autoscroll

  // `opts.newTab`: open in a tab of its own (an already open file is just activated).
  function navigate(path, hash, opts) {
    if (opts && opts.newTab && !state.tabs.some(function (t) { return t.path === path; })) {
      state.tabs.push({ path: path, scroll: 0 });
    }
    history.pushState({}, '', L.buildUrl(path, hash));
    return showFile(path, hash || '');
  }

  // ------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || e.defaultPrevented || e.button !== 0 || e.shiftKey || e.altKey) return;
    var mod = e.metaKey || e.ctrlKey;
    var internal = a.getAttribute('data-path') || a.getAttribute('data-internal');
    if (internal) {
      e.preventDefault();
      navigate(internal, a.getAttribute('data-hash') || '', { newTab: mod });
      return;
    }
    if (mod) return; // other links keep the browser's own behaviour
    var anchor = a.getAttribute('data-anchor');
    if (anchor !== null) {
      e.preventDefault();
      if (a.classList.contains('dead-link')) return; // no such heading: leave the address alone
      history.pushState({}, '', L.buildUrl(state.current, anchor));
      scrollToHash(anchor);
    }
  });

  // middle click on a file link opens it in a new tab
  document.addEventListener('auxclick', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || e.button !== 1) return;
    var internal = a.getAttribute('data-path') || a.getAttribute('data-internal');
    if (!internal) return;
    e.preventDefault();
    navigate(internal, a.getAttribute('data-hash') || '', { newTab: true });
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

  // ------------------------------------------------------------ sidebar resizer (PRD 5)
  var SIDEBAR_KEY = 'docs-browser.sidebarWidth';
  var resizer = $('#resizer');
  var preferredWidth = L.SIDEBAR_DEFAULT; // what the user chose; kept when the window shrinks and grows back
  var sidebarWidth = L.SIDEBAR_DEFAULT;   // what is applied now: the preferred width within today's limits
  var activePointer = null;
  var dragStartX = 0;
  var dragStartWidth = 0;

  function renderSidebar(save) {
    sidebarWidth = L.clampSidebarWidth(preferredWidth, window.innerWidth);
    document.documentElement.style.setProperty('--side', sidebarWidth + 'px');
    resizer.setAttribute('aria-valuenow', String(sidebarWidth));
    resizer.setAttribute('aria-valuemin', String(L.SIDEBAR_MIN));
    resizer.setAttribute('aria-valuemax', String(L.clampSidebarWidth(1e6, window.innerWidth)));
    if (save) {
      try { localStorage.setItem(SIDEBAR_KEY, String(preferredWidth)); } catch (e) { /* storage may be off */ }
    }
  }

  function setSidebar(px, save) {
    preferredWidth = L.clampSidebarWidth(px, window.innerWidth);
    renderSidebar(save);
  }

  // Ends a drag however it ended: release, cancel, lost capture or the window losing focus.
  function finishDrag() {
    if (activePointer === null) return;
    activePointer = null;
    document.body.classList.remove('resizing');
    renderSidebar(true);
  }

  resizer.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || activePointer !== null) return; // one pointer at a time
    e.preventDefault();
    try { resizer.setPointerCapture(e.pointerId); } catch (err) { /* the drag still works while the pointer stays over the divider */ }
    activePointer = e.pointerId;
    dragStartX = e.clientX;
    dragStartWidth = sidebarWidth;
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', function (e) {
    if (e.pointerId !== activePointer) return;
    setSidebar(dragStartWidth + (e.clientX - dragStartX), false);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) {
    resizer.addEventListener(name, function (e) {
      if (e.pointerId === activePointer) finishDrag();
    });
  });
  window.addEventListener('blur', finishDrag);
  resizer.addEventListener('dblclick', function () { setSidebar(L.SIDEBAR_DEFAULT, true); });
  resizer.addEventListener('keydown', function (e) {
    var step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') setSidebar(sidebarWidth - step, true);
    else if (e.key === 'ArrowRight') setSidebar(sidebarWidth + step, true);
    else if (e.key === 'Home') setSidebar(L.SIDEBAR_DEFAULT, true);
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', function () { renderSidebar(false); });

  (function restoreSidebar() {
    var saved = null;
    try { saved = L.parseStoredWidth(localStorage.getItem(SIDEBAR_KEY)); } catch (e) { /* storage may be off */ }
    preferredWidth = saved === null ? L.SIDEBAR_DEFAULT : saved;
    renderSidebar(false);
  })();

  // ------------------------------------------------------------ outline (PRD 7.4)
  var OUTLINE_KEY = 'docs-browser.outlinePinned';
  var outlineWrap = $('#outline-wrap');
  var outlineEl = $('#outline');
  var outlineBtn = $('#outline-toggle');
  function updateOutline() {
    clear(outlineEl);
    var heads = els.preview.classList.contains('wide') ? [] : els.preview.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    outlineWrap.hidden = heads.length === 0;
    Array.prototype.forEach.call(heads, function (h) {
      var hash = h.id.slice(ID_PREFIX.length);
      var a = document.createElement('a');
      a.className = 'l' + h.tagName.charAt(1);
      a.href = L.buildUrl(state.current, hash);
      a.dataset.anchor = hash;
      a.textContent = h.textContent;
      outlineEl.appendChild(a);
    });
    markCurrentHeading();
  }
  function markCurrentHeading() {
    var links = outlineEl.querySelectorAll('a');
    if (!links.length) return;
    var limit = $('#main').getBoundingClientRect().top + 48;
    var current = -1;
    var heads = els.preview.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    for (var i = 0; i < heads.length; i++) { if (heads[i].getBoundingClientRect().top <= limit) current = i; else break; }
    if (current < 0) current = 0;
    Array.prototype.forEach.call(links, function (a, i) { a.classList.toggle('current', i === current); });
  }
  var spyFrame = 0;
  $('#main').addEventListener('scroll', function () {
    if (spyFrame) return;
    spyFrame = requestAnimationFrame(function () { spyFrame = 0; markCurrentHeading(); });
  });
  var outlineTimer = null;
  new MutationObserver(function () { clearTimeout(outlineTimer); outlineTimer = setTimeout(updateOutline, 0); })
    .observe(els.preview, { childList: true });
  function setPinned(on, save) {
    outlineWrap.classList.toggle('pinned', on);
    outlineBtn.setAttribute('aria-pressed', String(on));
    var co = $('#set-outline'); if (co) co.checked = on;
    if (save) { try { localStorage.setItem(OUTLINE_KEY, on ? '1' : '0'); } catch (e) { /* storage may be off */ } }
  }
  outlineBtn.addEventListener('click', function () { setPinned(!outlineWrap.classList.contains('pinned'), true); });
  try { setPinned(localStorage.getItem(OUTLINE_KEY) === '1', false); } catch (e) { /* storage may be off */ }

  // The panel itself never scrolls, only #side-scroll does. Some browsers still scroll an overflow:hidden
  // box when a child gets focus; put it back so the search box and buttons cannot slide out of view.
  $('#sidebar').addEventListener('scroll', function () {
    var sb = $('#sidebar');
    if (sb.scrollLeft !== 0) sb.scrollLeft = 0;
    if (sb.scrollTop !== 0) sb.scrollTop = 0;
  });

  // ------------------------------------------------------------ wrap toggle for the left panel
  var WRAP_KEY = 'docs-browser.wrapNames';
  var wrapBtn = $('#wrap-toggle');
  function setWrap(on, save) {
    $('#sidebar').classList.toggle('nowrap', !on);
    wrapBtn.setAttribute('aria-pressed', String(on));
    wrapBtn.title = on ? 'Long names wrap (click: one line per name)' : 'One line per name, scroll sideways (click: wrap)';
    var cw = $('#set-wrap'); if (cw) cw.checked = on;
    if (save) { try { localStorage.setItem(WRAP_KEY, on ? '1' : '0'); } catch (e) { /* storage may be off */ } }
  }
  wrapBtn.addEventListener('click', function () { setWrap(wrapBtn.getAttribute('aria-pressed') !== 'true', true); });
  try { setWrap(localStorage.getItem(WRAP_KEY) !== '0', false); } catch (e) { /* storage may be off */ }

  // ------------------------------------------------------------ copy the file name (PRD 7.4)
  var copyBtn = $('#copy-name');
  var copyTimer = null;
  function updateCopyButton() {
    copyBtn.hidden = !state.current;
    copyBtn.title = state.current ? 'Copy file name: ' + state.current.split('/').pop() : 'Copy file name';
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* fall through */ }
      ta.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }
  copyBtn.addEventListener('click', function () {
    if (!state.current) return;
    var name = state.current.split('/').pop();
    copyText(name).then(function () {
      copyBtn.classList.add('copied');
      copyBtn.textContent = '\u2713';
    }, function () {
      copyBtn.textContent = '!';
    }).then(function () {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(function () { copyBtn.classList.remove('copied'); copyBtn.textContent = '\u2750'; }, 1200);
    });
  });

  // ------------------------------------------------------------ settings (PRD 5, Settings)
  var WIDE_KEY = 'docs-browser.fullWidth';
  var settingsEl = $('#settings');
  var lastFocus = null;
  function setWide(on, save) {
    document.body.classList.toggle('fullwidth', on);
    $('#set-wide').checked = on;
    if (save) { try { localStorage.setItem(WIDE_KEY, on ? '1' : '0'); } catch (e) { /* storage may be off */ } }
  }
  try { setWide(localStorage.getItem(WIDE_KEY) === '1', false); } catch (e) { /* storage may be off */ }
  $('#set-wrap').checked = wrapBtn.getAttribute('aria-pressed') === 'true';
  $('#set-outline').checked = outlineWrap.classList.contains('pinned');
  function openSettings() { lastFocus = document.activeElement; settingsEl.hidden = false; $('#settings-close').focus(); }
  function closeSettings() { settingsEl.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  $('#settings-open').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  settingsEl.addEventListener('click', function (e) { if (e.target === settingsEl) closeSettings(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !settingsEl.hidden) closeSettings(); });
  $('#set-wrap').addEventListener('change', function (e) { setWrap(e.target.checked, true); });
  $('#set-outline').addEventListener('change', function (e) { setPinned(e.target.checked, true); });
  $('#set-wide').addEventListener('change', function (e) { setWide(e.target.checked, true); });
  $('#settings-reset').addEventListener('click', function () {
    [WRAP_KEY, OUTLINE_KEY, WIDE_KEY, SIDEBAR_KEY].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    setWrap(true, false); setPinned(false, false); setWide(false, false); setSidebar(L.SIDEBAR_DEFAULT, false); switchTheme(null, true);
    forgetExpanded();
    state.expanded = new Set();
    renderTree();
  });

  // ------------------------------------------------------------ search and folder buttons (PRD 7.3)
  var searchInput = $('#search');
  var modeNames = $('#mode-names');
  var modeContents = $('#mode-contents');
  var resultsEl = $('#search-results');
  var searchSeq = 0;
  var searchTimer = null;

  function setMode(mode) {
    state.mode = mode;
    modeNames.setAttribute('aria-pressed', String(mode === 'names'));
    modeContents.setAttribute('aria-pressed', String(mode === 'contents'));
    searchInput.placeholder = mode === 'names' ? 'Search file names  ( / )' : 'Search inside files  ( / )';
    var contents = mode === 'contents';
    resultsEl.hidden = !contents;
    els.tree.hidden = contents;
    $('#expand-all').disabled = contents;
    $('#collapse-all').disabled = contents;
    if (contents) { scheduleSearch(0); } else { clear(resultsEl); renderTree(); markSelected(false); }
  }

  function note(text) {
    clear(resultsEl);
    var d = document.createElement('div');
    d.className = 'results-note';
    d.textContent = text;
    resultsEl.appendChild(d);
  }

  function scheduleSearch(delay) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, delay);
  }

  async function runSearch() {
    var q = state.query.trim();
    var seq = ++searchSeq;
    if ([...q].length < 2) { note(q ? 'Type at least 2 characters' : 'Type to search inside the Markdown and HTML files'); return; }
    var data;
    try {
      var res = await fetch('/api/search?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      if (!res.ok) { note('Search failed (' + res.status + ')'); return; }
      data = await res.json();
    } catch (e) { if (seq === searchSeq) note('Search failed: server unreachable'); return; }
    if (seq !== searchSeq) return;
    clear(resultsEl);
    if (!data.results.length) { note('No file contains "' + data.query + '"'); return; }
    data.results.forEach(function (r) {
      var a = document.createElement('a');
      a.className = 'result';
      a.href = L.buildUrl(r.path, '');
      a.dataset.path = r.path;
      a.title = r.path;
      var head = document.createElement('div');
      head.className = 'result-path';
      head.textContent = r.path;
      var cnt = document.createElement('span');
      cnt.className = 'result-count';
      cnt.textContent = r.count + (r.count === 1 ? ' line' : ' lines');
      head.appendChild(cnt);
      a.appendChild(head);
      r.matches.forEach(function (m) {
        var line = document.createElement('div');
        line.className = 'result-line';
        var no = document.createElement('span');
        no.className = 'lineno';
        no.textContent = m.line + ':';
        line.appendChild(no);
        line.appendChild(document.createTextNode((m.more_before ? '…' : '') + m.before));
        var mark = document.createElement('mark');
        mark.textContent = m.hit;
        line.appendChild(mark);
        line.appendChild(document.createTextNode(m.after + (m.more_after ? '…' : '')));
        a.appendChild(line);
      });
      resultsEl.appendChild(a);
    });
    if (data.truncated) note('Showing the first ' + data.results.length + ' files; narrow the query to see more');
    else if (data.results.length) { /* complete */ }
  }

  searchInput.addEventListener('input', function () {
    state.query = searchInput.value;
    if (state.mode === 'names') { renderTree(); } else { scheduleSearch(250); }
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { searchInput.value = ''; state.query = ''; searchInput.blur(); if (state.mode === 'names') renderTree(); else scheduleSearch(0); }
  });
  modeNames.addEventListener('click', function () { setMode('names'); });
  modeContents.addEventListener('click', function () { setMode('contents'); });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  });
  $('#expand-all').addEventListener('click', function () {
    state.expanded = new Set(L.collectDirs(state.tree));
    renderTree();
  });
  $('#collapse-all').addEventListener('click', function () {
    state.expanded = new Set();
    renderTree();
  });

  // ------------------------------------------------------------ full-screen diagram (PRD 7.4)
  var diagramEl = $('#diagram-view'), diagramStage = $('#diagram-stage'), diagramPan = $('#diagram-pan');
  var dv = { x: 0, y: 0, s: 1, w: 0, h: 0, fit: 1 };
  var DV_MIN = 0.05, DV_MAX = 20;
  function dvApply() {
    diagramPan.style.transform = 'translate(' + dv.x + 'px,' + dv.y + 'px) scale(' + dv.s + ')';
    $('#diagram-zoom').textContent = Math.round(dv.s * 100) + '%';
    diagramEl.dataset.scale = String(dv.s);
  }
  function dvZoomAt(factor, cx, cy) {
    var ns = Math.min(DV_MAX, Math.max(DV_MIN, dv.s * factor));
    var k = ns / dv.s;
    dv.x = cx - (cx - dv.x) * k; dv.y = cy - (cy - dv.y) * k; dv.s = ns; dvApply();
  }
  function dvFit() {
    var vw = diagramStage.clientWidth, vh = diagramStage.clientHeight;
    var s = Math.min(vw * 0.92 / dv.w, vh * 0.92 / dv.h, 4);
    dv.fit = s; dv.s = s; dv.x = (vw - dv.w * s) / 2; dv.y = (vh - dv.h * s) / 2; dvApply();
  }
  function openDiagram(block) {
    var svg = block.querySelector('svg');
    if (!svg) return;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var box = svg.getBoundingClientRect();
    dv.w = (vb && vb.width) || box.width || 800; dv.h = (vb && vb.height) || box.height || 600;
    clear(diagramPan);
    var copy = svg.cloneNode(true);
    copy.setAttribute('width', dv.w); copy.setAttribute('height', dv.h);
    copy.style.maxWidth = 'none';
    diagramPan.appendChild(copy);
    lastFocus = document.activeElement;
    diagramEl.hidden = false;
    dvFit();
    $('#diagram-close').focus();
  }
  function closeDiagram() {
    diagramEl.hidden = true; clear(diagramPan);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('#diagram-close').addEventListener('click', closeDiagram);
  $('#diagram-fit').addEventListener('click', dvFit);
  $('#diagram-in').addEventListener('click', function () { dvZoomAt(1.25, diagramStage.clientWidth / 2, diagramStage.clientHeight / 2); });
  $('#diagram-out').addEventListener('click', function () { dvZoomAt(0.8, diagramStage.clientWidth / 2, diagramStage.clientHeight / 2); });
  diagramStage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = diagramStage.getBoundingClientRect();
    var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    dvZoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  var dvDrag = null;
  diagramStage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    dvDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: dv.x, oy: dv.y };
    diagramStage.setPointerCapture(e.pointerId); diagramStage.classList.add('dragging');
  });
  diagramStage.addEventListener('pointermove', function (e) {
    if (!dvDrag || e.pointerId !== dvDrag.id) return;
    dv.x = dvDrag.ox + (e.clientX - dvDrag.x); dv.y = dvDrag.oy + (e.clientY - dvDrag.y); dvApply();
  });
  function dvEnd(e) { if (dvDrag && e.pointerId === dvDrag.id) { dvDrag = null; diagramStage.classList.remove('dragging'); } }
  diagramStage.addEventListener('pointerup', dvEnd);
  diagramStage.addEventListener('pointercancel', dvEnd);
  diagramStage.addEventListener('dblclick', dvFit);
  window.addEventListener('resize', function () { if (!diagramEl.hidden) dvFit(); });

  // ------------------------------------------------------------ keyboard shortcuts (PRD 7.5)
  var shortcutsEl = $('#shortcuts');
  function openShortcuts() { lastFocus = document.activeElement; shortcutsEl.hidden = false; $('#shortcuts-close').focus(); }
  function closeShortcuts() { shortcutsEl.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  $('#shortcuts-close').addEventListener('click', closeShortcuts);
  shortcutsEl.addEventListener('click', function (e) { if (e.target === shortcutsEl) closeShortcuts(); });
  $('#settings-shortcuts').addEventListener('click', function () { closeSettings(); openShortcuts(); });
  $('#shortcuts-open').addEventListener('click', openShortcuts);

  function focusSearch() { searchInput.focus(); searchInput.select(); }

  document.addEventListener('keydown', function (e) {
    if (!diagramEl.hidden) {
      var dk = e.key;
      if (dk === 'Escape') closeDiagram();
      else if (dk === '+' || dk === '=') dvZoomAt(1.25, diagramStage.clientWidth / 2, diagramStage.clientHeight / 2);
      else if (dk === '-' || dk === '_') dvZoomAt(0.8, diagramStage.clientWidth / 2, diagramStage.clientHeight / 2);
      else if (dk === '0') dvFit();
      else if (dk !== 'Tab') return;
      if (dk !== 'Tab') e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && !shortcutsEl.hidden) { closeShortcuts(); return; }
    if (!settingsEl.hidden || !shortcutsEl.hidden) return;
    var mod = e.metaKey || e.ctrlKey;
    var key = e.key || '';
    if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return; }
    if (e.altKey && !mod && e.code === 'KeyW') { e.preventDefault(); closeTab(state.active); return; }
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || mod || e.altKey) return;
    var main = $('#main');
    switch (key) {
      case '[': stepTab(-1); break;
      case ']': stepTab(1); break;
      case 'j': main.scrollBy(0, 80); break;
      case 'k': main.scrollBy(0, -80); break;
      case 'g': main.scrollTop = 0; break;
      case 'G': main.scrollTop = main.scrollHeight; break;
      case 'o': setPinned(!outlineWrap.classList.contains('pinned'), true); break;
      case 'd': switchTheme(effectiveDark() ? 'light' : 'dark', true); break;
      case 'c': if (state.current) copyBtn.click(); break;
      case '?': openShortcuts(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ------------------------------------------------------------ version (PRD 7.3)
  var versionReady = fetch('/api/version').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (j && typeof j.rootKey === 'string') state.rootKey = j.rootKey;
    if (!j || typeof j.version !== 'string') return;
    var el = $('#app-version');
    el.textContent = 'v' + j.version;
    el.title = 'docs-browser v' + j.version;
  }).catch(function () { /* the footer simply stays without a version */ });

  // ------------------------------------------------------------ start
  (async function start() {
    connectLive(); // before the first fetch: nothing that changes from here on can be missed
    await versionReady; // the root key must be known before the saved folders are restored
    try {
      await loadTree();
    } catch (e) {
      banner('Server unreachable, retrying');
    }
    try {
      var saved = JSON.parse(sessionStorage.getItem(TABS_KEY) || '[]');
      if (Array.isArray(saved)) {
        state.tabs = saved.filter(function (x) { return typeof x === 'string' && (!state.treePaths.size || state.treePaths.has(x)); })
          .map(function (x) { return { path: x, scroll: 0 }; });
        state.active = -1;
      }
    } catch (e) { /* ignore a damaged list */ }
    var loc = L.parseLocation(location.search, location.hash);
    await showFile(loc.file, loc.hash);
  })();
})();
