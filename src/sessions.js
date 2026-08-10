// Claude Code session detection — finds every running `claude` process on this
// machine, resolves its working directory, and matches that directory against
// Resources/project-registry.md so the Sessions panel can show a real project
// name instead of a raw path. Everything here is read-only shell calls
// (`ps`/`lsof`), no polling loop of our own kept alive when nobody's looking —
// see startPolling()/stopPolling() in main.js, which only run while the
// Dashboard window is open.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { VAULT_PATH } = require('./config');
const vault = require('./vault');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

// `ps -axo pid=,etime=,comm=` — comm is the last whitespace-separated token
// (never contains spaces for our target), so a plain split is safe.
async function listClaudeProcesses() {
  const out = await run('ps', ['-axo', 'pid=,etime=,comm=']);
  const procs = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const comm = parts[parts.length - 1];
    if (comm !== 'claude') continue;
    const pid = parts[0];
    const etime = parts.slice(1, -1).join(' ');
    procs.push({ pid, etime });
  }
  return procs;
}

// `lsof -a -p <pid> -d cwd -Fn` prints an `n<path>` line for the process's cwd.
async function cwdForPid(pid) {
  const out = await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n/') || l.startsWith('n~'));
  return line ? line.slice(1) : null;
}

// Pull `/Users/...` (or `~/...`) style paths out of a registry cell — cells mix
// Mac and Windows paths separated by " · ", plus wikilinks and prose. Requires
// at least one path segment after `~` so a bare tilde (matching nothing useful)
// can't collapse to the home directory and swallow every session under it.
function extractMacPaths(cell) {
  const home = process.env.HOME || '';
  const matches = cell.match(/(?:~\/[^\s`|]+|\/Users\/[^\s`|]+)/g) || [];
  return matches
    .map((p) => (p.startsWith('~') ? home + p.slice(1) : p))
    .map((p) => p.replace(/[`,.]+$/, ''))
    .map((p) => p.replace(/\/+$/, '')); // drop trailing slash so prefix checks below don't double up
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .replace(/\([^)]*\)/g, '') // drop parenthetical asides
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'session'
  );
}

// Longest-prefix match of `cwd` against every registry row's known Mac paths.
function matchRegistry(cwd, registryRows) {
  let best = null;
  for (const row of registryRows) {
    for (const p of extractMacPaths(row.path)) {
      if (cwd === p || cwd.startsWith(p + path.sep)) {
        if (!best || p.length > best.matchedPath.length) {
          best = { row, matchedPath: p };
        }
      }
    }
  }
  return best;
}

// One entry per unique cwd (several `claude` processes can share a directory —
// e.g. this very session plus a background one in the same repo).
async function listSessions() {
  const procs = await listClaudeProcesses();
  const registryRows = vault.listProjects();
  const byCwd = new Map();

  for (const proc of procs) {
    const cwd = await cwdForPid(proc.pid);
    if (!cwd) continue;
    if (!byCwd.has(cwd)) {
      const match = matchRegistry(cwd, registryRows);
      const name = match ? match.row.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim() : path.basename(cwd);
      const slug = slugify(name || path.basename(cwd));
      byCwd.set(cwd, {
        cwd,
        name,
        slug,
        status: match ? match.row.status.replace(/\*\*/g, '').slice(0, 240) : null,
        pids: [],
        etime: proc.etime,
        hasNotes: vault.hasSessionNotes(slug),
      });
    }
    byCwd.get(cwd).pids.push(proc.pid);
  }

  return Array.from(byCwd.values()).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listSessions, slugify };
