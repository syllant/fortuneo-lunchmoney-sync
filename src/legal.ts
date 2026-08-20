function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const PRIVACY = `
<h1>Privacy notice</h1>
<p>Last updated: 14 August 2026</p>
<p>This is a personal, non-commercial application used only by its operator to copy the operator's own Fortuneo account information to the operator's own Lunch Money budget.</p>
<h2>Controller and contact</h2>
<p>The application operator is the data controller. Data-protection questions and requests may be sent to __CONTACT_EMAIL__.</p>
<h2>Data processed and purpose</h2>
<p>After the operator gives explicit bank authorization, the application processes account identifiers, account balances, and booked transaction details supplied through Enable Banking. It uses this information only to create or update corresponding manual accounts and transactions in Lunch Money.</p>
<h2>Storage and retention</h2>
<p>Raw banking responses, transaction descriptions, amounts, and balances are processed transiently and are not stored in the application's Cloudflare D1 database. D1 stores only operational metadata such as opaque provider session references, account identification hashes, HMAC fingerprints, timestamps, counters, and synchronization state. OAuth state is valid for five minutes and can be consumed only once. Imported financial records remain in Lunch Money until the operator changes or deletes them there.</p>
<h2>Processors and recipients</h2>
<p>Data is processed by Fortuneo, Enable Banking, Cloudflare, and Lunch Money as necessary to provide their respective services. The application does not sell data, provide it to advertisers, or use analytics or tracking cookies.</p>
<h2>Security and control</h2>
<p>Administrative routes require a secret password over HTTPS. Bank access is read-only and may be revoked. Synchronization writes are disabled by default and must be deliberately enabled after validation.</p>
<h2>Your rights</h2>
<p>Requests concerning access, correction, deletion, restriction, portability, or objection may be sent to the contact address above. The operator may also revoke bank authorization, disconnect the application, and remove imported data from Lunch Money.</p>`;

const TERMS = `
<h1>Terms of use</h1>
<p>Last updated: 14 August 2026</p>
<h2>Personal application</h2>
<p>This application is a private, non-commercial tool for its operator's own accounts. It is not offered as a service to the public, and no third party is authorized to use it.</p>
<h2>Function</h2>
<p>The application obtains read-only account information from Fortuneo through Enable Banking and, when explicitly enabled, creates or updates corresponding manual accounts and transactions in the operator's Lunch Money budget. It does not initiate bank payments or transfers.</p>
<h2>Operator responsibilities</h2>
<p>The operator is responsible for protecting credentials, reviewing imported information, maintaining valid authorizations, complying with the terms of Fortuneo, Enable Banking, Cloudflare, and Lunch Money, and disabling the application if unexpected behavior occurs.</p>
<h2>Availability and accuracy</h2>
<p>The application is provided as-is for personal use. Bank and third-party data may be delayed, incomplete, or unavailable. The operator must verify important information against authoritative bank records and accepts responsibility for any corrections in Lunch Money.</p>
<h2>Third-party services</h2>
<p>Use depends on Fortuneo, Enable Banking, Cloudflare, and Lunch Money. Their separate terms and privacy notices govern their services.</p>
<h2>Changes and termination</h2>
<p>The operator may change, suspend, or discontinue the application at any time and may revoke its bank authorization or provider credentials.</p>
<h2>Contact</h2>
<p>Questions may be sent to __CONTACT_EMAIL__.</p>`;

export function renderLegalPage(kind: "privacy" | "terms", contactEmail: string): string {
  const title = kind === "privacy" ? "Privacy notice" : "Terms of use";
  const body = (kind === "privacy" ? PRIVACY : TERMS).replaceAll("__CONTACT_EMAIL__", escapeHtml(contactEmail));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Fortuneo Lunch Money Sync</title></head><body><main>${body}</main></body></html>`;
}
