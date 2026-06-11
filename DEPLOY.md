# Deploy to S3 + CloudFront

The site is now a pure static bundle. `build.mjs` pre-renders the two
dynamic GETs (`/manual`, `/api-spec.json`) into static files, and the
API-key application form posts directly to Web3Forms (no backend).

## Production infrastructure

| Resource | Value |
|---|---|
| S3 bucket | `leadsplease-microsite-data-api` (us-east-1, fully private) |
| CloudFront distribution | `E2TW90C7MFXMO4` |
| CloudFront URL | https://d188ipv2jb3hz0.cloudfront.net |
| Origin Access Control | `E1V97E5SC70HLP` |
| Response headers policy | `58c1df2f-6294-49cd-ab86-e7092ed7d94d` (HSTS, nosniff, Referrer-Policy, Permissions-Policy) |
| CloudFront Function | `leadsplease-microsite-data-api-rewrite` (viewer-request — `/foo` → `/foo/index.html`) |

There is currently **no custom domain attached** — the site serves only
at the `d188ipv2jb3hz0.cloudfront.net` URL above. To wire up a custom
domain later, see "Adding a custom domain" below.

## Deploying a new version

```powershell
pwsh deploy.ps1
```

That's it. `deploy.ps1` has defaults for `S3_BUCKET` and
`CLOUDFRONT_DISTRIBUTION_ID` baked in, and auto-points the AWS CLI at
`~/.aws/ca-bundle.pem` so the corporate-MITM SSL cert chain validates
(see "AWS CLI SSL workaround" below).

It runs `build.mjs`, syncs `dist/` to S3 with per-path cache-control
headers, and creates a CloudFront invalidation for the paths that
change between deploys (HTML, spec, sitemap, etc.). The content-hashed
`_astro/*.css` files don't need invalidation.

Override the target via env vars to deploy to a different
bucket/distribution (e.g. a staging copy).

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

## Adding a custom domain

1. **ACM cert** — in `us-east-1` (CloudFront only consumes certs from
   that region):
   ```powershell
   aws acm request-certificate --domain-name developers.leadsplease.com `
       --validation-method DNS --region us-east-1
   ```
   Add the returned `CNAME` validation record at your DNS provider, wait
   for the cert to reach `ISSUED`.

2. **Attach to the distribution** — edit `E2TW90C7MFXMO4`'s config:
   add the domain to `Aliases.Items` and set `ViewerCertificate` to
   `{ACMCertificateArn, SSLSupportMethod:"sni-only", MinimumProtocolVersion:"TLSv1.2_2021"}`.

3. **DNS** — point `developers.leadsplease.com` at
   `d188ipv2jb3hz0.cloudfront.net` (CNAME, or ALIAS if your DNS is
   Route 53).

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
