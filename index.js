require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const {
  spawn,
} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const ytdlp = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static') || 'ffmpeg';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN. Add it to your .env file.');
  process.exit(1);
}

let youtubeCookiesPath = null;
if (process.env.YOUTUBE_COOKIES_BASE64) {
  const cookies = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64.trim(), 'base64').toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = cookies.split(/\r?\n/, 1)[0];
  if (!['# Netscape HTTP Cookie File', '# HTTP Cookie File'].includes(firstLine)) {
    console.error('YOUTUBE_COOKIES_BASE64 must contain a base64-encoded Netscape cookies.txt file.');
    process.exit(1);
  }
  youtubeCookiesPath = path.join(os.tmpdir(), `elfnan-youtube-cookies-${process.pid}.txt`);
  fs.writeFileSync(youtubeCookiesPath, cookies, { mode: 0o600 });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queues = new Map();
const searchCache = new Map();
const searchInFlight = new Map();
const fastSearchInFlight = new Map();
const trackCache = new Map();

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Live';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function getQueue(guildId) {
  return queues.get(guildId);
}

function leaveVoice(queue) {
  if (queue.connection.state.status !== VoiceConnectionStatus.Destroyed) queue.connection.destroy();
}

function memberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel;
}

async function findTracks(query, limit = 10) {
  try {
    const tracks = await searchYouTubePage(query, limit, 2_000);
    if (tracks.length) return tracks;
  } catch {
    // Fall back to yt-dlp if YouTube's search page is unavailable.
  }
  const results = await ytdlp(`ytsearch${limit}:${query}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    skipDownload: true,
    socketTimeout: 12,
    ...(youtubeCookiesPath ? { cookies: youtubeCookiesPath } : {}),
  });
  return (results.entries ?? []).map(normalizeTrack).filter(track => track.url && track.title);
}

function parseDuration(text) {
  if (!text) return undefined;
  const parts = text.split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function extractInitialData(html) {
  const marker = 'var ytInitialData = ';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) throw new Error('YouTube search page did not include results.');
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start === -1) throw new Error('YouTube search data was malformed.');

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new Error('YouTube search data was incomplete.');
}

async function searchYouTubePage(query, limit, timeoutMs = 2_000) {
  const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`YouTube search returned HTTP ${response.status}.`);
  const data = extractInitialData(await response.text());
  const tracks = [];
  const visit = value => {
    if (!value || typeof value !== 'object' || tracks.length >= limit) return;
    if (value.videoRenderer?.videoId) {
      const video = value.videoRenderer;
      const title = video.title?.runs?.map(run => run.text).join('') || video.title?.simpleText;
      const channel = video.ownerText?.runs?.map(run => run.text).join('')
        || video.shortBylineText?.runs?.map(run => run.text).join('')
        || 'YouTube';
      const thumbnail = video.thumbnail?.thumbnails?.at(-1)?.url;
      if (title) tracks.push({
        title,
        url: `https://www.youtube.com/watch?v=${video.videoId}`,
        durationInSec: parseDuration(video.lengthText?.simpleText),
        channel: { name: channel },
        thumbnails: thumbnail ? [{ url: thumbnail }] : [],
      });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(data);
  return tracks;
}

function saveSearch(query, tracks) {
  const key = query.toLocaleLowerCase();
  searchCache.set(key, { tracks, savedAt: Date.now() });
  for (const track of tracks) trackCache.set(track.url, { track, savedAt: Date.now() });
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
  if (trackCache.size > 500) trackCache.delete(trackCache.keys().next().value);
}

function fastSearch(query) {
  const key = query.toLocaleLowerCase();
  if (fastSearchInFlight.has(key)) return fastSearchInFlight.get(key);
  const search = searchYouTubePage(query, 10, 1_800)
    .then(tracks => {
      if (tracks.length) saveSearch(query, tracks);
      return tracks;
    })
    .catch(() => [])
    .finally(() => fastSearchInFlight.delete(key));
  fastSearchInFlight.set(key, search);
  return search;
}

