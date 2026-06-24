# email-save Cloudflare Worker

Stores mail sent to `email-save@stf.lol`.

Approved senders only:

- `steven.mirea@gmail.com`
- `me@stefanmirea.com`

The Worker stores the raw `.eml`, headers, parsed text/html bodies, and attachments in R2. D1 stores query metadata and thread hints.

## Thread Tracking

Forwarded Gmail messages do not expose Gmail's internal thread ID over SMTP. This Worker tracks the best available hints:

- `References` or `In-Reply-To` headers when present
- forwarded-message headers parsed from Gmail's forwarded body block
- normalized subject fallback, with `Re:`, `Fwd:`, and `Fw:` stripped

The resulting `thread_key` is queryable with `/emails?threadKey=...`.

## One-Time Cloudflare Setup

R2 must be enabled in the Cloudflare dashboard before bucket creation works:

1. Go to **Storage & databases > R2 > Overview**.
2. Complete the R2 checkout/subscription flow.
3. Keep the bucket on Standard storage to stay inside the free tier.

Then run:

```sh
cd cloudflare-workers/email-save
wrangler r2 bucket create email-save-archive
wrangler secret put READ_TOKEN
wrangler deploy
wrangler email routing enable stf.lol
wrangler email routing rules create stf.lol \
  --name email-save \
  --match-type literal \
  --match-field to \
  --match-value email-save@stf.lol \
  --action-type worker \
  --action-value email-save
```

`wrangler email routing enable stf.lol` replaces the current MX records for the domain with Cloudflare Email Routing records.

## GitHub Actions Setup

The deploy workflow requires these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The API token should have permissions for Workers deploys, D1 migrations, and the R2 bucket binding.

The workflow is manual-only until R2 and `CLOUDFLARE_API_TOKEN` are configured. After that, add a `push` trigger if deploy-on-merge is desired.

## Query API

All endpoints require:

```text
Authorization: Bearer <READ_TOKEN>
```

List recent emails:

```sh
curl -H "Authorization: Bearer $READ_TOKEN" \
  "https://email-save.<workers-subdomain>.workers.dev/emails"
```

List a thread:

```sh
curl -H "Authorization: Bearer $READ_TOKEN" \
  "https://email-save.<workers-subdomain>.workers.dev/emails?threadKey=<thread_key>"
```

Get metadata plus parsed bodies:

```sh
curl -H "Authorization: Bearer $READ_TOKEN" \
  "https://email-save.<workers-subdomain>.workers.dev/emails/<id>?include=text,html"
```

Download the raw email:

```sh
curl -H "Authorization: Bearer $READ_TOKEN" \
  "https://email-save.<workers-subdomain>.workers.dev/emails/<id>/raw"
```
