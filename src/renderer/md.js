// Rocky OS — markdown → safe HTML for the Reading Room.
//
// marked v15 (vendored UMD, window.marked) parses; DOMPurify (window.DOMPurify)
// sanitises. Links become plain text (a transcript is read, not browsed — and
// the window refuses navigation anyway); images, iframes, scripts and styles
// are stripped. Everything that lands in the reader via innerHTML goes through
// renderMarkdown(); nothing else may.
(function () {
  let configured = false;

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function configure() {
    if (configured || !window.marked) return;
    configured = true;
    window.marked.use({
      gfm: true,
      breaks: false,
      async: false,
      renderer: {
        // Keep the link text, drop the href.
        link(token) {
          return this.parser.parseInline(token.tokens || []);
        },
        image(token) {
          return escapeText(token.text || token.title || '[image]');
        },
        // Raw HTML in a transcript is content, not markup.
        html(token) {
          return escapeText(token.text || token.raw || '');
        },
      },
    });
  }

  const SANITIZE = {
    FORBID_TAGS: ['style', 'script', 'iframe', 'img', 'a'],
    FORBID_ATTR: ['onerror', 'onload', 'style'],
  };

  function renderMarkdown(md) {
    const text = String(md == null ? '' : md);
    if (!window.marked || !window.DOMPurify) {
      return `<p>${escapeText(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
    }
    try {
      configure();
      const html = window.marked.parse(text);
      return window.DOMPurify.sanitize(html, SANITIZE);
    } catch (e) {
      console.error('[md] render failed', e);
      return `<p>${escapeText(text)}</p>`;
    }
  }

  window.renderMarkdown = renderMarkdown;
})();
