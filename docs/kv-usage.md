# KV usage and statistics cache

Updated 2026-10-21 (Asia/Singapore).

Mailbox statistics are derived from D1. When `analysis_cache` is enabled, they
are cached for 15 minutes in a bounded process cache (32 time zones) and the
Cloudflare Cache API. Statistics no longer create KV keys, enumerate historical
statistics keys, or rewrite those keys from the daily scheduled job. Old KV
statistics are deliberately left untouched; no mail or attachment data is removed.
Invalid time zones fall back to UTC. A cache outage falls back to the D1 query.

The dashboard's daily sent-recipient total is calculated from the existing D1
provider-accepted sent-message records for the current UTC day, including
soft-deleted messages. Saving and failed records are excluded; later delivery
events do not erase a previously accepted send from the total.
Sending no longer writes a redundant KV statistics counter after delivery. This
avoids reporting an already sent message as failed when KV writes are exhausted.
The user's real sending allowance still uses the existing D1 accounting rules.

Necessary durable operations still use KV:

- Successful login and logout update the user's permitted session list.
- Active sessions receive a daily TTL renewal (coalesced within each running
  Worker process; separate Cloudflare locations may still renew separately).
- Settings changes and public API token rotation update their records.
- Without configured R2 or S3 storage, each new attachment uses KV object storage.

Login gates on other websites do not remove these mailbox writes. Do not disable
session persistence to save quota, or silently drop incoming attachments. Review
actual per-namespace account usage before changing their storage backend.

Daily session TTL renewal coalesces concurrent requests per process and backs off
for 60 seconds after a failed optional renewal. A failed renewal does not reject
an otherwise valid session. JWT verification and the current KV token list are
still checked on every protected request. New login/logout token-list writes
remain mandatory; quota errors cannot silently turn them into successful changes.
The coalescing map is bounded to 256 users and does not contain cached
authorization decisions. New logins already mark their session as renewed today.

Run the isolated, non-deploying regression tests with:

```powershell
node --test mail-worker/test/*.test.mjs
```

`mail-worker`'s existing `npm test` script deploys a test Worker; it is not this
test command.
