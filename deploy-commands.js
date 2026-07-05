// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

require('dotenv').config({ quiet: true });
const { REST, Routes, SlashCommandBuilder, InteractionContextType } = require('discord.js');

const SCHOOL_NAME_MIN_LENGTH = 2;
const SCHOOL_NAME_MAX_LENGTH = 50;
const COMMAND_CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM];

const commands = [
  new SlashCommandBuilder()
    .setName('학교설정')
    .setDescription('자신의 학교를 검색하고 등록합니다.')
    .setContexts(COMMAND_CONTEXTS)
    .addStringOption(option =>
      option.setName('이름')
        .setDescription('검색할 학교의 이름을 입력하세요 (예: OO고등학교)')
        .setMinLength(SCHOOL_NAME_MIN_LENGTH)
        .setMaxLength(SCHOOL_NAME_MAX_LENGTH)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('급식')
    .setDescription('등록된 학교의 급식 정보를 확인합니다.')
    .setContexts(COMMAND_CONTEXTS)
    .addStringOption(option =>
      option.setName('날짜')
        .setDescription('오늘/내일/모레/이번주/이번달 또는 YYYYMMDD (기본값: 오늘)')
        .setAutocomplete(true)
        .setRequired(false))
    .addStringOption(option =>
      option.setName('학교이름')
        .setDescription('검색할 학교의 이름 (입력하지 않으면 등록된 학교 사용)')
        .setMinLength(SCHOOL_NAME_MIN_LENGTH)
        .setMaxLength(SCHOOL_NAME_MAX_LENGTH)
        .setRequired(false)),
].map(command => command.toJSON());

const { DISCORD_TOKEN, CLIENT_ID } = process.env;

const deployCommands = async () => {
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    throw new Error('DISCORD_TOKEN and CLIENT_ID must be set.');
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    // Global commands registration
    const data = await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands },
    );

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error('Command deployment failed:', error.message);
    process.exitCode = 1;
  }
};

if (require.main === module) {
  deployCommands().catch(error => {
    console.error('Command deployment failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  commands,
  deployCommands,
};
