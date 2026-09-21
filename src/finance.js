// Finance panel reader — read-only view of what /finance keeps in the vault:
// Areas/Finance.md (§Sicil table + <!--finance:X--> blocks), the newest Daily
// note carrying "## 💰 Pazar portföy brifingi", Areas/Finance/calls/*.md
// frontmatter. Nothing here writes; the vault is the single source of truth.
// Faz 0 contract: the panel shows data and the record, never an order.
const fs = require('fs');
const path = require('path');

const BRIEF_HEADING = '## 💰 Pazar portföy brifingi';
const SICIL_HEADER_RE = /^\|\s*Tarih\s*\|\s*Portföy TL\s*\|/;
const BLOCK_RE = /<!--finance:([a-z]+):start-->\n?([\s\S]*?)\n?<!--finance:\1:end-->/g;
const RULE_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/;
// Warning lines /finance writes above the rules table (22.09): "⚠️ snapshot bayat: CCOLA (fill 108 > PDF 0), …"
// and "⚠️ ölçülemedi: akbnk_low, garan_low — AKBNK 65,20 · 16.09.2026 kapanışı (3 seans geri); …".
const FLAG_LINE_RE = /^⚠️\s*(snapshot bayat|ölçülemedi)\s*:\s*(.*)$/u;

// Vault day runs 05:00 → 05:00 (bash .claude/bin/vault-day); local clock, never UTC —
// toISOString() at 01:30 Istanbul on the 12th names the 11th only by accident, and at
// 04:00 it names the 12th, which the vault does not have yet.
const DAY_START_HOUR = 5;
function vaultDayStamp(d = new Date()) {
  const t = new Date(d.getTime() - DAY_START_HOUR * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// §Sicil: fixed 8-column table; rows newest-first, capped.
function parseSicil(content, limit = 8) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!SICIL_HEADER_RE.test(lines[i].trim())) continue;
    const columns = splitRow(lines[i]);
    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t.startsWith('|')) break;
      const cells = splitRow(t);
      if (cells.length !== columns.length) continue;
      rows.push({ date: cells[0], cells });
    }
    rows.reverse();
    return { columns, rows: rows.slice(0, limit), total: rows.length };
  }
  return { columns: [], rows: [], total: 0 };
}

function parseBlocks(content) {
  const out = {};
  const text = String(content || '').replace(/\r\n/g, '\n');
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text))) out[m[1]] = m[2].trim();
  return out;
}

// The rules block's table: | `id` | 🔴 tetik / ✅ / ℹ️ / ⚠️ ölçülemedi | measure | evet/— |
// 'unmeasured' (22.09) = the rule was NOT evaluated (close null or 2+ sessions old); it is never 'ok'.
function ruleStatus(st) {
  if (st.includes('🔴')) return 'fired';
  if (st.includes('⚠') || /ölçülemedi/iu.test(st)) return 'unmeasured';
  if (st.includes('ℹ')) return 'info';
  return 'ok';
}

function parseRules(block) {
  const rows = [];
  for (const line of String(block || '').split('\n')) {
    const m = RULE_ROW_RE.exec(line.trim());
    if (!m) continue;
    rows.push({ id: m[1], status: ruleStatus(m[2]), measure: m[3], task: m[4] === 'evet' });
  }
  return rows;
}

// Flag lines above the table → { stale: [{code, text}], unmeasured: [{code, text}] }.
// Codes are the leading uppercase tickers of each ", " / "; " separated item.
function parseFlags(block) {
  const out = { stale: [], unmeasured: [] };
  for (const raw of String(block || '').split('\n')) {
    const m = FLAG_LINE_RE.exec(raw.trim());
    if (!m) continue;
    const kind = m[1] === 'snapshot bayat' ? 'stale' : 'unmeasured';
    let body = m[2].replace(/\s+—\s+değer eklenmedi.*$/u, '').trim();
    if (kind === 'unmeasured') {
      // "akbnk_low, garan_low — AKBNK 65,20 · 16.09.2026 kapanışı (3 seans geri); GARAN …"
      const dash = body.indexOf(' — ');
      out.rules = dash >= 0 ? body.slice(0, dash).split(',').map((r) => r.trim()).filter(Boolean) : [];
      body = dash >= 0 ? body.slice(dash + 3) : body;
    }
    const items = body.split(kind === 'stale' ? /,\s+(?=[A-Z0-9]{3,6}\s)/u : /;\s+/u);
    for (const it of items) {
      const t = it.trim();
      const code = /^([A-Z0-9]{3,6})\b/u.exec(t);
      if (t) out[kind].push({ code: code ? code[1] : '', text: t });
    }
  }
  return out;
}

