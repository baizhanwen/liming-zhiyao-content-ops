/** Split SQLite migrations without splitting quoted text or trigger bodies. */
export function splitSql(sql) {
  const statements = [];
  let statement = "", quote = null, trigger = false, depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (quote) {
      statement += c;
      const close = quote === "[" ? "]" : quote;
      if (c === close) { if (next === close && quote !== "[") statement += sql[++i]; else quote = null; }
      continue;
    }
    if (c === "-" && next === "-") { while (i < sql.length && sql[i] !== "\n") i++; statement += " "; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++; i++; statement += " "; continue; }
    if (["'", '"', "`", "["].includes(c)) { quote = c; statement += c; continue; }
    if (/[a-z_]/i.test(c)) {
      let word = c;
      while (i + 1 < sql.length && /[a-z_0-9]/i.test(sql[i + 1])) word += sql[++i];
      statement += word;
      if (/^\s*CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/i.test(statement)) trigger = true;
      if (trigger) {
        if (/^(BEGIN|CASE)$/i.test(word)) depth++;
        if (/^END$/i.test(word)) depth--;
      }
      continue;
    }
    if (c === ";" && (!trigger || depth === 0)) {
      if (statement.trim()) statements.push(statement.trim());
      statement = ""; trigger = false; depth = 0;
    } else statement += c;
  }
  if (quote || depth) throw new Error("Incomplete SQLite statement in migration");
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}
