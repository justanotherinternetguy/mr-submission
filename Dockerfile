# Mech Royale submission (two brains). Built by scripts/build-hybrid.ts; do not edit the built copy.
# The match runs it with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, uid 65534, at most 128
# processes, and the map at /arena.

# Stage 1: the Go bot in giddy/, built with the image and flags of giddy/Dockerfile (upstream's own build).
FROM golang:1.26.1-bookworm@sha256:ab3d6955bbc813a0f3fdf220c1d817dd89c0b3f283777db8ece4a32fe7858edd AS giddy
WORKDIR /src
COPY giddy/go.mod ./
COPY giddy/mech ./mech
COPY giddy/cmd/bot ./cmd/bot
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /mechbot ./cmd/bot

# Stage 2: the image that runs. scripts/build-hybrid.ts pins this base by digest, as scripts/build-submission.ts does.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /bot
COPY --from=giddy /mechbot /bot/giddy
COPY main.js /bot/main.js
# Our own bot only watches until a free-for-all is detected. With JavaScriptCore's third compiler tier (FTL) on, its
# compile bursts on helper threads use up the 1-CPU allowance in the middle of a match and freeze the container,
# the Go child included (measured: notes/lab/hybrid-log.md). The first two tiers stay on.
ENV BUN_JSC_useFTLJIT=0
ENTRYPOINT ["bun", "/bot/main.js"]
