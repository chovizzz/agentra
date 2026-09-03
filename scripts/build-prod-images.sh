#!/usr/bin/env bash
#
# Build and push the nine production images to GHCR.
#
# Usage: scripts/build-prod-images.sh [tag]           # default: short HEAD
#        IMAGES="front mcp-server" scripts/…          # a subset
#
# 🔴 Two rules this script exists to enforce, both learned the hard way:
#
#  1. The server is amd64 and the build machine is Apple Silicon, so every image
#     needs an explicit `--platform linux/amd64`. The criterion is the
#     architecture reported by `docker manifest inspect`, NOT the build's exit
#     code — a native-arch build succeeds and then fails at deploy time with
#     `no matching manifest for linux/amd64`, taking every other service with it.
#
#  2. `AGENTRA_TAG` is shared by eight services in docker-compose.prod.yaml.
#     Bumping it while having rebuilt only some of them makes the deploy fail on
#     `No such image` for the rest. So the default is to build ALL of them.
#
set -euo pipefail

REGISTRY=${REGISTRY:-ghcr.io/chovizzz}
TAG=${1:-$(git rev-parse --short=9 HEAD)}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# name:project-folder:rush-package-name
ALL_IMAGES=(
  "stats:pods/stats:@hcengineering/pod-stats"
  "datalake:services/datalake/pod-datalake:@hcengineering/pod-datalake"
  "account:pods/account:@hcengineering/pod-account"
  "workspace:pods/workspace:@hcengineering/pod-workspace"
  "transactor:pods/server:@hcengineering/pod-server"
  "collaborator:pods/collaborator:@hcengineering/pod-collaborator"
  "front:pods/front:@hcengineering/pod-front"
  "github:services/github/pod-github:@hcengineering/pod-github"
  "mcp-server:services/mcp/pod-mcp-server:@hcengineering/pod-mcp-server"
)

selected=()
if [[ -n "${IMAGES:-}" ]]; then
  for want in $IMAGES; do
    for entry in "${ALL_IMAGES[@]}"; do
      [[ "${entry%%:*}" == "$want" ]] && selected+=("$entry")
    done
  done
  [[ ${#selected[@]} -eq 0 ]] && { echo "No image matched IMAGES='$IMAGES'" >&2; exit 1; }
else
  selected=("${ALL_IMAGES[@]}")
fi

rush () { node common/scripts/install-run-rush.js "$@"; }

to_args=()
for entry in "${selected[@]}"; do to_args+=(--to "${entry##*:}"); done

echo "==> tag $TAG, ${#selected[@]} image(s): $(printf '%s ' "${selected[@]%%:*}")"

echo "==> rush build"
rush build "${to_args[@]}"

echo "==> rush bundle"
rush bundle "${to_args[@]}"

# The front image serves dev/prod's webpack output, which `rush bundle` does not
# produce. `rush package` runs webpack, but has been observed to exit 0 while
# webpack failed, so the emitted dist is checked here rather than trusted.
if printf '%s\n' "${selected[@]%%:*}" | grep -qx front; then
  echo "==> webpack (dev/prod) + front package"
  rush package --to @hcengineering/prod --to @hcengineering/pod-front
  for d in dev/prod/dist pods/front/dist; do
    count=$(find "$d" -type f 2>/dev/null | wc -l | tr -d ' ')
    [[ "$count" -lt 10 ]] && { echo "🔴 $d has only $count files — webpack did not run" >&2; exit 1; }
    echo "    $d: $count files"
  done
fi

for entry in "${selected[@]}"; do
  name=${entry%%:*}; rest=${entry#*:}; folder=${rest%%:*}
  echo "==> build+push ${REGISTRY}/agentra-${name}:${TAG}"
  docker buildx build --platform linux/amd64 --push \
    -t "${REGISTRY}/agentra-${name}:${TAG}" "$folder"
done

echo "==> verifying architectures on the registry"
fail=0
for entry in "${selected[@]}"; do
  name=${entry%%:*}
  arch=$(docker manifest inspect "${REGISTRY}/agentra-${name}:${TAG}" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);console.log(m.architecture??(m.manifests??[]).map(x=>x.platform.architecture).join(","))}catch{console.log("?")}})')
  # buildx pushes a provenance/SBOM attestation alongside the image, and its
  # platform is `unknown/unknown`. So the criterion is that amd64 is PRESENT,
  # not that it is the only entry — requiring an exact match reports every
  # correctly-built image as broken.
  if [[ ",$arch," == *",amd64,"* ]]; then
    printf '    %-12s %s ✓\n' "$name" "$arch"
  else
    printf '    %-12s %s 🔴\n' "$name" "$arch"
    fail=1
  fi
done
[[ $fail -eq 0 ]] || { echo "🔴 at least one image is not amd64 — do NOT deploy this tag" >&2; exit 1; }

echo
echo "All ${#selected[@]} image(s) pushed as $TAG."
echo "Set AGENTRA_TAG=$TAG (and MCP_TAG=$TAG) in Dokploy, then redeploy."
