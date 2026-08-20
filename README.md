# Fortuneo → Lunch Money

A personal synchronizer that reads booked Fortuneo transactions through Enable Banking and imports them into Lunch Money v2 manual accounts. It runs on Cloudflare Workers, Workflows, and D1 and is designed not to retain raw financial data in D1, logs, or Workflow results.

## Important warning

This is an unsupported personal project, not a maintained product or a reference implementation.

- There is **no support**, service commitment, migration assistance, or guarantee of future maintenance.
- The author has only verified the software for the author's own setup. It has **not received thorough testing**, an independent security audit, or broad testing across banks, accounts, locales, API changes, failure modes, and Cloudflare plans.
- A successful automated test run does not prove that a real import is complete, correct, secure, or free of duplicates.
- Enable Banking, Fortuneo, Lunch Money, and Cloudflare can change their APIs, behavior, availability, pricing, or terms independently of this repository.
- Any new user deploys and operates this software **entirely at their own risk**. Review the code, legal pages, provider permissions, generated transactions, logs, retention, and costs yourself. Keep independent records and be prepared to disable or remove the deployment.

The repository configuration is intentionally non-deployable as published and sets `SYNC_ENABLED=false`. Never enable writes until you have replaced every placeholder and completed the staged validation in [docs/operations.md](docs/operations.md).

## What it does

- reads accounts, balances, and booked transactions through Enable Banking;
- creates or updates Lunch Money manual accounts and transactions;
- derives opaque HMAC identifiers for idempotency;
- stores only operational metadata in D1;
- runs manual or scheduled synchronization through a Cloudflare Workflow;
- optionally sends generic, empty-payload Web Push reminders.

It does not initiate payments, delete Lunch Money data, or automatically verify that imported data matches a bank statement.

## Before deployment

You need Node.js 22 or newer and your own Cloudflare, Enable Banking, and Lunch Money accounts. Then:

```sh
npm ci
npm run types:generate
npm run db:migrate:local
npm run check
npm run dev
```

Before any remote command:

1. review the threat model, retention policy, and complete [operations runbook](docs/operations.md);
2. replace every placeholder in `wrangler.jsonc` with resources and contact details that belong to you;
3. keep `SYNC_ENABLED=false` and preview URLs disabled;
4. create all secrets with `wrangler secret put <NAME> --env production`—never commit them;
5. run dry reads against real bank data, then use a separate Lunch Money test budget before considering live writes.

Secret names are listed in [.dev.vars.example](.dev.vars.example). A local `.env.production` may contain `CLOUDFLARE_ACCOUNT_ID`; it is ignored by Git and must remain local.

## Security boundaries

- Administrative routes require the fixed username `operator` and a secret `ADMIN_PASSWORD` of at least 32 characters over HTTPS.
- The public OAuth callback requires a random, short-lived, single-use state.
- Public legal and notification assets contain no credentials or financial payloads.
- Responses include restrictive cache and browser security headers.
- Third-party JSON responses and request bodies handled by the Worker are size-limited.
- Production preview URLs are disabled, and synchronization writes ship disabled.

These controls reduce risk; they do not make the project safe for every deployment. See [docs/threat-model.md](docs/threat-model.md) for assumptions and residual risks.

## Documentation

- [Architecture](docs/architecture.md)
- [Operations and staged validation](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Data retention](docs/data-retention.md)
- [Incident response](docs/incident-response.md)
- [Architecture decisions](docs/adr/README.md)

## License

[MIT](LICENSE)
