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
    var file = new URLSearchParams(search || '').get('file');
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

  return {
    ext: ext, isMarkdown: isMarkdown, isHtml: isHtml, isSupported: isSupported,
    slugify: slugify, makeSlugger: makeSlugger,
    encodePath: encodePath, resolveRelative: resolveRelative, classifyLink: classifyLink,
    rewriteImageSrc: rewriteImageSrc,
    parseLocation: parseLocation, buildUrl: buildUrl, ancestors: ancestors,
    collectPaths: collectPaths, decodeMarkdownBytes: decodeMarkdownBytes,
  };
});
