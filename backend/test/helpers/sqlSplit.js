// Split a .sql file into individual statements the way psql -f executes them
// (statement by statement, autocommit, continuing after errors by default).
function splitSql(sql) {
  const stmts = [];
  let cur = '';
  let i = 0;
  let state = 'normal';
  let dollarTag = '';

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === 'normal') {
      if (ch === '-' && next === '-') { state = 'lineComment'; cur += ch + next; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'blockComment'; cur += ch + next; i += 2; continue; }
      if (ch === "'") { state = 'single'; cur += ch; i += 1; continue; }
      if (ch === '"') { state = 'double'; cur += ch; i += 1; continue; }
      if (ch === '$') {
        const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
        if (m) { dollarTag = m[0]; state = 'dollar'; cur += dollarTag; i += dollarTag.length; continue; }
      }
      if (ch === ';') { stmts.push(cur.trim()); cur = ''; i += 1; continue; }
      cur += ch; i += 1; continue;
    }

    if (state === 'lineComment') {
      cur += ch;
      if (ch === '\n') state = 'normal';
      i += 1; continue;
    }

    if (state === 'blockComment') {
      cur += ch;
      if (ch === '*' && next === '/') { cur += next; i += 2; state = 'normal'; continue; }
      i += 1; continue;
    }

    if (state === 'single') {
      if (ch === "'" && next === "'") { cur += "''"; i += 2; continue; }
      cur += ch;
      if (ch === "'") state = 'normal';
      i += 1; continue;
    }

    if (state === 'double') {
      cur += ch;
      if (ch === '"') state = 'normal';
      i += 1; continue;
    }

    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) { cur += dollarTag; i += dollarTag.length; state = 'normal'; continue; }
      cur += ch; i += 1; continue;
    }
  }

  if (cur.trim()) stmts.push(cur.trim());

  return stmts.filter((s) => {
    const withoutComments = s
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    return withoutComments.length > 0;
  });
}

module.exports = { splitSql };
