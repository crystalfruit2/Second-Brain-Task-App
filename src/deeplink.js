// Rocky OS deep links — `rocky://open?file=<vault-relative path>[&heading=…]`.
//
// Pure parsing, no Electron, so it can be unit-tested with plain node. The
// main process registers `rocky` as a URL scheme (packaged builds only) and
// hands every incoming URL here; a null result means "not ours, ignore".
//
// Accepted shapes (all resolve to the same thing):
//   rocky://open?file=Areas/Idea-Garden
//   rocky://open?file=Areas/Idea-Garden.md
//   rocky://open?file=Areas%2FIdea-Garden%23Seeds        (Obsidian-style #heading)
//   rocky://open?file=Areas/Idea-Garden&heading=Seeds
//   rocky://open/Areas/Idea-Garden                       (path form, handy to type)
const path = require('path');

function parseRockyUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'rocky:') return null;
  // `rocky://open?…` → host "open"; `rocky:open?…` (no slashes) → pathname "open".
  const action = (url.host || url.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  if (action !== 'open') return null;

  let file = url.searchParams.get('file');
  let heading = url.searchParams.get('heading');
  if (!file) {
    // path form: everything after the host
    const rest = url.host ? url.pathname : url.pathname.replace(/^\/*open/, '');
    file = decodeURIComponent(rest || '');
  }
  file = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!file) return null;

  // Obsidian's `file=Note%23Heading` convention: split once on the first '#'.
  const hash = file.indexOf('#');
  if (hash >= 0) {
    if (!heading) heading = file.slice(hash + 1);
    file = file.slice(0, hash);
  }
  if (!file) return null;
  if (!/\.md$/i.test(file)) file += '.md';
  // Reject traversal outright rather than relying on the later vault check.
  const parts = file.split('/');
  if (parts.some((p) => p === '..' || p === '')) return null;

  return { action: 'open', file: path.posix.normalize(file), heading: heading ? heading.trim() : null };
}

// Everything Claude prints in the terminal is a vault-relative path; this is
// the inverse of parseRockyUrl so the same encoding rules live in one place.
function buildRockyUrl(file, heading) {
  const clean = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '');
  const params = new URLSearchParams({ file: clean });
  if (heading) params.set('heading', heading);
  return `rocky://open?${params.toString()}`;
}

module.exports = { parseRockyUrl, buildRockyUrl };
