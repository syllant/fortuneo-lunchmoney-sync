import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const files = ["README.md", ...await walk("packages"), ...await walk("scripts"), ...await walk("test"), ...await walk("docs")];
const forbidden = [
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /chrome\.storage\.(?:local|sync)\.set\([^)]*(?:token|hmac|cookie|credential|password|accessCode)/i,
  /console\.(?:log|info|debug)\s*\(/,
  /eval\s*\(|new Function\s*\(/,
];
const findings = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const rule of forbidden) if (rule.test(content)) findings.push(`${file}: ${rule}`);
}
if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Security audit passed (${files.length} files checked).\n`);
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}
