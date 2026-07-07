// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

require('dotenv').config({ quiet: true });
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  Partials,
  ActivityType,
  MessageFlags,
} = require('discord.js');
const crypto = require('crypto');
const { getUser, saveUser, closeDatabase } = require('./database');
const { searchSchools, getMeals, getMealsByRange } = require('./neis');

const RATE_LIMIT_MS = 3000;
const SELECT_TTL_MS = 10 * 60 * 1000;
const MEAL_NAV_TTL_MS = 10 * 60 * 1000;
const PAGE_TTL_MS = 30 * 60 * 1000;
const SCHOOL_NAME_MIN_LENGTH = 2;
const SCHOOL_NAME_MAX_LENGTH = 50;
const MAX_DISPLAY_LENGTH = 100;
const RANGE_MAX_MEALS_PER_PAGE = 5;
const EMBED_FIELD_COUNT_LIMIT = 25;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_SAFE_LENGTH = 1000;
const EMBED_TOTAL_SAFE_LENGTH = 5500;
const DATE_SUGGESTIONS = ['오늘', '내일', '모레', '이번주', '이번달'];
const STATUS_MESSAGE = '맛있는 급식이 나오길 비는중..';
const USER_INSTALL_INTEGRATION_TYPE = 1;
const DISCORD_WEBHOOK_PING_TYPE = 0;
const DISCORD_WEBHOOK_EVENT_TYPE = 1;
const DISCORD_EVENT_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const DISCORD_EVENT_WEBHOOK_DEFAULT_PATH = '/discord/events';
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const USER_INSTALL_WELCOME_MESSAGE = [
  '급식봇을 선택해 주셔서 감사합니다!',
  '',
  '간단 사용법은 이렇습니다.',
  '• `/학교설정 이름:학교명` — 내 기본 학교를 저장합니다.',
  '• `/급식` — 저장한 학교의 오늘 급식을 보여줍니다.',
  '• `/급식 날짜:내일` — 내일/모레/이번주/이번달도 볼 수 있습니다.',
].join('\n');
const MEAL_TYPE_ORDER = new Map([
  ['조식', 0],
  ['중식', 1],
  ['석식', 2],
]);

const cooldowns = new Map();
const pendingSchoolSelections = new Map();
const pendingMealNavigation = new Map();
const paginatedMealViews = new Map();
const pendingInstallWelcomeUserIds = new Set();
let eventWebhookServer = null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
  allowedMentions: { parse: [] },
});

const normalizeSchoolQuery = (value) => {
  const query = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (query.length < SCHOOL_NAME_MIN_LENGTH || query.length > SCHOOL_NAME_MAX_LENGTH) {
    return null;
  }
  return query;
};

const truncateText = (value, maxLength = MAX_DISPLAY_LENGTH) => {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
};

const escapeDiscordText = (value, maxLength = MAX_DISPLAY_LENGTH) => {
  return truncateText(value, maxLength)
    .replace(/@/g, '@\u200b')
    .replace(/<([@#][^>]+)>/g, '<\u200b$1>');
};

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const normalizeWebhookPath = (value) => {
  const path = String(value || DISCORD_EVENT_WEBHOOK_DEFAULT_PATH).trim() || DISCORD_EVENT_WEBHOOK_DEFAULT_PATH;
  return path.startsWith('/') ? path : `/${path}`;
};

const parseWebhookPort = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) {
    throw new Error('DISCORD_EVENT_WEBHOOK_PORT must be a number between 1 and 65535.');
  }

  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DISCORD_EVENT_WEBHOOK_PORT must be a number between 1 and 65535.');
  }

  return port;
};

const createDiscordPublicKey = (publicKeyHex) => {
  const text = String(publicKeyHex || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error('DISCORD_PUBLIC_KEY must be a 32-byte hex string from the Discord Developer Portal.');
  }

  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_DER_PREFIX, Buffer.from(text, 'hex')]),
    format: 'der',
    type: 'spki',
  });
};

const getDiscordEventWebhookConfig = () => {
  const port = parseWebhookPort(process.env.DISCORD_EVENT_WEBHOOK_PORT);
  if (!port) return null;

  return {
    host: String(process.env.DISCORD_EVENT_WEBHOOK_HOST || '0.0.0.0').trim() || '0.0.0.0',
    path: normalizeWebhookPath(process.env.DISCORD_EVENT_WEBHOOK_PATH),
    port,
    publicKey: createDiscordPublicKey(process.env.DISCORD_PUBLIC_KEY),
  };
};

