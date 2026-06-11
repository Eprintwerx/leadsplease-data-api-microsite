# Deploy the static microsite to S3 + invalidate CloudFront.
#
# Defaults to the production bucket + distribution; override with env vars
# to ship elsewhere (e.g. a staging bucket).
#
# Run:  pwsh deploy.ps1

$ErrorActionPreference = 'Stop'

if (-not $env:S3_BUCKET)                 { $env:S3_BUCKET = 'leadsplease-microsite-data-api' }
if (-not $env:CLOUDFRONT_DISTRIBUTION_ID) { $env:CLOUDFRONT_DISTRIBUTION_ID = 'E2TW90C7MFXMO4' }

# AWS CLI on this machine can't validate AWS TLS certs against its bundled
# CA store. Point it at a PEM of the Windows root store. Regenerate with:
#   $sb = New-Object System.Text.StringBuilder
#   foreach ($s in 'Root','CA') { Get-ChildItem "Cert:\LocalMachine\$s" | % {
#     [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
#     [void]$sb.AppendLine([Convert]::ToBase64String($_.RawData,'InsertLineBreaks'))
#     [void]$sb.AppendLine('-----END CERTIFICATE-----') } }
#   [IO.File]::WriteAllText("$env:USERPROFILE\.aws\ca-bundle.pem", $sb.ToString())
$caBundle = Join-Path $env:USERPROFILE '.aws\ca-bundle.pem'
if (-not $env:AWS_CA_BUNDLE -and (Test-Path $caBundle)) { $env:AWS_CA_BUNDLE = $caBundle }

$bucket = $env:S3_BUCKET
$distId = $env:CLOUDFRONT_DISTRIBUTION_ID
$dist   = Join-Path $PSScriptRoot 'dist'

Write-Host "→ Building dist/ via node build.mjs" -ForegroundColor Cyan
# --use-system-ca: api-test.leadsplease.com's TLS chain is missing an
# intermediate that Windows trusts but Node's bundled CA store doesn't.
node --use-system-ca (Join-Path $PSScriptRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'build.mjs failed' }

if (-not (Test-Path $dist)) { throw "dist/ not found at $dist" }

# 1) Long-lived hashed assets — _astro/* — content-hashed filenames so safe
#    to cache forever. Uploaded first so HTML pages always find their CSS.
Write-Host "→ Sync _astro/  (immutable, 1y)" -ForegroundColor Cyan
aws s3 sync "$dist\_astro\" "s3://$bucket/_astro/" `
    --cache-control 'public, max-age=31536000, immutable' `
    --delete

# 2) Everything else EXCEPT html, the spec, and _astro — short cache.
Write-Host "→ Sync misc static  (1h)" -ForegroundColor Cyan
aws s3 sync "$dist\" "s3://$bucket/" `
    --exclude '*.html' --exclude 'api-spec.json' --exclude '_astro/*' `
    --cache-control 'public, max-age=3600' `
    --delete

# 3) HTML pages — no-cache so a fresh deploy is visible immediately. The
#    `aws s3 cp` calls override the previous sync's choices for these paths.
Write-Host "→ Upload index.html + manual/index.html  (no-cache)" -ForegroundColor Cyan
aws s3 cp "$dist\index.html" "s3://$bucket/index.html" `
    --cache-control 'no-store, no-cache, must-revalidate, max-age=0' `
    --content-type 'text/html; charset=utf-8'
aws s3 cp "$dist\manual\index.html" "s3://$bucket/manual/index.html" `
    --cache-control 'no-store, no-cache, must-revalidate, max-age=0' `
    --content-type 'text/html; charset=utf-8'

# 4) API spec snapshot — 10-min cache, matches the old server-side TTL.
Write-Host "→ Upload api-spec.json  (10m)" -ForegroundColor Cyan
aws s3 cp "$dist\api-spec.json" "s3://$bucket/api-spec.json" `
    --cache-control 'public, max-age=600' `
    --content-type 'application/json; charset=utf-8'

# 5) CloudFront invalidation — wipe edge caches for the paths that just
#    changed. _astro/* is content-hashed so doesn't need invalidating.
Write-Host "→ CloudFront invalidation" -ForegroundColor Cyan
aws cloudfront create-invalidation `
    --distribution-id $distId `
    --paths '/' '/index.html' '/manual' '/manual/' '/manual/index.html' '/api-spec.json' '/sitemap.xml' '/robots.txt' '/llms.txt' '/manifest.json' '/og-image.svg' | Out-Null

Write-Host "`n✓ Deployed to s3://$bucket and invalidated CloudFront $distId" -ForegroundColor Green
