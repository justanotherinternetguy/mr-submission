# Mech Royale bot

The "modes" bot: switches between moving (patrols a loop just inside the zone, gathers loot, shoots crates),
combat (dodges, fights or backs off to cover) and combat-move (pre-aims, holds edges), with settings trained by
self-play (run v3long). `bot.js` is one bundled file (strategy, settings, map model, protocol wrapper);
`points.bin` is the trained point-score heat map it reads at startup.

```sh
docker build -t my-bot .
```

Built from hamsters-mech-royale branch Hamster-J-heatmap at bae421c + uncommitted changes (bot/modes.ts, bot/submit-modes.ts, bot/params-modes.json).