const readRequestBody = async (request) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > DISCORD_EVENT_WEBHOOK_MAX_BODY_BYTES) {
      throw createHttpError(413, 'Payload too large.');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

const verifyDiscordEventSignature = ({ publicKey, timestamp, signature, body }) => {
  if (!timestamp || !signature || !/^[0-9a-fA-F]{128}$/.test(String(signature))) {
    return false;
  }

  return crypto.verify(
    null,
    Buffer.concat([Buffer.from(String(timestamp)), body]),
    publicKey,
    Buffer.from(String(signature), 'hex'),
  );
};

const sendNoContent = (response) => {
  response.writeHead(204, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end();
};

const sendTextResponse = (response, statusCode, message) => {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(message);
};

const privateReplyOptions = (interaction) => {
  return interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {};
};

const privateOnlyReplyOptions = (interaction, enabled) => {
  return interaction.inGuild() && enabled ? { flags: MessageFlags.Ephemeral } : {};
};

const getKoreanToday = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).split('-').map(Number);

  return new Date(parts[0], parts[1] - 1, parts[2]);
};

const splitTextForEmbedField = (value) => {
  const text = String(value || '메뉴 없음').trim() || '메뉴 없음';
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > EMBED_FIELD_SAFE_LENGTH) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }

      for (let i = 0; i < line.length; i += EMBED_FIELD_SAFE_LENGTH) {
        chunks.push(line.slice(i, i + EMBED_FIELD_SAFE_LENGTH));
      }
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > EMBED_FIELD_SAFE_LENGTH) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.map(chunk => chunk.slice(0, EMBED_FIELD_VALUE_LIMIT));
};

const chunkEmbedFields = (fields) => {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const field of fields) {
    const fieldLength = field.name.length + field.value.length;
    const shouldStartNext =
      current.length > 0 &&
      (current.length >= EMBED_FIELD_COUNT_LIMIT || currentLength + fieldLength > EMBED_TOTAL_SAFE_LENGTH);

    if (shouldStartNext) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(field);
    currentLength += fieldLength;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
};

const getMealTypeOrder = (mealType) => {
  return MEAL_TYPE_ORDER.get(String(mealType ?? '').trim()) ?? 99;
};

const sortMealsForDisplay = (meals) => {
  return [...meals].sort((left, right) => {
    const dateCompare = String(left.date ?? '').localeCompare(String(right.date ?? ''));
    if (dateCompare !== 0) return dateCompare;

    const mealTypeCompare = getMealTypeOrder(left.mealType) - getMealTypeOrder(right.mealType);
    if (mealTypeCompare !== 0) return mealTypeCompare;

    return String(left.mealType ?? '').localeCompare(String(right.mealType ?? ''));
  });
};

const chunkMealsForPages = (meals) => {
  const pages = [];

  for (let i = 0; i < meals.length; i += RANGE_MAX_MEALS_PER_PAGE) {
    pages.push(meals.slice(i, i + RANGE_MAX_MEALS_PER_PAGE));
  }

  return pages;
};

const createRangeMealFields = (meals) => {
  const grouped = new Map();

  for (const meal of meals) {
    const date = meal.date || '날짜 없음';
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(meal);
  }

  const fields = [];

  for (const [dateStr, dayMeals] of grouped) {
    const dateTitle = parseDateString(dateStr);
    let menuContent = '';

    dayMeals.forEach(meal => {
      const menuText = meal.menu || '메뉴 없음';
      menuContent += `**[${meal.mealType}]** (${meal.calories})\n${menuText}\n\n`;
    });

    const values = splitTextForEmbedField(menuContent);
    values.forEach((value, index) => {
      fields.push({
        name: values.length === 1 ? dateTitle : `${dateTitle} (${index + 1}/${values.length})`,
        value,
      });
    });
  }

  return fields;
};

const createRangeMealFieldChunks = (meals) => {
  const sortedMeals = sortMealsForDisplay(meals);

  return chunkMealsForPages(sortedMeals)
    .flatMap(pageMeals => chunkEmbedFields(createRangeMealFields(pageMeals)));
};

