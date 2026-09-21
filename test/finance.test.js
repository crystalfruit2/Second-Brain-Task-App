// node --test test/finance.test.js — synthetic content only (no real numbers/accounts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fin = require('../src/finance');

const FINANCE_MD = `# Finance
### Sicil
| Tarih | Portföy TL | XBNK | XGAR | XAIR | XPP+mevduat | XIDX | Not |
|---|---|---|---|---|---|---|---|
| 2026-01-04 | 100.000 | 10,00 | 20,00 | 30,00 | 50.000 | — | açılış |
| 2026-01-11 | 101.000 | 10,50 | 20,50 | 31,00 | 50.500 | 1,0100 | PDF 10.01.2026 |

<!--finance:record:start-->
Son senkron: 10.01.2026 (üretim 2026-01-10 20:00); hesaplar: 0001 PDF
- XPP (0001) 100→90 (−10) [adet]
<!--finance:record:end-->

<!--finance:rules:start-->
| Kural | Durum | Ölçüm | Görev |
|---|---|---|---|
| \`xbnk_low\` | ✅ | 10,50 vs <8 (−23,8%) | — |
| \`de_residency_soon\` | 🔴 tetik | 01.02.2026 (19 gün) | evet |
| \`bank_weight_report\` | ℹ️ | %41,7 (76.131 / 182.377) | — |
<!--finance:rules:end-->

<!--finance:calendar:start-->
_Otomatik_

- 01.02.2026 (+19 gün): Almanya vergi mukimliği başlar
- 22.02.2026 (+40 gün): PPK faiz kararı
<!--finance:calendar:end-->
`;

test('sicil table newest first, fixed columns', () => {
  const s = fin.parseSicil(FINANCE_MD);
  assert.equal(s.columns.length, 8);
  assert.equal(s.rows[0].date, '2026-01-11');
  assert.equal(s.rows[0].cells[1], '101.000');
  assert.equal(s.total, 2);
});

test('blocks, rules and calendar parse', () => {
  const b = fin.parseBlocks(FINANCE_MD);
  assert.ok(b.record.startsWith('Son senkron'));
  const r = fin.parseRules(b.rules);
  assert.deepEqual(r.map((x) => [x.id, x.status, x.task]), [['xbnk_low', 'ok', false], ['de_residency_soon', 'fired', true], ['bank_weight_report', 'info', false]]);
  const c = fin.parseCalendar(b.calendar);
  assert.equal(c.length, 2);
  assert.equal(c[1].days, 40);
});

test('brief extraction stops at next H2', () => {
  const daily = '# 2026-01-11\n## Tasks\n- [ ] x\n\n## 💰 Pazar portföy brifingi — 11.01.2026\n\n**1. Toplam:** 101.000 TL\n\n## Journal\nhi\n';
  const md = fin.extractBrief(daily);
  assert.ok(md.startsWith('## 💰 Pazar portföy brifingi'));
  assert.ok(md.endsWith('101.000 TL'));
  assert.equal(fin.extractBrief('nothing'), null);
});

