export class JsonByteBudgetExceededError extends Error {
  constructor() { super("JSON exceeds its UTF-8 byte budget"); }
}

// Count the JSON representation of data-only values before allocating it.
// Callers must use plain records/arrays, without getters or toJSON hooks.
export function assertJsonByteBudget(value: unknown, maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Invalid JSON byte budget");
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  function add(amount: number) {
    bytes += amount;
    if (bytes > maximum) throw new JsonByteBudgetExceededError();
  }
  function string(text: string) {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add((code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 2 : 6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); index++; } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  function visit(item: unknown) {
    if (item === null || item === undefined) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item !== "object") throw new TypeError("Expected data-only JSON values");
    if (ancestors.has(item)) throw new TypeError("Circular JSON value");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError("Expected a plain JSON record");
    ancestors.add(item); add(2);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) { if (index) add(1); visit(item[index]); }
    } else {
      let first = true;
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (descriptor.get || descriptor.set || key === "toJSON" && typeof descriptor.value === "function") throw new TypeError("Expected JSON records without serialization hooks");
        if (descriptor.value === undefined) continue;
        if (!first) add(1); first = false;
        string(key); add(1); visit(descriptor.value);
      }
    }
    ancestors.delete(item);
  }
  if (value === undefined) throw new TypeError("Expected a JSON document");
  visit(value);
  return bytes;
}