const createMealPaginationRow = (nonce, page, totalPages) => {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`meal_page:${nonce}:prev`)
      .setLabel('이전')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`meal_page:${nonce}:status`)
      .setLabel(`${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`meal_page:${nonce}:next`)
      .setLabel('다음')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1),
  );
};

const createTomorrowMealRow = (nonce) => {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`meal_tomorrow:${nonce}`)
      .setLabel('내일 급식 보기')
      .setStyle(ButtonStyle.Primary),
  );
};

const createSingleMealEmbed = (schoolName, formattedDate, meals) => {
  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle(`${truncateText(schoolName, 180)} 급식 식단표`)
    .setDescription(`${parseDateString(formattedDate)} 식단입니다.`)
    .setTimestamp();

  meals.forEach(meal => {
    let menuText = meal.menu;
    if (!menuText || menuText.trim() === '') {
      menuText = '메뉴 정보 없음';
    }
    if (menuText.length > 1024) menuText = `${menuText.substring(0, 1000)}...`;
    embed.addFields({
      name: `${meal.mealType} (${meal.calories})`,
      value: menuText,
    });
  });

  return embed;
};

const createTomorrowMealNavigation = ({ userId, officeCode, schoolCode, schoolName }) => {
  const tomorrow = getKoreanToday();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nonce = crypto.randomBytes(6).toString('hex');
  pendingMealNavigation.set(nonce, {
    userId,
    officeCode,
    schoolCode,
    schoolName,
    date: formatDate(tomorrow),
    expiresAt: Date.now() + MEAL_NAV_TTL_MS,
  });

  return createTomorrowMealRow(nonce);
};

const cleanupExpiredEntries = () => {
  const now = Date.now();

  for (const [key, expiresAt] of cooldowns) {
    if (expiresAt <= now) cooldowns.delete(key);
  }

  for (const [key, selection] of pendingSchoolSelections) {
    if (selection.expiresAt <= now) pendingSchoolSelections.delete(key);
  }

  for (const [key, navigation] of pendingMealNavigation) {
    if (navigation.expiresAt <= now) pendingMealNavigation.delete(key);
  }

  for (const [key, pageState] of paginatedMealViews) {
    if (pageState.expiresAt <= now) paginatedMealViews.delete(key);
  }
};

const isRateLimited = (interaction) => {
  cleanupExpiredEntries();

  const key = `${interaction.user.id}:${interaction.commandName}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(key) ?? 0;

  if (expiresAt > now) {
    return Math.ceil((expiresAt - now) / 1000);
  }

  cooldowns.set(key, now + RATE_LIMIT_MS);
  return 0;
};

const sendUserInstallWelcomeMessage = async (userId) => {
  try {
    await client.users.send(userId, {
      content: USER_INSTALL_WELCOME_MESSAGE,
      allowedMentions: { parse: [] },
    });
    console.log(`Sent user install welcome DM to ${userId}.`);
  } catch (error) {
    console.warn(`Failed to send user install welcome DM to ${userId}: ${error.message}`);
  }
};

const queueUserInstallWelcomeMessage = (userId) => {
  const normalizedUserId = String(userId || '').trim();
  if (!/^\d{16,22}$/.test(normalizedUserId)) {
    console.warn('Ignoring APPLICATION_AUTHORIZED event without a valid user id.');
    return;
  }

  if (!client.isReady()) {
    pendingInstallWelcomeUserIds.add(normalizedUserId);
    return;
  }

  void sendUserInstallWelcomeMessage(normalizedUserId);
};

const flushPendingInstallWelcomeMessages = () => {
  if (pendingInstallWelcomeUserIds.size === 0) return;

  const userIds = [...pendingInstallWelcomeUserIds];
  pendingInstallWelcomeUserIds.clear();
  userIds.forEach(userId => queueUserInstallWelcomeMessage(userId));
};

const handleApplicationAuthorizedEvent = (data) => {
  if (!data || Number(data.integration_type) !== USER_INSTALL_INTEGRATION_TYPE) {
    return;
  }

  queueUserInstallWelcomeMessage(data.user?.id);
};

const handleDiscordEventWebhookPayload = (payload) => {
  if (payload?.type === DISCORD_WEBHOOK_PING_TYPE) {
    return;
  }

  if (payload?.type !== DISCORD_WEBHOOK_EVENT_TYPE) {
    console.warn(`Ignoring unsupported Discord webhook payload type: ${payload?.type ?? 'unknown'}.`);
    return;
  }

  const event = payload.event;
  if (event?.type === 'APPLICATION_AUTHORIZED') {
    handleApplicationAuthorizedEvent(event.data);
  }
};

