export function parseJson(str, fallback = null) {
  if (str == null) return fallback;
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

export function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

export function stringifyJson(value) {
  return JSON.stringify(value ?? null, jsonReplacer);
}
