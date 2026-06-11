# Deploy to S3 + CloudFront

The site is now a pure static bundle. `build.mjs` pre-renders the two
dynamic GETs (`/manual`, `/api-spec.json`) into static files, and the
API-key application form posts directly to Web3Forms (no backend).

## Production infrastructure

| Resource | Value |
|---|---|
| Public URL | https://test.leadsplease.com/data-api/ |
| S3 bucket | `leadsplease-microsite-data-api` (us-east-1, fully private) — all keys live under `data-api/` |
| CloudFront distribution | `E39WJRUVOH25A4` (shared with `test.leadsplease.com`) |
| Cache behavior | `/data-api/*` → microsite-bucket origin, with the rewrite function (viewer-request) + security-headers policy attached |
| Origin Access Control | `E1V97E5SC70HLP` |
| Response headers policy | `58c1df2f-6294-49cd-ab86-e7092ed7d94d` (HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) |
| CloudFront Function | `leadsplease-microsite-data-api-rewrite` (rewrites `/foo` → `/foo/index.html`) |

**Path prefix.** Because the bucket is mounted under `/data-api/*` on a
shared distribution, the build prefixes every root-relative URL in the
HTML / sitemap / robots with `/data-api`. This happens in `build.mjs`
via the `BASE_PATH` env var (defaulted to `/data-api` in `deploy.ps1`).
Source files stay root-relative — only the build output is prefixed —
so editing index.html / manual.html is unchanged.

**Trailing-slash redirect.** An exact-match cache behavior for
`/data-api` (no trailing slash) is attached to a second CloudFront
Function (`leadsplease-microsite-data-api-redirect`) that returns a
synthetic `301` to `/data-api/`. So both
`https://test.leadsplease.com/data-api` and
`https://test.leadsplease.com/data-api/` work — the former just costs
the user one extra round trip.

## Deploying a new version

**Routine deploys: just push to `test`.** The GitHub Actions workflow
at `.github/workflows/deploy-to-s3.yml` rebuilds and ships on every
push to that branch — same build, same per-path cache headers, same
CloudFront invalidation, from an Ubuntu runner. Watch runs at
https://github.com/Eprintwerx/leadsplease-data-api-microsite/actions.

The workflow needs two repo (or org) secrets to be set at
`…/settings/secrets/actions`:

| Secret | Used for |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM credentials for the runner |
| `AWS_SECRET_ACCESS_KEY` | IAM credentials for the runner |

Minimum IAM permissions: `s3:PutObject`, `s3:DeleteObject`,
`s3:ListBucket` on `leadsplease-microsite-data-api`, plus
`cloudfront:CreateInvalidation` on `E39WJRUVOH25A4`. Reusing the
sibling `leadsplease-static-pages` repo's secrets is fine — that
IAM user has broader access but already works.

The workflow targets a GitHub environment named `test`; create it at
`…/settings/environments` if you want to add protection rules
(required reviewers, wait timer) without editing the workflow.

### Local / manual deploys

`deploy.ps1` is still here for one-off Windows deploys (faster
iteration during dev, no waiting on a CI runner). Run:

```powershell
.\deploy.ps1
```

`deploy.ps1`:

1. Builds `dist/` with `BASE_PATH=/data-api` (set as a default in the
   script; override the env var to deploy at a different prefix or at
   the root).
2. Syncs to `s3://leadsplease-microsite-data-api/data-api/` with
   per-path cache-control headers.
3. Auto-points the AWS CLI at `~/.aws/ca-bundle.pem` so the
   corporate-MITM SSL cert chain validates (see "AWS CLI SSL
   workaround" below).

CloudFront invalidation is **skipped unless** you set
`$env:CLOUDFRONT_DISTRIBUTION_ID = 'E39WJRUVOH25A4'` first. We don't
default to invalidating because the same distribution serves the main
test site, and we don't want to incur invalidation cost on paths it
owns. The invalidation paths are auto-prefixed with `BASE_PATH`, so a
single env-var set is enough.

Because the Google Doc snapshot is taken at build time, **re-running
`deploy.ps1` is how you publish edits to the manual**. (On Railway it
refreshed every 10 min automatically.)

## Outstanding setup

### Web3Forms access key (form handler)

The API-key application form will not work until this is replaced.

1. Go to https://web3forms.com and create a free access key.
2. Set the destination email on their dashboard to `graham@eprintwerx.com`.
3. In `index.html`, replace `REPLACE_WITH_YOUR_WEB3FORMS_ACCESS_KEY`
   with the key. (Search for `WEB3FORMS_ACCESS_KEY` — the constant sits
   at the top of the form's `<script>` block, ~line 1585.)
4. Re-run `pwsh deploy.ps1`.

CC recipient is set via the `NOTIFY_CC_EMAIL` constant on the next
line — currently `info@leadsplease.com`.

## AWS CLI SSL workaround

The AWS CLI on this machine fails with `CERTIFICATE_VERIFY_FAILED`
because the bundled `botocore` CA store is missing the corporate trust
chain. Export the Windows root + intermediate CAs once:

```powershell
$sb = New-Object System.Text.StringBuilder
foreach ($s in 'Root','CA') {
  Get-ChildItem "Cert:\LocalMachine\$s" | ForEach-Object {
    [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
    [void]$sb.AppendLine([Convert]::ToBase64String($_.RawData,'InsertLineBreaks'))
    [void]$sb.AppendLine('-----END CERTIFICATE-----')
  }
}
[IO.File]::WriteAllText("$env:USERPROFILE\.aws\ca-bundle.pem", $sb.ToString())
```

`deploy.ps1` picks this up automatically if the file exists.

## Local development

`node server.js` still works for local dev — it serves the same files
plus the live `/manual` and `/api-spec.json` proxies. Useful for
previewing manual edits without re-deploying.

## Files / dirs

- `build.mjs` — produces `dist/`
- `deploy.ps1` — builds + ships to S3 + invalidates CloudFront
- `dist/` — build output (gitignored)
- `server.js`, `Dockerfile`, `railway.toml` — kept for local dev /
  Railway fallback. Delete once S3 is verified in production.
