# Elfnan Music Bot

A Discord music bot with YouTube search autocomplete, a per-server song queue, and basic playback controls.

## Requirements

- Node.js 22.12 or newer
- Python 3.9 or newer available as `python3` (used by the yt-dlp wrapper)
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
