const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
  .setName('unblacklist')
  .setDescription('Remove a user from the blacklist (Owner only)')
  .addUserOption(option =>
    option.setName('utente')
      .setDescription('The user to remove from blacklist')
      .setRequired(true)
  )
  .toJSON(),
  new SlashCommandBuilder()
    .setName('setup-ticket')
    .setDescription('Sends the ticket panel')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setup-recensioni')
    .setDescription('Sends the review panel')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('chiudi')
    .setDescription('Force close a ticket (Owner only)')
    .addUserOption(option =>
      option.setName('utente')
        .setDescription('The user whose ticket to close')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Blacklist or unblacklist a user (Owner only)')
    .addUserOption(option =>
      option.setName('utente')
        .setDescription('The user to blacklist/unblacklist')
        .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commands registered successfully!');
  } catch (error) {
    console.error(error);
  }
})();