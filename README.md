# iBox bot

Discord bot for the iBox community server. It runs on GitHub Actions every 5 minutes and:

- keeps a pinned status message in `#status` up to date (iNetbox online or offline, version, response time) and posts a short alert when the state changes;
- posts every new [iBox](https://github.com/atzski/ibox) release in `#releases`;
- posts new apps and app updates from the iNetbox catalog in `#catalog`.

There is no database: the bot reads its previous messages to know what it already posted.

## Setup

1. Repository secret `DISCORD_BOT_TOKEN`: the token from the Bot page of the Discord developer portal.
2. Channel IDs are set in `.github/workflows/bot.yml`.

Run it by hand from the Actions tab (`Run workflow`), or locally:

```
DISCORD_BOT_TOKEN=... STATUS_CHANNEL=... RELEASES_CHANNEL=... CATALOG_CHANNEL=... node bot.mjs
```

Scheduled runs on GitHub can start a few minutes late, so an outage is reported within about 5 to 10 minutes.
