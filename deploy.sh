#!/bin/bash
# Deploy the Balls Golf frontend (static site) to S3 + CloudFront.
# Bucket + distribution are provisioned by the drawvidverse CDK stack
# (balls.drawvid.com). Usage: ./deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="balls-drawvid-frontend-${ACCOUNT}"

echo "==> Target bucket: s3://${BUCKET}"

# App assets (models, textures, faces) change between releases and their
# filenames are NOT content-hashed, so serve them with revalidation instead of
# immutable: browsers (and CloudFront) re-check via ETag and get a cheap 304 when
# the file is unchanged, or fresh bytes automatically when it changes — no manual
# ?v= cache-busting needed.
echo "==> Syncing assets (no-cache, ETag-revalidated)"
aws s3 sync assets "s3://${BUCKET}/assets" --delete --cache-control "no-cache"

# Vendored Babylon lib is large and effectively never changes: cache hard for a year.
echo "==> Syncing babylon (immutable, 1y)"
aws s3 sync babylon "s3://${BUCKET}/babylon" --delete --cache-control "public,max-age=31536000,immutable"

# App code has no content hash in its filenames, so keep it short and rely on the
# CloudFront invalidation below to push a release live.
echo "==> Syncing app code (src/, short cache)"
aws s3 sync src "s3://${BUCKET}/src" --delete --cache-control "public,max-age=60"

echo "==> Uploading HTML entry points (no-cache) + favicon"
for f in index.html game.html locker.html; do
  aws s3 cp "$f" "s3://${BUCKET}/$f" --cache-control "no-cache"
done
aws s3 cp favicon.ico "s3://${BUCKET}/favicon.ico" --cache-control "public,max-age=86400"

# Discover the distribution by its alias so no id needs hardcoding.
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, 'balls.drawvid.com')].Id | [0]" \
  --output text)
if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  echo "==> Invalidating CloudFront ${DIST_ID}"
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' >/dev/null
else
  echo "!! No CloudFront distribution for balls.drawvid.com found — run the CDK deploy first."
fi

echo "==> Done: https://balls.drawvid.com"
