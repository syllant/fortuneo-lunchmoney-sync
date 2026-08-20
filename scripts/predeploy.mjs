import { readFileSync } from "node:fs";

const fail = (message) => { throw new Error(message); };
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const production = config.env?.production;
if (!production) fail("Missing env.production in wrangler.jsonc");

const callbackUrl = production.vars?.CALLBACK_URL;
if (typeof callbackUrl !== "string" || callbackUrl.endsWith(".example/callback")) {
  fail("Replace the production CALLBACK_URL placeholder before deployment");
}
if (production.vars?.DATA_PROTECTION_EMAIL === "operator@example.com") {
  fail("Replace the production DATA_PROTECTION_EMAIL placeholder before deployment");
}
if (production.vars?.WEB_PUSH_VAPID_PUBLIC_KEY === "REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY") {
  fail("Replace the production WEB_PUSH_VAPID_PUBLIC_KEY placeholder before deployment");
}
const databaseId = production.d1_databases?.find((binding) => binding.binding === "DB")?.database_id;
if (databaseId === "00000000-0000-0000-0000-000000000000") {
  fail("Replace the production D1 database_id placeholder before deployment");
}
if (production.preview_urls !== false) fail("Production preview URLs must remain disabled");

console.log(JSON.stringify({ event: "predeploy_validation", status: "success" }));
