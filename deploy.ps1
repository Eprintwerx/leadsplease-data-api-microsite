# Deploy the static microsite to S3 + optionally invalidate CloudFront.
#
# Defaults to the production bucket. CloudFront invalidation is skipped
# unless $env:CLOUDFRONT_DISTRIBUTION_ID is set — the microsite bucket
# is wired into E39WJRUVOH25A4 as an origin but cache behaviors aren't
# yet routing traffic to it, so an invalidation would only churn the
# main test.leadsplease.com site. Set the env var once routing is live.
#
# Run:  pwsh deploy.ps1

$ErrorActionPreference = 'Stop'

if (-not $env:S3_BUCKET) { $env:S3_BUCKET = 'leadsplease-microsite-data-api' }
if (-not $env:BASE_PATH) { $env:BASE_PATH = '/data-api' }

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
$distId = $env:CLOUDFRONT_DISTRIBUTION_ID  # optional
$dist   = Join-Path $PSScriptRoot 'dist'

# BASE_PATH becomes the S3 key prefix. Trim leading/trailing slashes so we can
# splice it back in with consistent slashes below. '' means "upload at root".
$keyPrefix = ($env:BASE_PATH).Trim('/')
$keyDir    = if ($keyPrefix) { "$keyPrefix/" } else { '' }
$invPrefix = if ($keyPrefix) { "/$keyPrefix" } else { '' }

Write-Host "→ Building dist/ via node build.mjs" -ForegroundColor Cyan
# --use-system-ca: api-test.leadsplease.com's TLS chain is missing an
# intermediate that Windows trusts but Node's bundled CA store doesn't.
node --use-system-ca (Join-Path $PSScriptRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'build.mjs failed' }

if (-not (Test-Path $dist)) { throw "dist/ not found at $dist" }

# 1) Long-lived hashed assets — _astro/* — content-hashed filenames so safe
#    to cache forever. Uploaded first so HTML pages always find their CSS.
Write-Host "→ Sync _astro/  (immutable, 1y)  → s3://$bucket/${keyDir}_astro/" -ForegroundColor Cyan
aws s3 sync "$dist\_astro\" "s3://$bucket/${keyDir}_astro/" `
    --cache-control 'public, max-age=31536000, immutable' `
    --delete

# 2) Everything else EXCEPT html, the spec, and _astro — short cache.
Write-Host "→ Sync misc static  (1h)  → s3://$bucket/$keyDir" -ForegroundColor Cyan
aws s3 sync "$dist\" "s3://$bucket/$keyDir" `
    --exclude '*.html' --exclude 'api-spec.json' --exclude '_astro/*' `
    --cache-control 'public, max-age=3600' `
    --delete

# 3) HTML pages — no-cache so a fresh deploy is visible immediately. The
#    `aws s3 cp` calls override the previous sync's choices for these paths.
Write-Host "→ Upload index.html + manual/index.html  (no-cache)" -ForegroundColor Cyan
aws s3 cp "$dist\index.html" "s3://$bucket/${keyDir}index.html" `
    --cache-control 'no-store, no-cache, must-revalidate, max-age=0' `
    --content-type 'text/html; charset=utf-8'
aws s3 cp "$dist\manual\index.html" "s3://$bucket/${keyDir}manual/index.html" `
    --cache-control 'no-store, no-cache, must-revalidate, max-age=0' `
    --content-type 'text/html; charset=utf-8'

# 4) API spec snapshot — 10-min cache, matches the old server-side TTL.
Write-Host "→ Upload api-spec.json  (10m)" -ForegroundColor Cyan
aws s3 cp "$dist\api-spec.json" "s3://$bucket/${keyDir}api-spec.json" `
    --cache-control 'public, max-age=600' `
    --content-type 'application/json; charset=utf-8'

# 5) CloudFront invalidation — only when explicitly opted into via env var,
#    because the host distribution (E39WJRUVOH25A4) also serves the main
#    test site and we don't want to clobber its caches for paths it owns.
if ($distId) {
    Write-Host "→ CloudFront invalidation on $distId" -ForegroundColor Cyan
    aws cloudfront create-invalidation `
        --distribution-id $distId `
        --paths "$invPrefix/" "$invPrefix/index.html" "$invPrefix/manual" "$invPrefix/manual/" "$invPrefix/manual/index.html" "$invPrefix/api-spec.json" "$invPrefix/sitemap.xml" "$invPrefix/robots.txt" "$invPrefix/llms.txt" "$invPrefix/manifest.json" "$invPrefix/og-image.svg" | Out-Null
    Write-Host "`n✓ Deployed to s3://$bucket/$keyDir and invalidated CloudFront $distId" -ForegroundColor Green
} else {
    Write-Host "`n✓ Deployed to s3://$bucket/$keyDir  (CLOUDFRONT_DISTRIBUTION_ID unset — skipped invalidation)" -ForegroundColor Green
}
