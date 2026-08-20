import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  const directory = new URL("../../migrations/", import.meta.url);
  const migration = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(new URL(name, directory), "utf8"))
    .join("\n");

  it("contains no financial payload columns", () => {
    const forbidden = ["amount", "balance", "merchant", "payee", "description", "iban", "card_number", "holder_name", "transaction_date", "booking_date"];
    const columnDefinitions = [...migration.matchAll(/^\s*([a-z_]+)\s+(?:TEXT|INTEGER|REAL|BLOB)\b/gmu)].map((match) => match[1]);
    expect(columnDefinitions.filter((column) => forbidden.includes(column ?? ""))).toEqual([]);
  });

  it("indexes frequent lookups and enforces opaque uniqueness", () => {
    expect(migration).toContain("PRIMARY KEY");
    expect(migration).toContain("UNIQUE(connection_id, identification_hash)");
    expect(migration.match(/CREATE INDEX/gu)?.length).toBeGreaterThanOrEqual(10);
  });
});
