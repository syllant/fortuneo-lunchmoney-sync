# Incident response

Objective: revoke all access within ten minutes.

1. set `SYNC_ENABLED=false` and redeploy;
2. terminate active Workflow instances;
3. revoke the Lunch Money token;
4. call `POST /disconnect` when safe, otherwise close the session in Enable Banking;
5. terminate the bank consent in Fortuneo or Enable Banking;
6. replace the RSA key and both HMAC keys;
7. inspect only technical Cloudflare events;
8. review Lunch Money transactions and Fortuneo access;
9. recreate secrets through the interactive Wrangler prompt or dashboard;
10. resume with mocks, a seven-day dry run, and a test budget.

Never paste a secret, banking response, or financial export into a ticket, chat, or log. Rotating `TRANSACTION_HMAC_KEY` changes external IDs: retain the old key for a controlled migration plan, or disable writes until a verified manual reindex is complete.