test('readFinance against a scratch vault (CRLF tolerant, calls counted)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
  fs.mkdirSync(path.join(root, 'Areas', 'Finance', 'calls'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Daily'));
  fs.writeFileSync(path.join(root, 'Areas', 'Finance.md'), FINANCE_MD.replace(/\n/g, '\r\n'));
  const today = new Date(2026, 0, 12);
  fs.writeFileSync(path.join(root, 'Daily', '2026-01-11.md'), '## 💰 Pazar portföy brifingi — 11.01.2026\n\nbody\n');
  fs.writeFileSync(path.join(root, 'Areas', 'Finance', 'calls', 'a.md'), '---\nid: 2026-01-11-watch-xair\ntype: watch\ninstrument: XAIR\nprobability: 0.6\nhorizon_date: 2026-03-31\nstatus: open\ndecision: "izle"\n---\n');
  fs.writeFileSync(path.join(root, 'Areas', 'Finance', 'calls', 'b.md'), '---\nid: 2025-12-01-watch-xbnk\ntype: watch\ninstrument: XBNK\nprobability: 0.7\nstatus: resolved\noutcome: 1\nbrier: 0.09\n---\n');
  const f = fin.readFinance(root, today);
  assert.equal(f.available, true);
  assert.equal(f.last['Portföy TL'], '101.000');
  assert.equal(f.rules.filter((r) => r.status === 'fired').length, 1);
  assert.equal(f.brief.date, '2026-01-11');
  assert.equal(f.calls.open.length, 1);
  assert.equal(f.calls.resolved, 1);
  assert.equal(f.calls.brier, 0.09);
  assert.equal(f.calls.open[0].decision, 'izle');
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing vault files degrade to empty, never throw', () => {
  const f = fin.readFinance('/nonexistent/vault');
  assert.equal(f.available, false);
  assert.equal(f.sicil.rows.length, 0);
  assert.equal(f.brief, null);
  assert.equal(f.calls.total, 0);
});

// ---- 22.09: unmeasurable rules, stale-snapshot flags, vault day (05:00 → 05:00, local clock)

const RULES_WITH_FLAGS = `⚠️ snapshot bayat: XCOL (fill 108 > PDF 0), XENK (fill 96 > PDF 0), XTTK (fill 355 > PDF 0) — değer eklenmedi; iki hesabın PDF'i → \`/finance sync\`.
⚠️ ölçülemedi: xbnk_low, xbnk_high, xgar_low — XBNK 65,20 · 16.09.2026 kapanışı (3 seans geri); XGAR 120,90 · 16.09.2026 kapanışı (3 seans geri)

_Otomatik — \`finance.py rules\`, 22.09.2026._

| Kural | Durum | Ölçüm | Görev |
|---|---|---|---|
| \`xbnk_low\` | ⚠️ ölçülemedi | ÖLÇÜLEMEDİ — XBNK 65,20 · 16.09.2026 kapanışı; 3 seans geri → gerçek kapanışı gir | — |
| \`xgar_low\` | ⚠️ ölçülemedi | ÖLÇÜLEMEDİ — XGAR fiyat yok | — |
| \`xidx_low\` | ✅ | 13.284,40 (18.09.2026 kapanışı) vs <10.000 (−24,7%) | — |
| \`snapshot_stale\` | 🔴 tetik | 10 gün (12.09.2026) | evet |
`;

test('unmeasured rule status is neither ok nor fired', () => {
  const r = fin.parseRules(RULES_WITH_FLAGS);
  assert.deepEqual(r.map((x) => [x.id, x.status]), [['xbnk_low', 'unmeasured'], ['xgar_low', 'unmeasured'], ['xidx_low', 'ok'], ['snapshot_stale', 'fired']]);
  // negative control: a complete feed stays 'ok', a null close is 'unmeasured' too
  assert.equal(r[2].status, 'ok');
  assert.ok(r[1].measure.includes('fiyat yok'));
});

test('flag lines above the table parse into stale + unmeasured codes', () => {
  const fl = fin.parseFlags(RULES_WITH_FLAGS);
  assert.deepEqual(fl.stale.map((s) => s.code), ['XCOL', 'XENK', 'XTTK']);
  assert.equal(fl.stale[0].text, 'XCOL (fill 108 > PDF 0)');
  assert.deepEqual(fl.unmeasured.map((u) => u.code), ['XBNK', 'XGAR']);
  assert.equal(fl.unmeasured[0].text, 'XBNK 65,20 · 16.09.2026 kapanışı (3 seans geri)');
  assert.deepEqual(fl.rules, ['xbnk_low', 'xbnk_high', 'xgar_low']);
  assert.deepEqual(fin.parseFlags('| `a` | ✅ | x | — |'), { stale: [], unmeasured: [] });
});

test('vault day: 00:00–04:59 local belongs to the previous day, never UTC', () => {
  assert.equal(fin.vaultDayStamp(new Date(2026, 0, 12, 1, 30)), '2026-01-11');
  assert.equal(fin.vaultDayStamp(new Date(2026, 0, 12, 4, 59)), '2026-01-11');
  assert.equal(fin.vaultDayStamp(new Date(2026, 0, 12, 5, 0)), '2026-01-12');
  assert.equal(fin.vaultDayStamp(new Date(2026, 0, 12, 23, 30)), '2026-01-12');
  // UTC midnight trap: 02:00 local east of UTC is still "yesterday" in UTC — the stamp must not care
  const twoAm = new Date(2026, 0, 12, 2, 0);
  assert.equal(fin.vaultDayStamp(twoAm), '2026-01-11');
  assert.notEqual(fin.vaultDayStamp(new Date(2026, 0, 12, 4, 30)), new Date(2026, 0, 12, 4, 30).toISOString().slice(0, 10) === '2026-01-12' ? '2026-01-12' : 'x');
});

test('readLatestBrief at 04:00 finds the vault day\'s note first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
  fs.mkdirSync(path.join(root, 'Daily'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Areas', 'Finance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Daily', '2026-01-11.md'), '## 💰 Pazar portföy brifingi — 11.01.2026\n\nold\n');
  fs.writeFileSync(path.join(root, 'Daily', '2026-01-12.md'), '## 💰 Pazar portföy brifingi — 12.01.2026\n\nnew\n');
  // 04:00 on the 12th is still vault day 11 → the 11th's brief is "today's"
  assert.equal(fin.readLatestBrief(root, new Date(2026, 0, 12, 4, 0)).date, '2026-01-11');
  assert.equal(fin.readLatestBrief(root, new Date(2026, 0, 12, 9, 0)).date, '2026-01-12');
  const f = fin.readFinance(root, new Date(2026, 0, 12, 4, 0));
  assert.deepEqual(f.flags, { stale: [], unmeasured: [] });
  fs.rmSync(root, { recursive: true, force: true });
});
