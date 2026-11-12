/*
 * mysql-sqlite.js — переходник: код, написанный для mysql2/promise, работает с базой-файлом SQLite (node:sqlite).
 *
 * Зачем: на Railway отдельный сервер MySQL занимает ~300–400 МБ памяти даже пустой (~$3–4 в месяц),
 * а база-файл не занимает ничего сверх самого сайта, и сайт может «засыпать», когда никто не заходит.
 *
 *   const { createPool, migrateFromMySQL } = require('./mysql-sqlite');
 *   const db = createPool(process.env.DB_FILE || '/data/app.db');
 *   const [rows] = await db.execute('SELECT * FROM t WHERE id = ?', [id]);   // как в mysql2
 *
 * Что переводится автоматически: AUTO_INCREMENT, ENUM, ENGINE/CHARSET, ON UPDATE CURRENT_TIMESTAMP,
 * NOW()/CURDATE()/DATE_SUB/DATE_ADD/INTERVAL, YEAR()/MONTH()/DAY()/HOUR()/WEEK(), DATE_FORMAT, CONCAT, GROUP_CONCAT
 * SEPARATOR, ON DUPLICATE KEY UPDATE … VALUES(x), INSERT IGNORE, FOR UPDATE, ALTER TABLE … ADD COLUMN (повтор — без
 * ошибки), information_schema.columns (через PRAGMA), IN (?) с массивом, insertId/affectedRows, транзакции.
 * Даты из столбцов DATE/DATETIME/TIMESTAMP возвращаются объектами Date, как в mysql2.
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- функции MySQL внутри SQLite
const pad = (n, w = 2) => String(n).padStart(w, '0');
function toDate(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}
const sqlDateTime = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const sqlDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function dateFormat(v, fmt) {
  const d = toDate(v);
  if (!d || fmt == null) return null;
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const W = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return String(fmt).replace(/%([a-zA-Z%])/g, (_, c) => ({
    Y: d.getUTCFullYear(), y: pad(d.getUTCFullYear() % 100), m: pad(d.getUTCMonth() + 1), c: d.getUTCMonth() + 1,
    d: pad(d.getUTCDate()), e: d.getUTCDate(), H: pad(d.getUTCHours()), k: d.getUTCHours(), i: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()), S: pad(d.getUTCSeconds()), M: M[d.getUTCMonth()], b: M[d.getUTCMonth()].slice(0, 3),
    W: W[d.getUTCDay()], a: W[d.getUTCDay()].slice(0, 3), w: d.getUTCDay(), '%': '%',
  })[c] ?? '%' + c);
}

function isoWeek(d) {  // MySQL WEEK(x) по умолчанию (режим 0: недели с воскресенья)
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const firstSunday = (7 - new Date(start).getUTCDay()) % 7;
  const day = Math.floor((d - start) / 86400000);
  return day < firstSunday ? 0 : Math.floor((day - firstSunday) / 7) + 1;
}

function registerFunctions(db) {
  const f = (name, fn, opts = {}) => db.function(name, { deterministic: false, ...opts }, fn);
  f('NOW', () => sqlDateTime(new Date()));
  f('CURRENT_TIMESTAMP', () => sqlDateTime(new Date()));
  f('UTC_TIMESTAMP', () => sqlDateTime(new Date()));
  f('CURDATE', () => sqlDate(new Date()));
  f('CURRENT_DATE', () => sqlDate(new Date()));
  f('UNIX_TIMESTAMP', (v) => Math.floor((v === undefined ? Date.now() : (toDate(v) || 0).valueOf()) / 1000), { varargs: true });
  f('FROM_UNIXTIME', (v) => (v == null ? null : sqlDateTime(new Date(Number(v) * 1000))));
  f('YEAR', (v) => { const d = toDate(v); return d ? d.getUTCFullYear() : null; });
  f('MONTH', (v) => { const d = toDate(v); return d ? d.getUTCMonth() + 1 : null; });
  f('DAY', (v) => { const d = toDate(v); return d ? d.getUTCDate() : null; });
  f('DAYOFMONTH', (v) => { const d = toDate(v); return d ? d.getUTCDate() : null; });
  f('DAYOFWEEK', (v) => { const d = toDate(v); return d ? d.getUTCDay() + 1 : null; });
  f('WEEKDAY', (v) => { const d = toDate(v); return d ? (d.getUTCDay() + 6) % 7 : null; });
  f('HOUR', (v) => { const d = toDate(v); return d ? d.getUTCHours() : null; });
  f('MINUTE', (v) => { const d = toDate(v); return d ? d.getUTCMinutes() : null; });
  f('WEEK', (v) => { const d = toDate(v); return d ? isoWeek(d) : null; }, { varargs: true });
  f('YEARWEEK', (v) => { const d = toDate(v); return d ? d.getUTCFullYear() * 100 + isoWeek(d) : null; }, { varargs: true });
  f('DATE_FORMAT', dateFormat);
  f('DATEDIFF', (a, b) => { const x = toDate(a), y = toDate(b); return x && y ? Math.floor((Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) - Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate())) / 86400000) : null; });
  f('TIMESTAMPDIFF_SEC', (a, b) => { const x = toDate(a), y = toDate(b); return x && y ? Math.floor((y - x) / 1000) : null; });
  f('CONCAT', (...a) => (a.some((x) => x === null) ? null : a.map((x) => (typeof x === 'bigint' ? x.toString() : x)).join('')), { varargs: true });
  f('CONCAT_WS', (sep, ...a) => a.filter((x) => x !== null).join(sep), { varargs: true });
  f('LEAST', (...a) => (a.some((x) => x === null) ? null : a.reduce((m, x) => (x < m ? x : m))), { varargs: true });
  f('GREATEST', (...a) => (a.some((x) => x === null) ? null : a.reduce((m, x) => (x > m ? x : m))), { varargs: true });
  f('LPAD', (s, n, p) => (s == null ? null : String(s).padStart(n, p).slice(0, n)));
  f('UUID', () => require('node:crypto').randomUUID());
  f('RAND', () => Math.random());
  f('FLOOR', (x) => (x == null ? null : Math.floor(x)));
  f('CEIL', (x) => (x == null ? null : Math.ceil(x)));
  f('CEILING', (x) => (x == null ? null : Math.ceil(x)));
  // LIKE без учёта регистра и для русских букв (как в MySQL), а не только для латиницы
  const likeCache = new Map();
  db.function('like', { deterministic: true, varargs: true }, (pattern, value, esc) => {
    if (pattern == null || value == null) return null;
    const key = pattern + '\u0000' + (esc || '');
    let re = likeCache.get(key);
    if (!re) {
      let src = '';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (esc && c === esc && i + 1 < pattern.length) { src += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
        src += c === '%' ? '[\\s\\S]*' : c === '_' ? '[\\s\\S]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      re = new RegExp(`^${src}$`, 'iu');
      if (likeCache.size > 500) likeCache.clear();
      likeCache.set(key, re);
    }
    return re.test(String(value)) ? 1 : 0;
  });
  f('DATE_ADD_SECONDS', (v, s) => { const d = toDate(v); return d ? sqlDateTime(new Date(d.valueOf() + s * 1000)) : null; });
  f('DATE_ADD_MONTHS', (v, m) => { const d = toDate(v); if (!d) return null; const r = new Date(d); r.setUTCMonth(r.getUTCMonth() + m); return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? sqlDate(r) : sqlDateTime(r); });
}

// ---------------------------------------------------------------- перевод текста запроса
const UNIT_SEC = { SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800 };

function balancedArg(s, start) {  // s[start] === '(' → индекс закрывающей скобки
  let depth = 0, q = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function splitTopComma(s) {
  const out = []; let depth = 0, q = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}

function intervalToCall(expr, sign, n, unit) {
  unit = unit.toUpperCase();
  if (unit === 'MONTH' || unit === 'YEAR') {
    const m = unit === 'YEAR' ? `(${n})*12` : `(${n})`;
    return `DATE_ADD_MONTHS(${expr}, ${sign}${m})`;
  }
  return `DATE_ADD_SECONDS(${expr}, ${sign}(${n})*${UNIT_SEC[unit]})`;
}

function rewriteFunc(sql, name, fn) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'i');
  let out = sql, m, guard = 0;
  while ((m = re.exec(out)) && guard++ < 200) {
    const open = m.index + m[0].length - 1;
    const close = balancedArg(out, open);
    if (close < 0) break;
    const args = splitTopComma(out.slice(open + 1, close));
    const rep = fn(args);
    if (rep == null) break;
    out = out.slice(0, m.index) + rep + out.slice(close + 1);
  }
  return out;
}

function outsideQuotes(s, fn) {  // применить fn только к частям вне строк '…' и комментариев
  let out = '', buf = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { out += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { out += fn(buf) + c; buf = ''; q = c; continue; }
    if (c === '-' && s[i + 1] === '-') { const e = s.indexOf('\n', i); const j = e < 0 ? s.length : e; out += fn(buf) + s.slice(i, j); buf = ''; i = j - 1; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); const j = e < 0 ? s.length : e + 2; out += fn(buf) + s.slice(i, j); buf = ''; i = j - 1; continue; }
    buf += c;
  }
  return out + fn(buf);
}

function translateDDL(sql) {
  let s = sql;
  s = s.replace(/\)\s*ENGINE\s*=?[\s\S]*$/i, ')');
  s = s.replace(/\b(?:DEFAULT\s+)?CHARSET\s*=?\s*\w+/gi, '').replace(/\bCHARACTER\s+SET\s+\w+/gi, '')
    .replace(/\bCOLLATE\s*=?\s*\w+/gi, '');
  s = s.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\))?/gi, '');
  s = s.replace(/\bENUM\s*\([^)]*\)/gi, 'TEXT').replace(/\bSET\s*\(('[^']*'\s*,?\s*)+\)/gi, 'TEXT');
  s = s.replace(/\bUNSIGNED\b/gi, '').replace(/\bZEROFILL\b/gi, '');
  s = s.replace(/\bCOMMENT\s+'(?:[^'\\]|\\.|'')*'/gi, '');
  // автоинкремент: «id INT … AUTO_INCREMENT [PRIMARY KEY]» → INTEGER PRIMARY KEY AUTOINCREMENT
  let aiCol = null;
  s = s.replace(/(`?\w+`?)\s+(?:TINY|SMALL|MEDIUM|BIG)?INT(?:EGER)?(?:\s*\(\d+\))?((?:\s+NOT\s+NULL|\s+NULL)?)\s+AUTO_INCREMENT(\s+PRIMARY\s+KEY)?/gi,
    (_, col) => { aiCol = col.replace(/`/g, ''); return `${col} INTEGER PRIMARY KEY AUTOINCREMENT`; });
  if (aiCol) s = s.replace(new RegExp(`,\\s*PRIMARY\\s+KEY\\s*\\(\\s*\`?${aiCol}\`?\\s*\\)`, 'i'), '');
  s = s.replace(/\bAUTO_INCREMENT\s*=\s*\d+/gi, '');
  // индексы внутри CREATE TABLE: KEY/INDEX/FULLTEXT убираем, UNIQUE KEY name (…) → UNIQUE (…)
  s = s.replace(/,\s*(?:FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?\w*`?\s*\([^)]*\)(?:\s+USING\s+\w+)?/gi, '');
  s = s.replace(/\bUNIQUE\s+(?:KEY|INDEX)\s+`?\w+`?\s*\(/gi, 'UNIQUE (');
  s = s.replace(/\b(?:TINY|MEDIUM|LONG)TEXT\b/gi, 'TEXT').replace(/\bDATETIME\(\d\)/gi, 'DATETIME')
    .replace(/\bTIMESTAMP\(\d\)/gi, 'TIMESTAMP');
  s = s.replace(/DEFAULT\s+CURRENT_TIMESTAMP(\(\))?/gi, 'DEFAULT CURRENT_TIMESTAMP');
  s = s.replace(/\bDEFAULT\s+\(\s*UUID\(\)\s*\)/gi, '');
  return s;
}

function translate(sql) {
  let s = String(sql);
  if (/^\s*CREATE\s+TABLE/i.test(s)) return { sql: translateDDL(s) };
  const alter = s.match(/^\s*ALTER\s+TABLE\s+`?(\w+)`?\s+([\s\S]+)$/i);
  if (alter) return { alter: { table: alter[1], body: alter[2] } };
  if (/^\s*(SET\s+(NAMES|SESSION|FOREIGN_KEY_CHECKS|SQL_MODE|time_zone)|USE\s|SHOW\s+WARNINGS)/i.test(s)) return { noop: true };
  const isCols = s.match(/information_schema\.columns/i);
  if (isCols) return { infoSchema: s };

  s = s.replace(/\bINSERT\s+IGNORE\b/gi, 'INSERT OR IGNORE');
  s = s.replace(/\bIF\s*\(/gi, (m, off, str) => (/\bEXISTS\s*$/i.test(str.slice(0, off)) ? m : 'iif('));
  s = s.replace(/\bIFNULL\s*\(/gi, 'ifnull(');
  s = s.replace(/\bFOR\s+UPDATE\b/gi, '').replace(/\bLOCK\s+IN\s+SHARE\s+MODE\b/gi, '');
  s = s.replace(/\bCURRENT_TIMESTAMP\(\)/gi, 'NOW()').replace(/\bCURRENT_DATE\(\)/gi, 'CURDATE()');
  s = s.replace(/\bLIMIT\s+(\?|\d+)\s*,\s*(\?|\d+)/gi, (_, a, b) =>
    (a === '?' && b === '?' ? 'LIMIT ?#SWAP OFFSET ?' : `LIMIT ${b} OFFSET ${a}`));  // MySQL: LIMIT смещение, количество
  // DATE_SUB/DATE_ADD(expr, INTERVAL n UNIT)
  for (const [name, sign] of [['DATE_SUB', '-'], ['DATE_ADD', '']]) {
    s = rewriteFunc(s, name, (args) => {
      const m = args[1] && args[1].match(/^\s*INTERVAL\s+([\s\S]+?)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\s*$/i);
      return m ? intervalToCall(args[0].trim(), sign, m[1], m[2]) : null;
    });
  }
  // expr ± INTERVAL n UNIT (expr — NOW(), CURDATE(), столбец или ?)
  s = s.replace(/((?:NOW|CURDATE|UTC_TIMESTAMP)\(\)|`?[\w.]+`?|\?)\s*([-+])\s*INTERVAL\s+(\?|-?\d+|\([^)]*\))\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\b/gi,
    (_, e, op, n, unit) => intervalToCall(e, op === '-' ? '-' : '', n, unit));
  // TIMESTAMPDIFF(UNIT, a, b)
  s = rewriteFunc(s, 'TIMESTAMPDIFF', (args) => {
    const unit = args[0].trim().toUpperCase();
    const div = UNIT_SEC[unit] || (unit === 'MONTH' ? 2592000 : unit === 'YEAR' ? 31536000 : 1);
    return `(TIMESTAMPDIFF_SEC(${args[1]}, ${args[2]}) / ${div})`;
  });
  // GROUP_CONCAT(x SEPARATOR ',') → group_concat(x, ',')
  s = s.replace(/GROUP_CONCAT\s*\(([\s\S]*?)\s+SEPARATOR\s+('(?:[^']|'')*')\s*\)/gi, 'group_concat($1, $2)');
  s = s.replace(/GROUP_CONCAT\s*\(\s*DISTINCT\s+([^)]*?)\s+ORDER\s+BY\s+[^)]*\)/gi, 'group_concat(DISTINCT $1)');
  // ON DUPLICATE KEY UPDATE a = VALUES(a) → ON CONFLICT DO UPDATE SET a = excluded.a
  s = s.replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, 'ON CONFLICT DO UPDATE SET');
  s = s.replace(/\bVALUES\s*\(\s*`?(\w+)`?\s*\)/gi, (m, col, off, str) =>
    (/ON CONFLICT DO UPDATE SET/i.test(str.slice(0, off)) ? `excluded.${col}` : m));
  // INSERT … SELECT … ON CONFLICT нужен WHERE (особенность SQLite) — редкий случай, не трогаем
  // CAST(x AS UNSIGNED/SIGNED) → INTEGER; CAST(x AS CHAR) → TEXT
  s = s.replace(/\bAS\s+(?:UNSIGNED|SIGNED)(?:\s+INTEGER)?\b/gi, 'AS INTEGER').replace(/\bAS\s+CHAR(\(\d+\))?/gi, 'AS TEXT')
    .replace(/\bAS\s+DECIMAL\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'AS REAL');
  s = outsideQuotes(s, (part) => part.replace(/\s\/\s|\/(?=[\s(\w`])/g, (m) => m.replace('/', '*1.0/')));  // 5/2 = 2.5, как в MySQL
  return { sql: s };
}

// ---------------------------------------------------------------- значения
function toParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return isNaN(v) ? null : sqlDateTime(v);
  if (Buffer.isBuffer(v)) return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(v); if (!isNaN(d)) return sqlDateTime(d);  // как MySQL: дата-время без «T» и «Z», в UTC
  }
  return v;
}

function expandParams(sql, params) {
  // «?» вне строк: IN (?) с массивом, VALUES ? с массивом строк, SET ? с объектом, LIMIT/OFFSET — числа
  const out = []; let i = 0, text = '', q = null, swapAt = -1;
  for (let k = 0; k < sql.length; k++) {
    const c = sql[k];
    if (q) { text += c; if (c === q && sql[k - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; text += c; continue; }
    if (c !== '?') { text += c; continue; }
    const v = params[i++];
    if (sql.startsWith('#SWAP', k + 1)) { swapAt = out.length; k += 5; }
    if (/\b(LIMIT|OFFSET)\s*$/i.test(text)) { out.push(v == null ? -1 : Number(v)); text += '?'; continue; }
    if (Array.isArray(v)) {
      if (!v.length) { text += 'NULL'; continue; }
      if (Array.isArray(v[0])) {
        v.forEach((row) => row.forEach((x) => out.push(toParam(x))));
        text += v.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ');
        continue;
      }
      v.forEach((x) => out.push(toParam(x)));
      text += v.map(() => '?').join(', ');
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && /\bSET\s*$/i.test(text)) {
      const keys = Object.keys(v);
      keys.forEach((key) => out.push(toParam(v[key])));
      text += keys.map((key) => `\`${key}\` = ?`).join(', ');
      continue;
    }
    out.push(toParam(v));
    text += '?';
  }
  if (swapAt >= 0) { const t = out[swapAt]; out[swapAt] = out[swapAt + 1]; out[swapAt + 1] = t; }
  return { text, params: out };
}

const DATE_TYPES = /^(DATE|DATETIME|TIMESTAMP)/i;
function convertRow(row, dateCols, jsonCols = [], decCols = []) {
  for (const [k, scale] of decCols) {  // DECIMAL(10,2): mysql2 отдаёт строку «10.50» — так же
    if (typeof row[k] === 'number' || typeof row[k] === 'bigint') row[k] = Number(row[k]).toFixed(scale);
  }
  for (const k of jsonCols) {
    if (typeof row[k] === 'string') { try { row[k] = JSON.parse(row[k]); } catch (_) {} }
  }
  for (const k of dateCols) {
    const v = row[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?Z?$/.test(v)) row[k] = toDate(v);
  }
  for (const k of Object.keys(row)) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
}

// ---------------------------------------------------------------- пул
function createPool(file, { log = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  registerFunctions(db);
  let txOwner = null;  // транзакция идёт — остальные ждут
  const waiters = [];
  const waitTurn = async (conn) => { while (txOwner && txOwner !== conn) await new Promise((r) => waiters.push(r)); };
  const release = () => { txOwner = null; while (waiters.length) waiters.shift()(); };

  function columnsOf(table) {
    return db.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((c) => c.name);
  }

  function runAlter(table, body) {
    const parts = splitTopComma(body);
    for (let p of parts) {
      p = p.trim();
      let m;
      if ((m = p.match(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+([\s\S]+)$/i)) && !/^ADD\s+(UNIQUE|INDEX|KEY|PRIMARY|CONSTRAINT|FULLTEXT|FOREIGN)/i.test(p)) {
        if (columnsOf(table).includes(m[1])) {
          if (/IF\s+NOT\s+EXISTS/i.test(p)) continue;
          const e = new Error(`Duplicate column name '${m[1]}'`); e.code = 'ER_DUP_FIELDNAME'; e.errno = 1060; throw e;
        }
        let def = translateDDL(`CREATE TABLE x (${m[1]} ${m[2]})`).replace(/^CREATE TABLE x \(\w+ /, '').replace(/\)$/, '');
        def = def.replace(/\s+(AFTER\s+`?\w+`?|FIRST)\s*$/i, '').replace(/\bNOT\s+NULL\b(?![\s\S]*DEFAULT)/i, '');
        if (/DEFAULT\s+CURRENT_TIMESTAMP/i.test(def)) def = def.replace(/DEFAULT\s+CURRENT_TIMESTAMP/i, '');  // SQLite не умеет
        db.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${m[1]}\` ${def}`);
      } else if ((m = p.match(/^ADD\s+(UNIQUE\s+)?(?:INDEX|KEY)\s+`?(\w+)`?\s*\(([^)]+)\)/i))) {
        db.exec(`CREATE ${m[1] ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS \`${m[2]}\` ON \`${table}\` (${m[3]})`);
      } else if ((m = p.match(/^DROP\s+(?:COLUMN\s+)?`?(\w+)`?$/i)) && columnsOf(table).includes(m[1])) {
        db.exec(`ALTER TABLE \`${table}\` DROP COLUMN \`${m[1]}\``);
      }
      // MODIFY/CHANGE/ADD CONSTRAINT/CONVERT TO и т. п. — в SQLite типы не строгие, пропускаем
    }
  }

  function infoSchema(sql, params) {
    // SELECT … FROM information_schema.columns WHERE … TABLE_NAME = ? / 'x' AND COLUMN_NAME = ? / 'y'
    const vals = [...params];
    const pick = (name) => {
      const re = new RegExp(`${name}\\s*=\\s*(\\?|'([^']*)')`, 'i');
      const m = sql.match(re);
      if (!m) return undefined;
      if (m[1] === '?') {
        const idx = (sql.slice(0, m.index).match(/\?/g) || []).length;
        return vals[idx];
      }
      return m[2];
    };
    const table = pick('TABLE_NAME'), column = pick('COLUMN_NAME');
    const cols = table ? columnsOf(table) : [];
    const hit = column === undefined ? cols : cols.filter((c) => c === column);
    if (/COUNT\s*\(/i.test(sql)) {
      const alias = (sql.match(/COUNT\s*\(\s*\*\s*\)\s+(?:AS\s+)?(\w+)/i) || [])[1] || 'COUNT(*)';
      return [[{ [alias]: hit.length }], []];
    }
    return [hit.map((c) => ({ COLUMN_NAME: c, column_name: c })), []];
  }

  function run(sql, params = []) {
    const t = translate(sql);
    if (t.noop) return [{ affectedRows: 0, insertId: 0 }, []];
    if (t.infoSchema) return infoSchema(t.infoSchema, params);
    if (t.alter) { runAlter(t.alter.table, t.alter.body); return [{ affectedRows: 0, insertId: 0 }, []]; }
    const { text, params: p } = expandParams(t.sql, params || []);
    if (log) console.log('[sqlite]', text, p);
    let stmt;
    try {
      stmt = db.prepare(text);
    } catch (e) {
      if (/^\s*CREATE\s+TABLE/i.test(text) && /already exists/.test(e.message)) return [{ affectedRows: 0, insertId: 0 }, []];
      e.message += `\n  SQL: ${text}`; throw e;
    }
    const isRead = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(text) || /\bRETURNING\b/i.test(text);
    if (isRead) {
      const rows = stmt.all(...p);
      let dateCols = [], jsonCols = [], decCols = [];
      try {
        const cols = stmt.columns();
        dateCols = cols.filter((c) => c.type && DATE_TYPES.test(c.type)).map((c) => c.name);
        jsonCols = cols.filter((c) => c.type && /^JSON/i.test(c.type)).map((c) => c.name);
        decCols = cols.map((c) => [c.name, (String(c.type || '').match(/^(?:DECIMAL|NUMERIC)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/i) || [])[1]])
          .filter(([, sc]) => sc !== undefined).map(([n, sc]) => [n, +sc]);
      } catch (_) {}
      return [rows.map((r) => convertRow({ ...r }, dateCols, jsonCols, decCols)), []];
    }
    try {
      const r = stmt.run(...p);
      return [{ affectedRows: Number(r.changes), changedRows: Number(r.changes), insertId: Number(r.lastInsertRowid), warningStatus: 0 }, []];
    } catch (e) {
      if (/UNIQUE constraint failed/.test(e.message)) { e.code = 'ER_DUP_ENTRY'; e.errno = 1062; }
      e.message += `\n  SQL: ${text}`; throw e;
    }
  }

  function makeConn() {
    const conn = {
      async query(sql, params) { await waitTurn(conn); return run(typeof sql === 'object' ? sql.sql : sql, params || (typeof sql === 'object' ? sql.values : [])); },
      async execute(sql, params) { return conn.query(sql, params); },
      async beginTransaction() { await waitTurn(conn); txOwner = conn; db.exec('BEGIN IMMEDIATE'); },
      async commit() { try { db.exec('COMMIT'); } finally { if (txOwner === conn) release(); } },
      async rollback() { try { db.exec('ROLLBACK'); } catch (_) {} finally { if (txOwner === conn) release(); } },
      release() { if (txOwner === conn) { try { db.exec('ROLLBACK'); } catch (_) {} release(); } },
      destroy() { conn.release(); },
      async end() {},
      async ping() {},
    };
    return conn;
  }

  const pool = makeConn();
  pool.getConnection = async () => makeConn();
  pool.promise = () => pool;
  pool.end = async () => {};
  pool.on = () => pool;
  pool.raw = db;
  pool.translate = translate;
  return pool;
}

// ---------------------------------------------------------------- перенос данных из MySQL (один раз)
/*
 * Копирует все таблицы из MySQL в SQLite при первом запуске новой версии. Таблицы, которые программа уже создала
 * в SQLite своим кодом, заполняются (только общие столбцы); остальные создаются по SHOW CREATE TABLE.
 * Отметка о переносе — таблица _migrated_from_mysql: второй раз не копирует.
 */
