import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const fail = (message) => { throw new Error(message); };
const walk = (path) => readdirSync(path).flatMap((name) => {
  const full = join(path, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const sourceFiles = walk(new URL("../src", import.meta.url).pathname).filter((file) => file.endsWith(".ts"));
const sources = sourceFiles.map((file) => [file, readFileSync(file, "utf8")]);

for (const [file, content] of sources) {
  if (/console\.(?:log|error|warn)/u.test(content) && !file.endsWith("observability/events.ts")) fail(`Direct logging forbidden: ${file}`);
  if (/\/payments(?:[/'"`?]|$)/u.test(content)) fail(`Payment endpoint forbidden: ${file}`);
}

const lunchClient = readFileSync(new URL("../src/providers/lunch-money/client.ts", import.meta.url), "utf8");
if (/this\.request\([^\n]+\{[\s\S]{0,120}?method:\s*["']DELETE["']/u.test(lunchClient)) fail("Lunch Money DELETE request found");

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
if (!/"production"[\s\S]+?"workers_dev"\s*:\s*true/u.test(config)) fail("workers.dev must be enabled for the no-domain production deployment");
if (!/"production"[\s\S]+?"preview_urls"\s*:\s*false/u.test(config)) fail("preview URLs must be disabled in production");
const production = JSON.parse(config).env?.production;
const productionCrons = production?.triggers?.crons;
const syncEnabled = production?.vars?.SYNC_ENABLED;
const hasDailyCron = Array.isArray(productionCrons)
  && productionCrons.length === 1
  && productionCrons[0] === "17 4 * * *";
const scheduledMode = (syncEnabled === "false" || syncEnabled === "true") && hasDailyCron;
const manualCanaryMode = syncEnabled === "true"
  && Array.isArray(productionCrons)
  && productionCrons.length === 0;
if (!scheduledMode && !manualCanaryMode) fail("production must use the reviewed Cron Trigger mode, or be enabled with no Cron Trigger for a manual canary");
if (/"schedules"\s*:/u.test(config)) fail("direct Workflow schedules are outside the reviewed architecture");

for (const secret of ["ENABLE_BANKING_APP_ID", "ENABLE_BANKING_PRIVATE_KEY", "LUNCH_MONEY_TOKEN", "TRANSACTION_HMAC_KEY", "OAUTH_STATE_HMAC_KEY", "ADMIN_PASSWORD", "WEB_PUSH_VAPID_PRIVATE_KEY"]) {
  const assignment = new RegExp(`"${secret}"\\s*:`, "u");
  if (assignment.test(config)) fail(`Secret configured in wrangler.jsonc: ${secret}`);
}

console.log(JSON.stringify({ event: "security_audit", status: "success", files_checked: sourceFiles.length }));
