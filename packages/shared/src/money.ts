export function parseMinor(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(value)) throw new Error("INVALID_MONEY");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  return negative ? -minor : minor;
}

export function formatMinor(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10_000n;
  const fraction = (absolute % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function negateMoney(value: string): string {
  return formatMinor(-parseMinor(value));
}