function warmSearch(query) {
  const key = query.toLocaleLowerCase();
  if (searchInFlight.has(key)) return searchInFlight.get(key);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.savedAt < 5 * 60_000) return Promise.resolve(cached.tracks);

  const search = findTracks(query, 10)
    .then(tracks => {
      saveSearch(query, tracks);
      return tracks;
    })
    .catch(error => {
      console.error('Song search failed:', error.message);
      return [];
    })
    .finally(() => searchInFlight.delete(key));
  searchInFlight.set(key, search);
  return search;
}

function normalizeTrack(track) {
  const url = track.webpage_url
    || (track.id ? `https://www.youtube.com/watch?v=${track.id}` : track.url);
  return {
    title: track.title,
    url,
    durationInSec: track.duration,
    channel: { name: track.channel || track.uploader || 'YouTube' },
    thumbnails: track.thumbnails || (track.thumbnail ? [{ url: track.thumbnail }] : []),
  };
}

function createTrackStream(url, onExtractorError) {
  const extractorArgs = [
    '--quiet', '--no-warnings', '--no-playlist', '--format', 'bestaudio',
    '--output', '-', '--socket-timeout', '15',
  ];
  if (youtubeCookiesPath) extractorArgs.push('--cookies', youtubeCookiesPath);
  extractorArgs.push('--', url);
  const extractor = spawn(ytdlp.constants.YOUTUBE_DL_PATH, extractorArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const transcoder = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-vn',
    '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let extractorError = '';
  let ffmpegError = '';
  extractor.stderr.setEncoding('utf8').on('data', chunk => { extractorError = (extractorError + chunk).slice(-2000); });
  transcoder.stderr.setEncoding('utf8').on('data', chunk => { ffmpegError = (ffmpegError + chunk).slice(-2000); });
  extractor.stdout.on('error', error => {
    if (error.code !== 'EPIPE') console.error('yt-dlp stream error:', error.message);
  });
  transcoder.stdin.on('error', error => {
    if (error.code !== 'EPIPE') console.error('FFmpeg input error:', error.message);
  });
  extractor.stdout.pipe(transcoder.stdin);
  extractor.on('error', error => console.error('yt-dlp process error:', error.message));
  transcoder.on('error', error => console.error('FFmpeg process error:', error.message));
  extractor.on('close', code => {
    if (code && code !== 0) {
      const details = extractorError.trim();
      console.error('yt-dlp could not read the audio:', details);
      onExtractorError?.(details);
    }
  });
  transcoder.on('close', code => {
    if (code && code !== 0) console.error('FFmpeg could not transcode the audio:', ffmpegError.trim());
  });
  return { stream: transcoder.stdout, processes: [extractor, transcoder] };
}

function stopTrackProcesses(queue) {
  for (const process of queue.processes ?? []) {
    if (!process.killed && process.exitCode === null) process.kill('SIGKILL');
  }
  queue.processes = [];
}

function playerButtons(queue) {
  if (!queue.current) return [];
  const paused = queue.player.state.status === AudioPlayerStatus.Paused;
  const likeButton = new ButtonBuilder()
    .setCustomId('music:like')
    .setEmoji('❤️')
    .setStyle(ButtonStyle.Secondary);
  if (queue.likes.size) likeButton.setLabel(String(queue.likes.size));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:previous').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:pause').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    likeButton,
    new ButtonBuilder().setCustomId('music:stop').setEmoji('⏹️').setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

function playerEmbed(queue) {
  const track = queue.current;
  if (!track) {
    return new EmbedBuilder()
      .setColor(0x555b66)
      .setTitle(queue.stopped ? 'Playback stopped' : 'Queue finished')
      .setDescription(queue.stopped ? 'Use `/play` to start another song.' : 'Use `/play` to add another song.');
  }

  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .addFields(
      { name: 'Author', value: track.channel?.name || 'YouTube', inline: false },
      { name: 'Duration', value: formatDuration(track.durationInSec), inline: false },
      { name: 'Requester', value: track.requesterId ? `<@${track.requesterId}>` : (track.requester || 'Autoplay'), inline: false },
    );
  if (track.thumbnails?.[0]?.url) embed.setThumbnail(track.thumbnails[track.thumbnails.length - 1].url);
  if (queue.autoplay) embed.setFooter({ text: 'Autoplay is on' });
  return embed;
}

async function updatePlayerPanel(queue) {
  if (queue.panelMessage) {
    try {
      await queue.panelMessage.edit({ embeds: [playerEmbed(queue)], components: playerButtons(queue) });
      return;
    } catch {
      queue.panelMessage = null;
    }
  }
  if (!queue.textChannel) return;
  queue.panelMessage = await queue.textChannel.send({ embeds: [playerEmbed(queue)], components: playerButtons(queue) }).catch(() => null);
}

async function prefetchAutoplay(queue, track) {
  if (!queue.autoplay || !track?.channel?.name) return;
  const artist = track.channel.name;
  queue.autoplayArtist = artist;
  const related = await warmSearch(`${artist} official songs`);
  if (!queue.autoplay || queue.autoplayArtist !== artist) return;
  const used = new Set(queue.history.slice(-3).map(item => item.url));
  if (queue.current) used.add(queue.current.url);
  queue.autoplayTracks = related.filter(item => item.url !== track.url && !used.has(item.url));
}

async function startNext(guildId) {
  const queue = getQueue(guildId);
  if (!queue) return;

  let track = queue.tracks.shift();
  if (!track && queue.autoplay && queue.current) {
    const endedTrack = queue.current;
    queue.current = null;
    if (!queue.autoplayTracks.length || queue.autoplayArtist !== endedTrack.channel?.name) {
      await prefetchAutoplay(queue, endedTrack);
    }
    track = queue.autoplayTracks.shift();
    if (track) {
      track = { ...track, requester: 'Autoplay', requesterId: null };
      queue.textChannel?.send(`Autoplay picked another song by **${track.channel.name}**.`).catch(() => {});
    }
  }
  if (!track) {
    queue.current = null;
    queue.likes.clear();
    await updatePlayerPanel(queue);
    if (!queue.stopped) {
      clearTimeout(queue.leaveTimer);
      queue.leaveTimer = setTimeout(() => {
        if (!queue.current && queue.tracks.length === 0 && queues.get(guildId) === queue) {
          leaveVoice(queue);
          queues.delete(guildId);
        }
      }, 60_000).unref();
    }
    return;
  }

  clearTimeout(queue.leaveTimer);
  queue.stopped = false;
  queue.current = track;
  queue.likes.clear();
  queue.history.push(track);
  queue.history = queue.history.slice(-10);
  if (queue.autoplay && queue.autoplayArtist !== track.channel?.name) void prefetchAutoplay(queue, track);
  try {
    const stream = createTrackStream(track.url, details => {
      const message = /sign in to confirm.*not a bot/i.test(details)
        ? 'YouTube is blocking Railway’s server IP. Add a fresh `YOUTUBE_COOKIES_BASE64` variable in Railway, redeploy, and try again.'
        : `The audio source failed. Check the Railway logs for details: ${details.slice(0, 300)}`;
      queue.textChannel?.send(message).catch(() => {});
    });
    queue.processes = stream.processes;
    const resource = createAudioResource(stream.stream, {
      inputType: StreamType.OggOpus,
      metadata: track,
    });
    queue.player.play(resource);
    await updatePlayerPanel(queue);
  } catch (error) {
    console.error(`Could not stream ${track.url}:`, error.message);
    queue.textChannel.send(`I couldn’t play **${track.title}**. Skipping to the next song.`).catch(() => {});
    await startNext(guildId);
  }
}

function createQueue(interaction, voiceChannel) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  const queue = {
    tracks: [],
    history: [],
    likes: new Set(),
    autoplay: false,
    autoplayArtist: null,
    autoplayTracks: [],
    current: null,
    panelMessage: null,
    stopped: false,
    player,
    connection,
    ready: null,
    textChannel: interaction.channel,
    starting: false,
  };
  queues.set(interaction.guildId, queue);
  connection.subscribe(player);
  queue.ready = entersState(connection, VoiceConnectionStatus.Ready, 20_000)
    .then(() => true)
    .catch(() => false);
  connection.on(VoiceConnectionStatus.Destroyed, () => queues.delete(interaction.guildId));
  connection.on('error', error => console.error('Voice connection error:', error));
  player.on(AudioPlayerStatus.Idle, () => {
    stopTrackProcesses(queue);
    void startNext(interaction.guildId);
  });
  player.on('error', error => {
    console.error('Audio player error:', error.message);
    void startNext(interaction.guildId);
  });
  return queue;
}

