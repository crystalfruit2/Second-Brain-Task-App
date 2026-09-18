// node --test test/garden.test.js — synthetic vault in a temp dir; no real notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../src/garden');

const NOW = new Date(2026, 8, 18, 12, 0, 0); // local noon, 2026-09-18
const DAY = 86_400_000;
const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-'));
  tmpDirs.push(root);
  for (const d of ['Projects', 'Daily', 'Areas', 'Resources']) fs.mkdirSync(path.join(root, d));
  return root;
}

function writeNote(root, dir, fm, body, ageDays) {
  const d = path.join(root, 'Projects', dir);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${dir}.md`);
  fs.writeFileSync(f, `---\n${fm}\n---\n\n${body}\n`);
  const t = (NOW.getTime() - ageDays * DAY) / 1000;
  fs.utimesSync(f, t, t);
  return f;
}

// A fake repo: only .git/logs/HEAD matters to the reader.
function fakeRepo(root, name, ageDays) {
  const repo = path.join(root, 'repos', name);
  fs.mkdirSync(path.join(repo, '.git', 'logs'), { recursive: true });
  const ts = Math.floor((NOW.getTime() - ageDays * DAY) / 1000);
  fs.writeFileSync(
    path.join(repo, '.git', 'logs', 'HEAD'),
    `0000 1111 A <a@b> ${ts - 90000} +0300\tcommit (initial): x\n1111 2222 A <a@b> ${ts} +0300\tcommit: y\n`,
  );
  return repo;
}

test('assess: focus stages and nag thresholds', () => {
  assert.equal(g.assess({ lane: 'focus', idleDays: 0 }).stage, 0);
  assert.equal(g.assess({ lane: 'focus', idleDays: 1 }).nag, false);
  const two = g.assess({ lane: 'focus', idleDays: 2 });
  assert.equal(two.stage, 1);
  assert.equal(two.nag, true);
  assert.equal(g.assess({ lane: 'focus', idleDays: 5 }).stage, 2);
  assert.equal(g.assess({ lane: 'focus', idleDays: 8 }).stage, 3);
  assert.equal(g.assess({ lane: 'background', idleDays: 3 }).stage, 0);
  assert.equal(g.assess({ lane: 'background', idleDays: 6 }).nag, false);
  assert.equal(g.assess({ lane: 'background', idleDays: 6, daysLeft: 5 }).nag, true);
  assert.equal(g.assess({ lane: 'parked', idleDays: 40, daysLeft: 1 }).nag, false);
  assert.equal(g.assess({ lane: 'focus', idleDays: null }).stage, 3);
});

test('assess: deadline raises the score', () => {
  const a = g.assess({ lane: 'focus', idleDays: 3 }).score;
  const b = g.assess({ lane: 'focus', idleDays: 3, daysLeft: 4 }).score;
  assert.ok(b > a);
  assert.equal(g.assess({ lane: 'focus', idleDays: 3, daysLeft: 30 }).score, a);
});

test('evidenceText: open tasks, headings, intentions, schedule and neglect-talk do not count', () => {
  const md = [
    '# 2026-09-18',
    '## Intentions',
    '- Work on Alpha today',
    '## Schedule',
    '- 18:00 Alpha sync',
    '## Tasks',
    '### 📱 Alpha',
    '- [ ] Alpha open task (carried)',
    '- [x] Beta shipped the thing',
    '## Journal',
    'Spent the evening on Gamma.',
    '- [ ] Gamma follow-up',
    'Delta: 3 gündür dokunulmadı, kod dondurma 12 gün',
    '- [x] Epsilon is still untouched — checked',
  ].join('\n');
  const ev = g.evidenceText(md);
  assert.ok(!/alpha/.test(ev));
  assert.ok(/beta shipped/.test(ev));
  assert.ok(/evening on gamma/.test(ev));
  assert.ok(!/gamma follow-up/.test(ev));
  assert.ok(!/delta/.test(ev), 'a line about neglect never counts as a touch');
  assert.ok(!/epsilon/.test(ev));
});

test('frontmatter + heading: comments stripped, dd.MM.yyyy accepted, H1 taken from the body only', () => {
  const text = '---\n# yaml comment\nstatus: active\nlane: focus # why\ndeadline: 25.09.2026\ntitle: "Quoted"\n---\n\n# Real Title — sub\ntext';
  const fm = g.frontmatter(text);
  assert.equal(fm.lane, 'focus');
  assert.equal(fm.title, 'Quoted');
  assert.equal(g.parseDate(fm.deadline).getDate(), 25);
  assert.equal(g.parseDate('2026-09-30').getMonth(), 8);
  assert.equal(g.parseDate('soon'), null);
  assert.equal(g.firstHeading(g.splitFrontmatter(text).body), 'Real Title — sub');
});

test('parseSeeds: bullet and heading seeds under 🌰 Seeds only', () => {
  const md = [
    '## 🌰 Seeds',
    '- 🌰 **2026-09-16 — Buy-on-crash rule:** text',
    '### 🌰 Some heading seed (2026-09-15, from a reel)',
    '### 🍎 Ripened one (2026-09-14)',
    '## 🌱 Sprouts',
    '- 🌰 **2026-09-01 — not a seed section:** text',
  ].join('\n');
  const s = g.parseSeeds(md);
  assert.equal(s.total, 2);
  assert.deepEqual(s.items[0], { title: 'Buy-on-crash rule', date: '2026-09-16' });
  assert.deepEqual(s.items[1], { title: 'Some heading seed', date: '2026-09-15' });
});

test('registry: path comes from the Local path column, never from Status', () => {
  const row = '| Alpha [[Projects/Alpha/Alpha]] | active — log at ~/Library/Logs/x.log | ~/Documents/Projects/alpha (github a/b) | no |';
  assert.ok(g.registryPathOf(row).endsWith('/Documents/Projects/alpha'));
  assert.equal(g.registryPathOf('| Beta | ~/wrong/cell | — · [[Beta]] | no |'), null);
  assert.equal(g.localPathFrom('`C:\\x\\y` (Windows)'), null);
  assert.equal(g.localPathFrom('/Users/a/b/c/ · [GitHub](x)'), '/Users/a/b/c/');
  const reg = '| Project | Status |\n|---|---|\n' + row + '\n| Beta | x | y | z |';
  assert.match(g.registryRowFor(reg, 'Alpha'), /alpha/);
  assert.equal(g.registryRowFor(reg, 'Beta'), null);
});

test('aliases: word boundaries and prefix pruning', () => {
  const dailies = [{ date: new Date(2026, 8, 17), text: 'the alps are high; second brain capture shipped' }];
  assert.ok(g.lastDailyMention(dailies, ['alps']), 'whole word matches');
  assert.equal(g.lastDailyMention(dailies, ['alp']), null, 'no match inside a longer word');
  const pruned = g.pruneAliases({ A: ['second brain', 'features'], B: ['second brain capture'] });
  assert.deepEqual(pruned.A, ['features']);
  assert.deepEqual(pruned.B, ['second brain capture']);
  assert.equal(g.lastDailyMention(dailies, pruned.A), null);
  assert.ok(g.lastDailyMention(dailies, pruned.B));
});

test('repoLastCommit: reads the reflog tail, never spawns, tolerates junk', () => {
  const root = mkVault();
  const repo = fakeRepo(root, 'r1', 4);
  const d = g.repoLastCommit(repo);
  assert.equal(g.daysBetween(NOW, d), 4);
  assert.equal(g.repoLastCommit(path.join(root, 'nope')), null);
  fs.writeFileSync(path.join(repo, '.git', 'logs', 'HEAD'), 'garbage\n');
  assert.equal(g.repoLastCommit(repo), null);
  // a fresh commit is seen on the next call (no cross-call cache)
  fakeRepo(root, 'r1', 1);
  assert.equal(g.daysBetween(NOW, g.repoLastCommit(repo)), 1);
});

test('readGarden: lanes, newest signal wins, deadline, exclusions, sort, repo column, bad note', () => {
  const root = mkVault();
  // focus, note 5d old, checked task 2d ago → idle 2 → nag
  writeNote(root, 'Alpha', 'tags:\n  - project\nstatus: active\nlane: focus\ndeadline: 2026-09-30\ndeadline-label: freeze', '# Alpha — the app', 5);
  // focus, note 6d old, but its repo (from the registry Local path column) committed 1d ago
  const repo = fakeRepo(root, 'bravo', 1);
  writeNote(root, 'Bravo', 'status: active\nlane: focus', '# Bravo', 6);
  // background, 6d idle, no nag; Status cell carries a decoy path with a fresh commit
  const decoy = fakeRepo(root, 'decoy', 0);
  writeNote(root, 'Charlie', 'status: active\nlane: background', '# Charlie: a thing', 6);
  writeNote(root, 'Delta', 'status: active\nlane: parked', '# Delta', 90);
  writeNote(root, 'Echo', 'status: completed\nlane: focus', '# Echo', 0);
  writeNote(root, 'Foxtrot', 'status: paused', '# Foxtrot', 20);
  // a project folder whose main note is a directory → skipped, not fatal
  fs.mkdirSync(path.join(root, 'Projects', 'Golf', 'Golf.md'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Resources', 'project-registry.md'),
    '| Project | Status | Local path | Graph? |\n|---|---|---|---|\n' +
      `| Bravo [[Projects/Bravo/Bravo]] | active | ${repo} | no |\n` +
      `| Charlie [[Projects/Charlie/Charlie]] | active — see ${decoy} | — | no |\n`,
  );
  fs.writeFileSync(path.join(root, 'Daily', '2026-09-16.md'), '# d\n## Tasks\n- [x] Alpha M2 done\n');
  fs.writeFileSync(path.join(root, 'Daily', '2026-09-18.md'), '# d\n## Tasks\n- [ ] Alpha carried task\n## Intentions\n- Charlie today\n## Journal\nCharlie: 6 gündür dokunulmadı\n');
  fs.writeFileSync(path.join(root, 'Areas', 'Idea-Garden.md'), '## 🌰 Seeds\n- 🌰 **2026-09-10 — One seed:** x\n');

  const out = g.readGarden(root, { now: NOW });
  assert.equal(out.available, true);
  const names = out.projects.map((p) => p.dir);
  assert.ok(!names.includes('Echo'));
  assert.ok(!names.includes('Golf'));
  assert.equal(out.projects[0].dir, 'Alpha', 'nagging focus project sorts first');
  const alpha = out.projects.find((p) => p.dir === 'Alpha');
  assert.equal(alpha.idleDays, 2);
  assert.equal(alpha.via, 'daily');
  assert.equal(alpha.nag, true);
  assert.equal(alpha.daysLeft, 12);
  assert.equal(alpha.deadline, '2026-09-30');
  assert.equal(alpha.deadlineLabel, 'freeze');
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.file, 'Projects/Alpha/Alpha.md');
  const bravo = out.projects.find((p) => p.dir === 'Bravo');
  assert.equal(bravo.idleDays, 1);
  assert.equal(bravo.via, 'commit');
  assert.equal(bravo.repo, repo);
  assert.equal(bravo.nag, false);
  const charlie = out.projects.find((p) => p.dir === 'Charlie');
  assert.equal(charlie.repo, null, 'decoy path in the Status cell is ignored');
  assert.equal(charlie.idleDays, 6, 'intention and neglect-talk lines are not evidence');
  assert.equal(charlie.lane, 'background');
  assert.equal(out.projects.find((p) => p.dir === 'Foxtrot').lane, 'background');
  assert.equal(out.projects[out.projects.length - 1].dir, 'Delta', 'parked sorts last');
  assert.equal(out.seeds.total, 1);
});

test('readGarden: same-day tie prefers note over daily over commit; local-day arithmetic', () => {
  const root = mkVault();
  writeNote(root, 'Alpha', 'status: active\nlane: focus\ndeadline: 2026-09-18', '# Alpha', 0);
  fs.writeFileSync(path.join(root, 'Daily', '2026-09-18.md'), '# d\n## Journal\nAlpha work\n');
  // 00:30 local on the 18th: still "today", deadline "due today"
  const out = g.readGarden(root, { now: new Date(2026, 8, 18, 0, 30) });
  const a = out.projects[0];
  assert.equal(a.via, 'note');
  assert.equal(a.idleDays, 0);
  assert.equal(a.daysLeft, 0);
});

test('readGarden: missing vault → unavailable, never throws', () => {
  const out = g.readGarden(path.join(os.tmpdir(), 'no-such-vault-' + Date.now()));
  assert.equal(out.available, false);
  assert.deepEqual(out.projects, []);
});