// Calendar block: "- dd.MM.yyyy (+N gün): what"
function parseCalendar(block, limit = 6) {
  const out = [];
  for (const line of String(block || '').split('\n')) {
    const m = /^-\s+(\d{2}\.\d{2}\.\d{4})\s+\(([+-]?\d+)\s+gün\):\s+(.*)$/.exec(line.trim());
    if (m) out.push({ date: m[1], days: Number(m[2]), what: m[3] });
  }
  return out.slice(0, limit);
}

function extractBrief(daily) {
  const text = String(daily || '').replace(/\r\n/g, '\n');
  const idx = text.indexOf(BRIEF_HEADING);
  if (idx < 0) return null;
  const rest = text.slice(idx);
  const next = rest.slice(BRIEF_HEADING.length).search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, BRIEF_HEADING.length + next)).trim();
}

// Minimal frontmatter reader (key: value, lists ignored) — enough for calls.
function frontmatter(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return {};
  const end = t.indexOf('\n---', 4);
  if (end < 0) return {};
  const out = {};
  for (const line of t.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v === '' || v === 'null') v = null;
    else if (/^".*"$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readCalls(vaultPath) {
  const dir = path.join(vaultPath, 'Areas', 'Finance', 'calls');
  const empty = { open: [], resolved: 0, total: 0, brier: null };
  if (!fs.existsSync(dir)) return empty;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return empty;
  }
  const open = [];
  let resolved = 0;
  const briers = [];
  for (const f of files) {
    let fm;
    try {
      fm = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!fm.id) continue;
    if (fm.status === 'resolved') {
      resolved += 1;
      const b = parseFloat(fm.brier);
      if (Number.isFinite(b)) briers.push(b);
    } else {
      open.push({ id: fm.id, type: fm.type || '?', instrument: fm.instrument || '?', probability: fm.probability, horizon: fm.horizon_date, decision: fm.decision || '' });
    }
  }
  const brier = briers.length ? Math.round((briers.reduce((a, b) => a + b, 0) / briers.length) * 1000) / 1000 : null;
  return { open, resolved, total: open.length + resolved, brier };
}

function readLatestBrief(vaultPath, date = new Date(), lookback = 14) {
  const dir = path.join(vaultPath, 'Daily');
  for (let i = 0; i <= lookback; i++) {
    const d = new Date(date);
    d.setDate(d.getDate() - i);
    const stamp = vaultDayStamp(d);
    const file = path.join(dir, `${stamp}.md`);
    if (!fs.existsSync(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const md = extractBrief(text);
    if (md) return { date: stamp, file: `Daily/${stamp}.md`, markdown: md };
  }
  return null;
}

function readFinance(vaultPath, date = new Date()) {
  const file = path.join(vaultPath, 'Areas', 'Finance.md');
  let content = '';
  try {
    content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    content = '';
  }
  const blocks = parseBlocks(content);
  const sicil = parseSicil(content);
  const last = sicil.rows[0] || null;
  return {
    available: Boolean(content),
    sicil,
    last: last ? Object.fromEntries(sicil.columns.map((c, i) => [c, last.cells[i]])) : null,
    record: (blocks.record || '').split('\n')[0] || '',
    rules: parseRules(blocks.rules),
    flags: parseFlags(blocks.rules),
    calendar: parseCalendar(blocks.calendar),
    brief: readLatestBrief(vaultPath, date),
    calls: readCalls(vaultPath),
  };
}

module.exports = { parseSicil, parseBlocks, parseRules, parseFlags, parseCalendar, extractBrief, frontmatter, readCalls, readLatestBrief, readFinance, vaultDayStamp };