async function migrateFromMySQL(pool, mysqlConfig, { log = console.log } = {}) {
  const db = pool.raw;
  db.exec('CREATE TABLE IF NOT EXISTS _migrated_from_mysql (at TEXT, tables INTEGER, rows INTEGER)');
  if (db.prepare('SELECT COUNT(*) AS n FROM _migrated_from_mysql').get().n > 0) return { skipped: true };
  if (!mysqlConfig || !mysqlConfig.host) { log('[migrate] MySQL не задан — пропускаю перенос'); return { skipped: true }; }
  let mysql;
  try { mysql = require('mysql2/promise'); } catch (_) { log('[migrate] нет mysql2 — пропускаю'); return { skipped: true }; }
  const conn = await mysql.createConnection({ ...mysqlConfig, dateStrings: false, supportBigNumbers: true, bigNumberStrings: false });
  let tables = 0, total = 0;
  try {
    const [list] = await conn.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
    for (const r of list) {
      const table = Object.values(r)[0];
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) {
        const [[c]] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
        const ddl = translateDDL(c['Create Table']).replace(/,\s*CONSTRAINT\s+`?\w+`?\s+FOREIGN\s+KEY[\s\S]*?REFERENCES\s+`?\w+`?\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))*/gi, '');
        db.exec(ddl);
      }
      // столбцы, которые есть в MySQL, но нет в SQLite (программа добавляла их по ходу работы) — добавить
      const [myCols] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
      const have = new Set(db.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((c) => c.name));
      for (const mc of myCols) {
        if (have.has(mc.Field)) continue;
        const type = translateDDL(`CREATE TABLE x (c ${mc.Type})`).replace(/^CREATE TABLE x \(c /, '').replace(/\)$/, '');
        db.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${mc.Field}\` ${type}`);
      }
      const info = db.prepare(`PRAGMA table_info(\`${table}\`)`).all();
      const cols = info.map((c) => c.name);
      const dateOnly = new Set(info.filter((c) => /^DATE$/i.test(c.type)).map((c) => c.name));
      const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
      if (!rows.length) { tables++; continue; }
      const use = Object.keys(rows[0]).filter((k) => cols.includes(k));
      const ins = db.prepare(`INSERT OR REPLACE INTO \`${table}\` (${use.map((k) => `\`${k}\``).join(', ')}) VALUES (${use.map(() => '?').join(', ')})`);
      db.exec('BEGIN');
      try {
        for (const row of rows) ins.run(...use.map((k) => (dateOnly.has(k) && row[k] instanceof Date ? sqlDate(row[k]) : toParam(row[k]))));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      // счётчик автоинкремента — как был
      tables++; total += rows.length;
      log(`[migrate] ${table}: ${rows.length}`);
    }
    db.prepare('INSERT INTO _migrated_from_mysql VALUES (?, ?, ?)').run(new Date().toISOString(), tables, total);
    log(`[migrate] готово: таблиц ${tables}, строк ${total}`);
    return { tables, rows: total };
  } finally {
    await conn.end();
  }
}

module.exports = { createPool, migrateFromMySQL, translate, translateDDL };