const handleDiscordEventWebhookRequest = async (request, response, config) => {
  if (request.method !== 'POST') {
    return sendTextResponse(response, 405, 'Method Not Allowed');
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    return sendTextResponse(response, 400, 'Bad Request');
  }

  if (requestUrl.pathname !== config.path) {
    return sendTextResponse(response, 404, 'Not Found');
  }

  const body = await readRequestBody(request);
  const timestamp = request.headers['x-signature-timestamp'];
  const signature = request.headers['x-signature-ed25519'];

  if (!verifyDiscordEventSignature({
    publicKey: config.publicKey,
    timestamp,
    signature,
    body,
  })) {
    return sendTextResponse(response, 401, 'Invalid request signature.');
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return sendTextResponse(response, 400, 'Invalid JSON payload.');
  }

  sendNoContent(response);
  handleDiscordEventWebhookPayload(payload);
};

const startDiscordEventWebhookServer = () => {
  const config = getDiscordEventWebhookConfig();
  if (!config) return null;

  const server = http.createServer((request, response) => {
    handleDiscordEventWebhookRequest(request, response, config).catch(error => {
      const statusCode = error.statusCode || 500;
      const message = statusCode === 500 ? 'Internal Server Error' : error.message;
      console.error('Discord event webhook request failed:', error.message);

      if (!response.headersSent) {
        sendTextResponse(response, statusCode, message);
      } else {
        response.end();
      }
    });
  });

  server.on('error', error => {
    console.error('Discord event webhook server error:', error.message);
  });

  server.listen(config.port, config.host, () => {
    console.log(`Discord event webhook server listening on ${config.host}:${config.port}${config.path}`);
  });

  return server;
};

client.once(Events.ClientReady, readyClient => {
  readyClient.user.setPresence({
    status: 'online',
    activities: [{
      name: STATUS_MESSAGE,
      state: STATUS_MESSAGE,
      type: ActivityType.Custom,
    }],
  });

  flushPendingInstallWelcomeMessages();

  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

// 날짜 포맷 함수 (YYYYMMDD)
const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

const parseCustomDate = (dateOption, baseDate = getKoreanToday()) => {
  const option = String(dateOption ?? '').trim();
  const fullDateMatch = option.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/);
  const koreanMonthDayMatch = option.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/);

  if (!fullDateMatch && !koreanMonthDayMatch) return null;

  const [yearText, monthText, dayText] = fullDateMatch
    ? fullDateMatch.slice(1)
    : [
      String(baseDate.getFullYear()),
      koreanMonthDayMatch[1].padStart(2, '0'),
      koreanMonthDayMatch[2].padStart(2, '0'),
    ];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return `${yearText}${monthText}${dayText}`;
};

const parseMealDateOption = (dateOption) => {
  const option = String(dateOption || '오늘').trim();
  const today = getKoreanToday();

  if (option === '이번주') {
    const dayOfWeek = today.getDay();
    const diffToMon = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const monday = new Date(today);
    monday.setDate(diffToMon);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);

    return {
      type: 'range',
      fromDate: formatDate(monday),
      toDate: formatDate(friday),
      title: '이번 주(월~금)',
    };
  }

  if (option === '이번달') {
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    return {
      type: 'range',
      fromDate: formatDate(firstDay),
      toDate: formatDate(lastDay),
      title: `${today.getMonth() + 1}월 전체`,
    };
  }

  const targetDate = new Date(today);
  if (option === '내일') {
    targetDate.setDate(targetDate.getDate() + 1);
    return { type: 'single', date: formatDate(targetDate) };
  }
  if (option === '모레') {
    targetDate.setDate(targetDate.getDate() + 2);
    return { type: 'single', date: formatDate(targetDate) };
  }
  if (option === '오늘') {
    return { type: 'single', date: formatDate(targetDate) };
  }

  const customDate = parseCustomDate(option, today);
  if (customDate) {
    return { type: 'single', date: customDate };
  }

  return null;
};

