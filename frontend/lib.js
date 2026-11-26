// Pure logic for the docs-browser frontend (PRD 5, 6). No DOM access, so it can be unit-tested
// with `node --test` and reused unchanged in the browser (global `DocsLib`).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocsLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var IGNORED = ['.git', 'node_modules', 'dist', 'build', '.cache'];
  var SERVED = ['html', 'htm', 'md', 'markdown', 'css', 'js', 'mjs', 'svg', 'png', 'jpg', 'jpeg',
    'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf'];
  var SUPPORTED = ['md', 'markdown', 'html', 'htm'];
  var MARKDOWN = ['md', 'markdown'];
  var HTML = ['html', 'htm'];
  var IMAGES = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp'];
  // Images the viewer shows and lists in the tree (SVG is excluded: it can carry script).
  var PREVIEW_IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'];
  var PDF = ['pdf'];
  // Text previews: shown as plain text from /api/file, highlighted for JSON and YAML (PRD 7.4).
  var PREVIEW_TEXT = ['json', 'yaml', 'yml'];

  // Lower-cased extension of the last path segment; a dot file such as ".env" has none (as in Rust).
  function ext(path) {
    var base = String(path).split('/').pop();
    var i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1).toLowerCase() : '';
  }

  function inList(list, value) { return list.indexOf(value) !== -1; }
  function isMarkdown(path) { return inList(MARKDOWN, ext(path)); }
  function isHtml(path) { return inList(HTML, ext(path)); }
  function isSupported(path) { return inList(SUPPORTED, ext(path)); }
  function isPreviewImage(path) { return inList(PREVIEW_IMAGES, ext(path)); }
  function isPdf(path) { return inList(PDF, ext(path)); }
  function isPreviewText(path) { return inList(PREVIEW_TEXT, ext(path)); }
  // The highlighting language of a text preview (highlight.js name).
  function textLanguage(path) { return ext(path) === 'json' ? 'json' : 'yaml'; }
  // The small label before a tree entry: its CSS class and its text (PRD 7.3).
  // One icon per file type: a page in the type's colour (the favicon's palette), drawn as inline SVG.
  function pageIcon(color) {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + '<path d="M3.5 1.5h6l3 3v10a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z" fill="' + color + '"/>'
      + '<path d="M9.5 1.5v3h3" fill="none" stroke="#282a36" stroke-width="1"/>'
      + '<path d="M5 9h6M5 11.5h6" fill="none" stroke="#282a36" stroke-width="1" stroke-linecap="round"/></svg>';
  }
  // The type of a listed file: its CSS class, its name (the tooltip) and its icon.
  function badgeFor(path) {
    if (isHtml(path)) return { cls: 'html', label: 'HTML', icon: pageIcon('#ffb86c') };
    if (isPreviewImage(path)) return { cls: 'img', label: 'Image', icon: pageIcon('#50fa7b') };
    if (isPdf(path)) return { cls: 'pdf', label: 'PDF', icon: pageIcon('#ff5555') };
    if (ext(path) === 'json') return { cls: 'json', label: 'JSON', icon: pageIcon('#8be9fd') };
    if (isPreviewText(path)) return { cls: 'yaml', label: 'YAML', icon: pageIcon('#ff79c6') };
    return { cls: 'md', label: 'Markdown', icon: pageIcon('#bd93f9') };
  }

  // ---------------------------------------------------------------- slugs (GitHub style)
  function slugify(text) {
    return String(text).trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
  }

  // Duplicates get -1, -2, ... suffixes, like GitHub.
  function makeSlugger() {
    var seen = Object.create(null);
    return function (text) {
      var base = slugify(text);
      var slug = base;
      var n = 0;
      while (seen[slug]) { n += 1; slug = base + '-' + n; }
      seen[slug] = true;
      return slug;
    };
  }

  // ---------------------------------------------------------------- paths and links
  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return null; }
  }

  function splitHref(href) {
    var h = href.indexOf('#');
    var hash = h >= 0 ? href.slice(h + 1) : '';
    var rest = h >= 0 ? href.slice(0, h) : href;
    var q = rest.indexOf('?');
    if (q >= 0) rest = rest.slice(0, q);
    return { path: rest, hash: hash };
  }

  // Resolves `rel` against the directory of `currentFile`. Returns a root-relative listed path,
  // or null when the target leaves the root or is malformed.
  function resolveRelative(currentFile, rel) {
    var parts;
    if (rel.charAt(0) === '/') { parts = []; } else {
      parts = String(currentFile).split('/');
      parts.pop();
    }
    var segs = rel.split('/');
    for (var i = 0; i < segs.length; i++) {
      var seg = safeDecode(segs[i]);
      if (seg === null) return null;
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    return parts.length ? parts.join('/') : null;
  }

  function hasIgnoredSegment(path) {
    return path.split('/').some(function (s) { return inList(IGNORED, s.toLowerCase()); });
  }

  // kind: 'external' | 'anchor' | 'internal' | 'asset' | 'inert' | 'text'
  //  - external: http, https, mailto (opens in a new tab)
  //  - anchor:   a link to a heading in the same document
  //  - internal: a visible Markdown/HTML file (member of the tree) shown in-app
  //  - asset:    another whitelisted file, opened through /files in a new tab
  //  - inert:    any other scheme; rendered as text with no href
  //  - text:     outside the root, not whitelisted, not visible, or malformed; rendered as text
  // `treePaths` is a Set of every listed Markdown/HTML path; dot-prefixed visibility of assets is
  // decided by the server because the client does not know --include-hidden.
  function classifyLink(href, currentFile, treePaths) {
    href = String(href || '').trim();
    if (!href) return { kind: 'text' };
    if (href.charAt(0) === '#') return { kind: 'anchor', hash: safeDecode(href.slice(1)) || '' };
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
    if (scheme) {
      var s = scheme[1].toLowerCase();
      if (s === 'http' || s === 'https' || s === 'mailto') return { kind: 'external', href: href };
      return { kind: 'inert' };
    }
    if (href.slice(0, 2) === '//') return { kind: 'inert' };

    var parts = splitHref(href);
    var path = resolveRelative(currentFile, parts.path);
    if (path === null) return { kind: 'text' };
    var hash = safeDecode(parts.hash);
    if (hash === null) hash = '';
    if (isSupported(path)) {
      if (treePaths && treePaths.has(path)) return { kind: 'internal', path: path, hash: hash };
      return { kind: 'text' };
    }
    if (inList(SERVED, ext(path)) && !hasIgnoredSegment(path)) return { kind: 'asset', path: path };
    return { kind: 'text' };
  }

  // Returns the URL to load for a Markdown image, or null when the image must not be shown.
  function rewriteImageSrc(src, currentFile) {
    src = String(src || '').trim();
    if (!src) return null;
    if (/^https:\/\//i.test(src)) return src;
    if (/^data:image\//i.test(src)) return src;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.slice(0, 2) === '//') return null;
    var path = resolveRelative(currentFile, splitHref(src).path);
    if (path === null) return null;
    if (!inList(IMAGES, ext(path)) || hasIgnoredSegment(path)) return null;
    return '/files/' + encodePath(path);
  }

  // ---------------------------------------------------------------- URL state (PRD 5)
  function parseLocation(search, hash) {
    // Read the raw value: URLSearchParams would turn a literal + into a space, but buildUrl writes %20 and %2B.
    var m = /[?&]file=([^&]*)/.exec(search || '');
    var file = m ? safeDecode(m[1]) : null;
    var h = String(hash || '').replace(/^#/, '');
    var decoded = safeDecode(h);
    return { file: file || null, hash: decoded === null ? '' : decoded };
  }

  function buildUrl(file, hash) {
    var url = '/';
    if (file) url += '?file=' + encodePath(file);
    if (hash) url += '#' + encodeURIComponent(hash);
    return url;
  }

  function ancestors(path) {
    var segs = String(path).split('/');
    segs.pop();
    var out = [];
    for (var i = 0; i < segs.length; i++) out.push(segs.slice(0, i + 1).join('/'));
    return out;
  }

  // Collects every listed file path of a /api/tree response.
  function collectPaths(entries, set) {
    set = set || new Set();
    (entries || []).forEach(function (e) {
      if (e.type === 'file' && e.path) set.add(e.path);
      if (e.children) collectPaths(e.children, set);
    });
    return set;
  }

  // ---------------------------------------------------------------- bytes to text (PRD 6)
  function decodeMarkdownBytes(buffer) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), invalid: false };
    } catch (e) {
      return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), invalid: true };
    }
  }

  // ---------------------------------------------------------------- fuzzy file name search (PRD 7.3)
  function queryTokens(query) {
    return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // Fuzzy match of one word against a path: the letters must appear in order (any case). Returns
  // { score, pos } or null. A plain substring scores higher than scattered letters, matches in the file
  // name and at the start of a word score higher still, and gaps cost points.
  function isBoundary(text, i) {
    if (i === 0) return true;
    var c = text.charAt(i - 1);
    return c === '/' || c === '-' || c === '_' || c === '.' || c === ' ';
  }
  function fuzzyMatch(word, text) {
    var q = String(word).toLowerCase();
    var t = String(text).toLowerCase();
    if (!q) return null;
    var base = t.lastIndexOf('/') + 1;
    var idx = t.indexOf(q);
    var pos = [];
    var i;
    var substring = idx !== -1;
    if (substring) {
      var inBase = t.indexOf(q, base);
      if (inBase !== -1) idx = inBase;       // prefer the hit inside the file name
      for (i = 0; i < q.length; i++) pos.push(idx + i);
    } else {
      // leftmost greedy to find where the match ends, then walk back to the tightest start
      var end = -1;
      var k = 0;
      for (i = 0; i < t.length && k < q.length; i++) { if (t.charAt(i) === q.charAt(k)) { k++; end = i; } }
      if (k < q.length) return null;
      var j = q.length - 1;
      pos = new Array(q.length);
      for (i = end; i >= 0 && j >= 0; i--) { if (t.charAt(i) === q.charAt(j)) { pos[j] = i; j--; } }
    }
    var score = q.length * 10 - (pos[pos.length - 1] - pos[0] + 1 - q.length); // letters, minus gaps
    for (i = 0; i < pos.length; i++) {
      if (i > 0 && pos[i] === pos[i - 1] + 1) score += 15;
      if (isBoundary(t, pos[i])) score += 10;
    }
    if (substring) score += 100;
    if (pos[0] >= base) score += 40;           // starts inside the file name
    if (isBoundary(t, pos[0])) score += 30;    // starts a word or a folder name
    return { score: score, pos: pos };
  }

  // Every file of a /api/tree response that matches every word of the query, best match first.
  // Each result: { path, name, score, pos } where pos lists the matched character indexes of the path.
  function fuzzyFiles(entries, query) {
    var tokens = queryTokens(query);
    var out = [];
    if (!tokens.length) return out;
    (function walk(list) {
      (list || []).forEach(function (e) {
        if (e.type === 'directory') { walk(e.children); return; }
        var path = String(e.path || e.name);
        var total = 0;
        var all = [];
        for (var i = 0; i < tokens.length; i++) {
          var m = fuzzyMatch(tokens[i], path);
          if (!m) return;
          total += m.score;
          all = all.concat(m.pos);
        }
        var seen = {};
        var pos = all.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; }).sort(function (x, y) { return x - y; });
        out.push({ path: path, name: e.name, score: total - path.length * 0.1, pos: pos });
      });
    })(entries);
    out.sort(function (x, y) { return y.score - x.score || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0); });
    return out;
  }

  // Every directory path of a /api/tree response.
  function collectDirs(entries, prefix, out) {
    out = out || [];
    (entries || []).forEach(function (e) {
      if (e.type === 'directory') {
        var p = prefix ? prefix + '/' + e.name : e.name;
        out.push(p);
        collectDirs(e.children, p, out);
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- colour contrast (PRD 6 Mermaid)
  // Parses 'rgb(r, g, b)' / 'rgba(r, g, b, a)' as returned by getComputedStyle. Returns [r, g, b, a] or null.
  function parseColor(s) {
    var m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(String(s || '').trim());
    if (!m) return null;
    var a = m[4] === undefined ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  function relLuminance(c) {
    var v = c.slice(0, 3).map(function (x) { x = x / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function contrastRatio(a, b) {
    var x = relLuminance(a), y = relLuminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // The text colour to use on `fill`: the current one when it is readable (WCAG 4.5:1), otherwise whichever
  // of `dark` and `light` reads better. All arguments are [r, g, b, a] arrays; returns one of them.
  function pickTextColor(fill, current, dark, light) {
    if (current && contrastRatio(fill, current) >= 4.5) return current;
    return contrastRatio(fill, dark) >= contrastRatio(fill, light) ? dark : light;
  }

  // ---------------------------------------------------------------- sidebar width (PRD 5)
  var SIDEBAR_DEFAULT = 300;
  var SIDEBAR_MIN = 180;

  // The width is kept between 180 px and 60% of the window (never below 180 px, even in a tiny window).
  function clampSidebarWidth(px, viewportWidth) {
    var max = Math.max(SIDEBAR_MIN, Math.floor(Number(viewportWidth) * 0.6));
    var n = Math.round(Number(px));
    if (!isFinite(n)) n = SIDEBAR_DEFAULT;
    return Math.min(max, Math.max(SIDEBAR_MIN, n));
  }

  // A stored value is trusted only if it is exactly a plain integer of two to four digits, with no
  // spaces, sign or leading zero. Anything else is ignored.
  function parseStoredWidth(value) {
    if (value === null || value === undefined) return null;
    var s = String(value);
    return /^[1-9]\d{1,3}$/.test(s) ? Number(s) : null;
  }

  // "just now", "5 minutes ago", "3 days ago" ... for a time in milliseconds; a time in the future counts as now.
  function formatAgo(ms, now) {
    var sec = Math.floor((now - ms) / 1000);
    if (!(sec >= 60)) return 'just now';
    var units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
    var best = units[0];
    for (var i = 0; i < units.length; i++) if (sec >= units[i][0]) best = units[i];
    var n = Math.floor(sec / best[0]);
    return n + ' ' + best[1] + (n === 1 ? '' : 's') + ' ago';
  }

  return {
    SIDEBAR_DEFAULT: SIDEBAR_DEFAULT, SIDEBAR_MIN: SIDEBAR_MIN,
    clampSidebarWidth: clampSidebarWidth, parseStoredWidth: parseStoredWidth,
    parseColor: parseColor, contrastRatio: contrastRatio, pickTextColor: pickTextColor,
    queryTokens: queryTokens, fuzzyMatch: fuzzyMatch, fuzzyFiles: fuzzyFiles, collectDirs: collectDirs,
    formatAgo: formatAgo,
    ext: ext, isMarkdown: isMarkdown, isHtml: isHtml, isSupported: isSupported,
    isImage: isPreviewImage, isPdf: isPdf, isPreviewText: isPreviewText, textLanguage: textLanguage,
    badgeFor: badgeFor,
    slugify: slugify, makeSlugger: makeSlugger,
    encodePath: encodePath, resolveRelative: resolveRelative, classifyLink: classifyLink,
    rewriteImageSrc: rewriteImageSrc,
    parseLocation: parseLocation, buildUrl: buildUrl, ancestors: ancestors,
    collectPaths: collectPaths, decodeMarkdownBytes: decodeMarkdownBytes,
  };
});