async function handleAutocomplete(interaction) {
  const query = interaction.options.getFocused().trim();
  if (!query) return interaction.respond([]);
  const key = query.toLocaleLowerCase();
  for (const [cachedQuery, cached] of searchCache) {
    if (Date.now() - cached.savedAt > 5 * 60_000) searchCache.delete(cachedQuery);
  }
  let exact = searchCache.get(key)?.tracks;
  if (!exact && query.length >= 2) {
    exact = await fastSearch(query);
    if (!exact.length) void warmSearch(query);
  }
  const related = exact?.length ? exact : [...searchCache.values()]
    .flatMap(cached => cached.tracks)
    .filter(track => `${track.title} ${track.channel.name}`.toLocaleLowerCase().includes(key));
  const choices = related.slice(0, 24).map(track => ({
    name: `${track.title} — ${track.channel.name}`.slice(0, 100),
    value: track.url.slice(0, 100),
  }));
  if (choices.length === 0) {
    choices.push({ name: `Search YouTube for “${query}”`.slice(0, 100), value: query.slice(0, 100) });
  }
  return interaction.respond(choices);
}

async function handlePlay(interaction) {
  const voiceChannel = memberVoiceChannel(interaction);
  if (!voiceChannel) {
    return interaction.reply({ content: 'Join a voice channel first, then use `/play`.', flags: MessageFlags.Ephemeral });
  }

  const existing = getQueue(interaction.guildId);
  if (existing && existing.connection.joinConfig.channelId !== voiceChannel.id) {
    return interaction.reply({ content: 'Join my voice channel to add songs to this queue.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  const input = interaction.options.getString('song', true).trim();
  let queue = getQueue(interaction.guildId);
  let createdQueue = false;
  if (!queue) {
    queue = createQueue(interaction, voiceChannel);
    createdQueue = true;
    await interaction.editReply('Joining your voice channel and loading the song…');
  }
  const connectionReady = queue.ready ?? Promise.resolve(true);

  try {
    let track;
    if (/^https?:\/\//i.test(input)) {
      const cached = trackCache.get(input);
      if (cached && Date.now() - cached.savedAt < 5 * 60_000) {
        track = cached.track;
      } else {
        const info = await ytdlp(input, {
          dumpSingleJson: true,
          noWarnings: true,
          skipDownload: true,
          noPlaylist: true,
          ...(youtubeCookiesPath ? { cookies: youtubeCookiesPath } : {}),
        });
        track = normalizeTrack(info);
      }
    } else {
      const key = input.toLocaleLowerCase();
      const cached = searchCache.get(key);
      const tracks = cached && Date.now() - cached.savedAt < 5 * 60_000
        ? cached.tracks
        : await (fastSearchInFlight.get(key) || searchInFlight.get(key) || warmSearch(input));
      track = tracks[0];
    }
    if (!track?.url) {
      if (createdQueue && !queue.current && queue.tracks.length === 0 && queues.get(interaction.guildId) === queue) {
        leaveVoice(queue);
        queues.delete(interaction.guildId);
      }
      return interaction.editReply('I couldn’t find that song. Try another search or a YouTube URL.');
    }

    if (!await connectionReady) {
      if (!queue.current && queue.tracks.length === 0) {
        leaveVoice(queue);
        queues.delete(interaction.guildId);
      }
      return interaction.editReply('I couldn’t connect to your voice channel. Check that I have permission to Connect and Speak.');
    }

    track = {
      ...track,
      requester: interaction.member?.displayName || interaction.user.username,
      requesterId: interaction.user.id,
    };
    queue.textChannel = interaction.channel;
    queue.tracks.push(track);
    if (!queue.current && !queue.starting) {
      queue.starting = true;
      void startNext(interaction.guildId).finally(() => { queue.starting = false; });
    }
    const position = queue.tracks.length + (queue.current ? 1 : 0);
    return interaction.editReply(queue.current === track
      ? `Starting **${track.title}**.`
      : `Added **${track.title}** to the queue${position > 1 ? ` at position ${position}` : ''}.`);
  } catch (error) {
    console.error('Could not add song:', error.message);
    if (createdQueue && !queue.current && queue.tracks.length === 0 && queues.get(interaction.guildId) === queue) {
      leaveVoice(queue);
      queues.delete(interaction.guildId);
    }
    return interaction.editReply('I couldn’t load that song. Try a different search or URL.');
  }
}

async function stopPlayback(queue) {
  clearTimeout(queue.leaveTimer);
  queue.tracks.length = 0;
  queue.autoplay = false;
  queue.autoplayTracks = [];
  queue.stopped = true;
  queue.likes.clear();
  stopTrackProcesses(queue);
  queue.player.stop(true);
  queue.current = null;
  await updatePlayerPanel(queue);
}

async function handleCommand(interaction) {
  if (interaction.commandName === 'play') return handlePlay(interaction);

  const queue = getQueue(interaction.guildId);
  const voiceChannel = memberVoiceChannel(interaction);
  if (!queue || !voiceChannel || queue.connection.joinConfig.channelId !== voiceChannel.id) {
    return interaction.reply({ content: 'Join my voice channel first to control playback.', flags: MessageFlags.Ephemeral });
  }

  switch (interaction.commandName) {
    case 'skip':
      if (!queue.current) return interaction.reply('There isn’t a song playing right now.');
      stopTrackProcesses(queue);
      queue.player.stop(true);
      return interaction.reply('Skipped the current song.');
    case 'stop':
      await stopPlayback(queue);
      return interaction.reply('Playback stopped and the queue was cleared. I’m staying in voice.');
    case 'leave':
      await stopPlayback(queue);
      leaveVoice(queue);
      queues.delete(interaction.guildId);
      return interaction.reply('I left the voice channel.');
    case 'autoplay': {
      queue.autoplay = !queue.autoplay;
      queue.autoplayTracks = [];
      const artistTrack = queue.current || queue.tracks[0];
      if (queue.autoplay && artistTrack) void prefetchAutoplay(queue, artistTrack);
      await updatePlayerPanel(queue);
      return interaction.reply(queue.autoplay
        ? `Autoplay is on${artistTrack ? ` for **${artistTrack.channel?.name || 'this artist'}**` : ' and will use the next song’s artist'}.`
        : 'Autoplay is off.');
    }
    default:
      return undefined;
  }
}

async function handleButton(interaction) {
  const queue = getQueue(interaction.guildId);
  const voiceChannel = memberVoiceChannel(interaction);
  if (!queue || !voiceChannel || queue.connection.joinConfig.channelId !== voiceChannel.id) {
    return interaction.reply({ content: 'Join my voice channel to use these controls.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  queue.panelMessage = interaction.message;
  switch (interaction.customId) {
    case 'music:previous':
      if (!queue.current) return;
      queue.tracks.unshift(queue.current);
      stopTrackProcesses(queue);
      queue.player.stop(true);
      return;
    case 'music:pause':
      if (queue.player.state.status === AudioPlayerStatus.Paused) queue.player.unpause();
      else queue.player.pause();
      return updatePlayerPanel(queue);
    case 'music:skip':
      if (!queue.current) return updatePlayerPanel(queue);
      stopTrackProcesses(queue);
      queue.player.stop(true);
      return;
    case 'music:like':
      if (queue.likes.has(interaction.user.id)) queue.likes.delete(interaction.user.id);
      else queue.likes.add(interaction.user.id);
      return updatePlayerPanel(queue);
    case 'music:stop':
      return stopPlayback(queue);
    default:
      return undefined;
  }
}

client.once('clientReady', readyClient => console.log(`Ready as ${readyClient.user.tag}`));
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (error) {
    console.error('Interaction failed:', error);
    const response = { content: 'Something went wrong while handling that command.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});

client.login(token).catch(error => {
  console.error('Could not log in to Discord:', error.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  for (const queue of queues.values()) leaveVoice(queue);
  client.destroy();
  process.exit(0);
});
