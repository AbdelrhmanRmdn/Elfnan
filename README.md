# Elfnan Music Bot

A Discord music bot with YouTube search autocomplete, a per-server song queue, and basic playback controls.

## Requirements

- Node.js 22.12 or newer
- Python 3.11 or newer available as `python3` (used by the yt-dlp wrapper)
- A Discord application and bot created in the [Discord Developer Portal](https://discord.com/developers/applications)
- The bot invited with the `bot` and `applications.commands` scopes and permission to View Channels, Send Messages, Connect, and Speak

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
   - `GUILD_ID` makes commands appear quickly in a test server. Leave it out to register commands globally.
   - For compatibility with the existing local `.env`, `CLIENT_TOKEN` can be used for `CLIENT_ID`, and `GUILD_TOKEN` for `GUILD_ID`.
3. Register slash commands with `npm run deploy`.
4. Start the bot with `npm start`.

## Commands

- `/play song:<search or URL>` — search YouTube using Discord autocomplete or play a YouTube URL.
- `/stop` — stop playback and clear the queue while staying in voice.
- `/leave` — stop playback and disconnect from voice.
- `/skip` — skip the current song.
- `/autoplay` — toggle more songs from the current artist.

The now-playing panel has buttons for previous, pause/resume, skip, likes, and stop. Search results are shown as autocomplete choices as you type.

Queues are kept in memory, so they reset if the bot process restarts. YouTube search and playback use `yt-dlp` with FFmpeg for audio streaming.

## Railway YouTube cookies

Some cloud server IPs are blocked by YouTube with a “Sign in to confirm you’re not a bot” message. If that happens, export a Netscape-format YouTube cookies file, encode it as base64, and set it in Railway as `YOUTUBE_COOKIES_BASE64`. The bot writes the secret to a private temporary file at startup and passes it to yt-dlp. Never commit the cookies file, put the value in GitHub, or send it in chat; it can grant access to the signed-in account. Use a separate account if you choose to use cookies, since yt-dlp’s documentation warns that account use can carry a ban risk.

To encode a local cookies file, run `node -e "process.stdout.write(require('fs').readFileSync('/path/to/cookies.txt').toString('base64'))"` in a terminal, then paste that output only into Railway’s Variables page. Treat the encoded output as a secret too. Redeploy after setting the variable. YouTube can rotate cookies and may bind verification to an IP, so this method is not guaranteed to work from a cloud host.
