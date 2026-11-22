# Mech Royale submission: bot/provenw.ts as the edge roamer (bot/main-roam.ts, settings bot/params-roam.json), bundled by scripts/build-submission.ts --entry bot/main-roam.ts.
# The match runs it with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, uid 65534, and the map at /arena.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /bot
COPY bot.js /bot/bot.js
ENTRYPOINT ["bun", "/bot/bot.js"]
