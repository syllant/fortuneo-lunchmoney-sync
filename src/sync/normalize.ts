export function normalizeText(value: string, maxLength: number): string {
  const printable = Array.from(value.normalize("NFC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