// YYYYMMDD 형태를 보기 좋은 문자열로 변환
const parseDateString = (dateStr) => {
  if (dateStr.length !== 8) return dateStr;
  return `${dateStr.substring(0, 4)}년 ${dateStr.substring(4, 6)}월 ${dateStr.substring(6, 8)}일`;
}

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== '급식') return;

    const focused = interaction.options.getFocused(true);
    if (focused.name !== '날짜') return;

    const value = String(focused.value ?? '').trim();
    const suggestions = DATE_SUGGESTIONS
      .filter(choice => choice.includes(value))
      .map(choice => ({ name: choice, value: choice }));

    return interaction.respond(suggestions.slice(0, 25));
  }

  if (interaction.isChatInputCommand()) {
    const retryAfterSeconds = isRateLimited(interaction);
    if (retryAfterSeconds > 0) {
      return interaction.reply({
        content: `명령어를 너무 빠르게 사용하고 있습니다. ${retryAfterSeconds}초 후 다시 시도해주세요.`,
        ...privateReplyOptions(interaction),
        allowedMentions: { parse: [] },
      });
    }

    if (interaction.commandName === '학교설정') {
      const schoolName = normalizeSchoolQuery(interaction.options.getString('이름'));

      await interaction.deferReply(privateReplyOptions(interaction));

      if (!schoolName) {
        return interaction.editReply(`학교 이름은 ${SCHOOL_NAME_MIN_LENGTH}~${SCHOOL_NAME_MAX_LENGTH}자로 입력해주세요.`);
      }

      try {
        const schools = await searchSchools(schoolName);

        if (schools.length === 0) {
          return interaction.editReply('해당 이름의 학교를 찾을 수 없습니다.');
        }

        const nonce = crypto.randomBytes(6).toString('hex');
        const schoolChoices = schools.slice(0, 25);

        pendingSchoolSelections.set(nonce, {
          userId: interaction.user.id,
          expiresAt: Date.now() + SELECT_TTL_MS,
          schools: new Map(schoolChoices.map(school => [
            `${school.officeCode}|${school.schoolCode}`,
            school,
          ])),
        });

        const select = new StringSelectMenuBuilder()
          .setCustomId(`select_school:${nonce}`)
          .setPlaceholder('정확한 학교를 선택해주세요.');

        schoolChoices.forEach(school => {
          select.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(truncateText(school.schoolName || '학교명 없음', 100))
              .setDescription(truncateText(school.address || '주소 정보 없음', 100))
              .setValue(`${school.officeCode}|${school.schoolCode}`)
          );
        });

        const row = new ActionRowBuilder().addComponents(select);

        await interaction.editReply({
          content: `'${escapeDiscordText(schoolName)}' 검색 결과입니다. 본인의 학교를 선택해주세요:`,
          components: [row]
        });

      } catch (error) {
        console.error('학교 검색 처리 오류:', error.message);
        await interaction.editReply('학교 검색 중 오류가 발생했습니다.');
      }
    } else if (interaction.commandName === '급식') {
      const privateOnly = interaction.options.getBoolean('나만보기') ?? false;
      await interaction.deferReply(privateOnlyReplyOptions(interaction, privateOnly));

      const schoolNameOptionRaw = interaction.options.getString('학교이름');
      const schoolNameOption = schoolNameOptionRaw ? normalizeSchoolQuery(schoolNameOptionRaw) : null;
      let officeCode, schoolCode, schoolName;

      if (schoolNameOptionRaw && !schoolNameOption) {
        return interaction.editReply(`학교 이름은 ${SCHOOL_NAME_MIN_LENGTH}~${SCHOOL_NAME_MAX_LENGTH}자로 입력해주세요.`);
      }

      if (schoolNameOption) {
        try {
          const schools = await searchSchools(schoolNameOption);
          if (schools.length === 0) {
            return interaction.editReply(`'${escapeDiscordText(schoolNameOption)}'에 해당하는 학교를 찾을 수 없습니다.`);
          }
          const school = schools[0]; // 검색 결과 중 가장 첫 번째 학교 사용
          officeCode = school.officeCode;
          schoolCode = school.schoolCode;
          schoolName = school.schoolName;
        } catch (e) {
          console.error('급식 학교 검색 오류:', e.message);
          return interaction.editReply('학교 검색 중 오류가 발생했습니다.');
        }
      } else {
        const user = getUser(interaction.user.id);
        if (!user) {
          return interaction.editReply('등록된 학교가 없습니다. `학교이름` 옵션을 입력하거나 `/학교설정` 커맨드로 먼저 학교를 등록해주세요.');
        }
        officeCode = user.office_code;
        schoolCode = user.school_code;
        schoolName = user.school_name;
      }

      const dateOption = interaction.options.getString('날짜') || '오늘';
      const parsedDateOption = parseMealDateOption(dateOption);

      if (!parsedDateOption) {
        return interaction.editReply('날짜는 `오늘`, `내일`, `모레`, `이번주`, `이번달`, `20260521` 또는 `5월 21일` 형식으로 입력해주세요.');
      }

      try {
        if (parsedDateOption.type === 'range') {
          const { fromDate, toDate, title: titleStr } = parsedDateOption;

          const meals = await getMealsByRange(officeCode, schoolCode, fromDate, toDate);

          if (meals.length === 0) {
            return interaction.editReply(`${titleStr}에는 ${escapeDiscordText(schoolName)}의 급식 정보가 없습니다.`);
          }

          const sortedMeals = sortMealsForDisplay(meals);
          const dayCount = new Set(sortedMeals.map(meal => meal.date)).size;
          const chunks = createRangeMealFieldChunks(sortedMeals);
          const partialNotice = meals.isPartial
            ? `\nNEIS API 키가 없어 전체 ${meals.totalCount}식 중 ${meals.length}식만 표시됩니다.`
            : '';
          const replyContent = `요청하신 **${escapeDiscordText(schoolName)}**의 ${titleStr} 식단표입니다! 표시 ${dayCount}일 / ${meals.length}식${partialNotice}`;

          const buildEmbed = (chunk, page) => {
            const embed = new EmbedBuilder()
              .setColor(0x0099FF)
              .setTitle(`${truncateText(schoolName, 150)} ${titleStr} 급식 (${page + 1}/${chunks.length})`);

            embed.addFields(chunk);

            return embed;
          };

          const embeds = chunks.map((chunk, page) => buildEmbed(chunk, page));
          const pageNonce = crypto.randomBytes(6).toString('hex');
          const components = embeds.length > 1 ? [createMealPaginationRow(pageNonce, 0, embeds.length)] : [];

          if (embeds.length > 1) {
            paginatedMealViews.set(pageNonce, {
              userId: interaction.user.id,
              expiresAt: Date.now() + PAGE_TTL_MS,
              currentPage: 0,
              content: replyContent,
              embeds,
            });
          }

          await interaction.editReply({
            content: replyContent,
            embeds: [embeds[0]],
            components,
            allowedMentions: { parse: [] },
          });

        } else {
          const formattedDate = parsedDateOption.date;
          const meals = await getMeals(officeCode, schoolCode, formattedDate);
          const isToday = formattedDate === formatDate(getKoreanToday());
          const components = isToday
            ? [createTomorrowMealNavigation({
              userId: interaction.user.id,
              officeCode,
              schoolCode,
              schoolName,
            })]
            : [];

          if (meals.length === 0) {
            return interaction.editReply({
              content: `${parseDateString(formattedDate)}에는 ${escapeDiscordText(schoolName)}의 급식 정보가 없습니다.`,
              components,
              allowedMentions: { parse: [] },
            });
          }

          const embed = createSingleMealEmbed(schoolName, formattedDate, meals);

          await interaction.editReply({
            embeds: [embed],
            components,
            allowedMentions: { parse: [] },
          });
        }
      } catch (error) {
        console.error('급식 처리 오류:', error.message);
        await interaction.editReply('급식 정보를 가져오는 중 오류가 발생했습니다.');
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('select_school:')) {
      cleanupExpiredEntries();

      const nonce = interaction.customId.split(':')[1];
      const selection = pendingSchoolSelections.get(nonce);

      if (!selection) {
        return interaction.reply({
          content: '학교 선택 시간이 만료되었습니다. `/학교설정`을 다시 실행해주세요.',
          ...privateReplyOptions(interaction),
          allowedMentions: { parse: [] },
        });
      }

      if (selection.userId !== interaction.user.id) {
        return interaction.reply({
          content: '이 학교 선택 메뉴는 다른 사용자가 만든 메뉴입니다.',
          ...privateReplyOptions(interaction),
          allowedMentions: { parse: [] },
        });
      }

      const selected = interaction.values[0];
      const school = selection.schools.get(selected);

      if (!school) {
        pendingSchoolSelections.delete(nonce);
        return interaction.update({
          content: '선택한 학교 정보를 확인할 수 없습니다. `/학교설정`을 다시 실행해주세요.',
          components: [],
          allowedMentions: { parse: [] },
        });
      }

      const { officeCode, schoolCode, schoolName } = school;

      saveUser(interaction.user.id, officeCode, schoolCode, schoolName);
      pendingSchoolSelections.delete(nonce);

      await interaction.update({
        content: `성공적으로 **${escapeDiscordText(schoolName)}**이(가) 등록되었습니다! 이제 \`/급식\` 커맨드를 사용해보세요.`,
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  } else if (interaction.isButton()) {
    if (interaction.customId.startsWith('meal_tomorrow:')) {
      cleanupExpiredEntries();

      const [, nonce] = interaction.customId.split(':');
      const navigation = pendingMealNavigation.get(nonce);

      if (!navigation) {
        return interaction.reply({
          content: '버튼이 만료되었습니다. `/급식` 명령어를 다시 실행해주세요.',
          ...privateReplyOptions(interaction),
          allowedMentions: { parse: [] },
        });
      }

      if (navigation.userId !== interaction.user.id) {
        return interaction.reply({
          content: '이 버튼은 `/급식` 명령어를 실행한 사용자만 사용할 수 있습니다.',
          ...privateReplyOptions(interaction),
          allowedMentions: { parse: [] },
        });
      }

      await interaction.deferUpdate();

      try {
        const meals = await getMeals(navigation.officeCode, navigation.schoolCode, navigation.date);
        pendingMealNavigation.delete(nonce);

        if (meals.length === 0) {
          return interaction.editReply({
            content: `${parseDateString(navigation.date)}에는 ${escapeDiscordText(navigation.schoolName)}의 급식 정보가 없습니다.`,
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
          });
        }

        return interaction.editReply({
          content: `**${escapeDiscordText(navigation.schoolName)}**의 내일 급식입니다.`,
          embeds: [createSingleMealEmbed(navigation.schoolName, navigation.date, meals)],
          components: [],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        console.error('내일 급식 처리 오류:', error.message);
        return interaction.editReply({
          content: '내일 급식 정보를 가져오는 중 오류가 발생했습니다. 잠시 후 버튼을 다시 눌러주세요.',
          components: [createTomorrowMealRow(nonce)],
          allowedMentions: { parse: [] },
        });
      }
    } else if (interaction.customId.startsWith('meal_page:')) {
      cleanupExpiredEntries();

      const [, nonce, direction] = interaction.customId.split(':');
      const pageState = paginatedMealViews.get(nonce);

      if (!pageState) {
        return interaction.reply({
          content: '페이지가 만료되었습니다. `/급식` 명령어를 다시 실행해주세요.',
          ...privateReplyOptions(interaction),
          allowedMentions: { parse: [] },
        });
      }

      if (pageState.userId !== interaction.user.id) {
        return interaction.reply({
          content: '이 페이지 버튼은 명령어를 실행한 사용자만 사용할 수 있습니다.',
          ...privateReplyOptions(interaction),
          allowedMentions: { parse: [] },
        });
      }

      if (direction === 'status') {
        return interaction.deferUpdate();
      }

      const totalPages = pageState.embeds.length;
      const nextPage = direction === 'next'
        ? Math.min(pageState.currentPage + 1, totalPages - 1)
        : Math.max(pageState.currentPage - 1, 0);

      pageState.currentPage = nextPage;
      pageState.expiresAt = Date.now() + PAGE_TTL_MS;

      return interaction.update({
        content: pageState.content,
        embeds: [pageState.embeds[nextPage]],
        components: [createMealPaginationRow(nonce, nextPage, totalPages)],
        allowedMentions: { parse: [] },
      });
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set.');
  process.exit(1);
}

try {
  eventWebhookServer = startDiscordEventWebhookServer();
} catch (error) {
  console.error('Failed to start Discord event webhook server:', error.message);
  process.exit(1);
}

let isShuttingDown = false;
const shutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Received ${signal}; shutting down cleanly.`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  try {
    if (eventWebhookServer) {
      eventWebhookServer.close();
    }
    client.destroy();
    closeDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed:', error.message);
    process.exit(1);
  }
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

client.login(process.env.DISCORD_TOKEN);
