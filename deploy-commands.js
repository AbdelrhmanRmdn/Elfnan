require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search for a song or play a URL')
    .addStringOption(option => option
      .setName('song')
      .setDescription('Song name or YouTube URL')
      .setRequired(true)
      .setAutocomplete(true)),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop playback and leave the voice channel'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle autoplay for the current artist'),
].map(command => command.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID || process.env.CLIENT_TOKEN;
const guildId = process.env.GUILD_ID || process.env.GUILD_TOKEN;

if (!token || !clientId) {
  console.error('Set DISCORD_TOKEN and CLIENT_ID in .env before deploying commands.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
async function deploy() {
  if (guildId) {
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Cleared global duplicates and registered ${commands.length} commands for the test server.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Registered ${commands.length} slash commands globally.`);
  }
}

deploy().catch(error => {
    console.error('Could not register slash commands:', error.message);
    process.exitCode = 1;
  });
