// node --test test/deeplink.test.js   (npm test runs this + transcripts.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRockyUrl, buildRockyUrl } = require('../src/deeplink');

test('query form, no extension', () => {
  assert.deepEqual(parseRockyUrl('rocky://open?file=Areas/Idea-Garden'), {
    action: 'open', kind: 'note', file: 'Areas/Idea-Garden.md', heading: null,
  });
});

test('query form keeps an explicit .md and decodes %20', () => {
  assert.equal(parseRockyUrl('rocky://open?file=Resources/Erasmus/Kassel%20Yurt.md').file, 'Resources/Erasmus/Kassel Yurt.md');
});

test('obsidian-style %23 heading splits into heading', () => {
  assert.deepEqual(parseRockyUrl('rocky://open?file=Areas%2FIdea-Garden%23%F0%9F%8C%B0%20Seeds'), {
    action: 'open', kind: 'note', file: 'Areas/Idea-Garden.md', heading: '🌰 Seeds',
  });
});

test('explicit heading param wins over #', () => {
  assert.equal(parseRockyUrl('rocky://open?file=A/B%23x&heading=Y').heading, 'Y');
});

test('path form', () => {
  assert.equal(parseRockyUrl('rocky://open/Daily/2026-09-10').file, 'Daily/2026-09-10.md');
});

test('turkish characters survive the round trip', () => {
  const url = buildRockyUrl('Resources/Staj/Staj Defteri — Ç.md', 'Özet');
  assert.deepEqual(parseRockyUrl(url), { action: 'open', kind: 'note', file: 'Resources/Staj/Staj Defteri — Ç.md', heading: 'Özet' });
});

test('rejects other schemes, other actions, traversal, empty', () => {
  assert.equal(parseRockyUrl('obsidian://open?file=x'), null);
  assert.equal(parseRockyUrl('rocky://delete?file=x'), null);
  assert.equal(parseRockyUrl('rocky://open?file=../../etc/passwd'), null);
  assert.equal(parseRockyUrl('rocky://open?file=Areas/../../x'), null);
  assert.equal(parseRockyUrl('rocky://open?file='), null);
  assert.equal(parseRockyUrl('rocky://open'), null);
  assert.equal(parseRockyUrl('not a url'), null);
});

test('buildRockyUrl strips .md and leading slash', () => {
  assert.equal(buildRockyUrl('/Areas/Idea-Garden.md'), 'rocky://open?file=Areas%2FIdea-Garden');
});

test('attachment extensions become kind file and keep their extension', () => {
  const r = parseRockyUrl('rocky://open?file=Resources%2FErasmus%2Fattachments%2F2026-09-10-Recognition-Sheet-AlpEldam-v2.xlsx');
  assert.deepEqual(r, {
    action: 'open', kind: 'file',
    file: 'Resources/Erasmus/attachments/2026-09-10-Recognition-Sheet-AlpEldam-v2.xlsx', heading: null,
  });
  assert.equal(parseRockyUrl('rocky://open?file=Resources/x.PDF&heading=ignored').heading, null);
});

test('notes stay kind note, even with a dot in the name', () => {
  assert.equal(parseRockyUrl('rocky://open?file=Daily/2026-09-10').kind, 'note');
  assert.equal(parseRockyUrl('rocky://open?file=Learning/Topics/v1.2').file, 'Learning/Topics/v1.2.md');
});
