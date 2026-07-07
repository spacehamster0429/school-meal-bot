// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

const NEIS_API_URL = 'https://open.neis.go.kr/hub';
const NEIS_API_KEY = process.env.NEIS_API_KEY;
const REQUEST_TIMEOUT_MS = 5000;
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const MEAL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const SCHOOL_NAME_MIN_LENGTH = 2;
const SCHOOL_NAME_MAX_LENGTH = 50;

const cache = new Map();

const normalizeText = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  return String(value).trim() || fallback;
};

const normalizeSchoolName = (schoolName) => {
  const query = String(schoolName ?? '').replace(/\s+/g, ' ').trim();
  if (query.length < SCHOOL_NAME_MIN_LENGTH || query.length > SCHOOL_NAME_MAX_LENGTH) {
    return null;
  }
  return query;
};

const normalizeSchoolNameForRank = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();

const getSchoolSearchRank = (schoolName, query, index) => {
  const normalizedSchoolName = normalizeSchoolNameForRank(schoolName);
  const normalizedQuery = normalizeSchoolNameForRank(query);
  const includeIndex = normalizedSchoolName.indexOf(normalizedQuery);

  if (normalizedSchoolName === normalizedQuery) return [0, normalizedSchoolName.length, index];
  if (normalizedSchoolName.startsWith(normalizedQuery)) return [1, normalizedSchoolName.length, index];
  if (includeIndex >= 0) return [2, includeIndex, normalizedSchoolName.length, index];
  return [3, normalizedSchoolName.length, index];
};

const compareRank = (left, right) => {
  const maxLength = Math.max(left.length, right.length);
  for (let i = 0; i < maxLength; i++) {
    const leftValue = left[i] ?? 0;
    const rightValue = right[i] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
};

const isValidCode = (value) => /^[A-Z0-9]+$/i.test(String(value ?? ''));
const isValidDate = (value) => /^\d{8}$/.test(String(value ?? ''));

const normalizeMenu = (value) => {
  return normalizeText(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    // NEIS occasionally includes stray grave accents after menu names.
    // Discord treats paired backticks as inline-code delimiters, so strip them.
    .replace(/[`´]/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

const getCached = (key) => {
  const cached = cache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return cached.value;
};

const setCached = (key, value, ttlMs) => {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const withResultMeta = (rows, totalCount = rows.length) => {
  Object.defineProperties(rows, {
    totalCount: {
      value: totalCount,
      enumerable: false,
    },
    isPartial: {
      value: totalCount > rows.length,
      enumerable: false,
    },
  });

  return rows;
};

const fetchJson = async (endpoint, params) => {
  const url = new URL(`${NEIS_API_URL}/${endpoint}`);
  if (NEIS_API_KEY) {
    url.searchParams.append('KEY', NEIS_API_KEY);
  }
  url.searchParams.append('Type', 'json');

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });

    if (!response.ok) {
      throw new Error(`NEIS HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('NEIS request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * 학교 이름으로 학교 정보를 검색합니다.
 * @param {string} schoolName
 * @returns {Promise<Array>} 검색된 학교 목록
 */
async function searchSchools(schoolName) {
  const query = normalizeSchoolName(schoolName);
  if (!query) return [];

  const cacheKey = `school:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson('schoolInfo', {
      pIndex: '1',
      pSize: '25', // 최대 25개까지 검색
      SCHUL_NM: query,
    });

    if (data.schoolInfo && data.schoolInfo[1] && data.schoolInfo[1].row) {
      const schools = data.schoolInfo[1].row
        .map((school, index) => ({
          officeCode: normalizeText(school.ATPT_OFCDC_SC_CODE),
          schoolCode: normalizeText(school.SD_SCHUL_CODE),
          schoolName: normalizeText(school.SCHUL_NM, '학교명 없음'),
          address: normalizeText(school.ORG_RDNMA, '주소 정보 없음'),
          rank: getSchoolSearchRank(school.SCHUL_NM, query, index),
        }))
        .filter(school => isValidCode(school.officeCode) && isValidCode(school.schoolCode))
        .sort((left, right) => compareRank(left.rank, right.rank))
        .map(({ rank, ...school }) => school);

      setCached(cacheKey, schools, SEARCH_CACHE_TTL_MS);
      return schools;
    }
    setCached(cacheKey, [], SEARCH_CACHE_TTL_MS);
    return [];
  } catch (error) {
    console.error('학교 검색 오류:', error.message);
    throw new Error('학교 정보를 검색하는 중 오류가 발생했습니다.');
  }
}

/**
 * 특정 학교의 특정 날짜 급식 정보를 가져옵니다.
 * @param {string} officeCode
 * @param {string} schoolCode
 * @param {string} date YYYYMMDD 형식의 날짜
 * @returns {Promise<Array>} 해당 날짜의 급식 목록 (조식, 중식, 석식 등)
 */
async function getMeals(officeCode, schoolCode, date) {
  if (!isValidCode(officeCode) || !isValidCode(schoolCode) || !isValidDate(date)) {
    return withResultMeta([]);
  }

  const cacheKey = `meal:${officeCode}:${schoolCode}:${date}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson('mealServiceDietInfo', {
      pIndex: '1',
      pSize: '3', // 보통 조/중/석식 3개
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      MLSV_YMD: date,
    });

    if (data.mealServiceDietInfo && data.mealServiceDietInfo[1] && data.mealServiceDietInfo[1].row) {
      const rows = data.mealServiceDietInfo[1].row;
      const totalCount = Number(data.mealServiceDietInfo[0]?.head?.[0]?.list_total_count) || rows.length;
      const meals = rows.map(meal => ({
        mealType: normalizeText(meal.MMEAL_SC_NM, '급식'), // 조식, 중식, 석식
        menu: normalizeMenu(meal.DDISH_NM), // 알레르기 정보 숫자 유지
        calories: normalizeText(meal.CAL_INFO, '열량 정보 없음'),
      }));

      const result = withResultMeta(meals, totalCount);
      setCached(cacheKey, result, MEAL_CACHE_TTL_MS);
      return result;
    }
    const result = withResultMeta([]);
    setCached(cacheKey, result, MEAL_CACHE_TTL_MS);
    return result;
  } catch (error) {
    console.error('급식 정보 조회 오류:', error.message);
    throw new Error('급식 정보를 불러오는 중 오류가 발생했습니다.');
  }
}

/**
 * 특정 학교의 기간별 급식 정보를 가져옵니다.
 * @param {string} officeCode
 * @param {string} schoolCode
 * @param {string} fromDate YYYYMMDD 시작 날짜
 * @param {string} toDate YYYYMMDD 종료 날짜
 * @returns {Promise<Array>} 해당 기간의 급식 목록
 */
async function getMealsByRange(officeCode, schoolCode, fromDate, toDate) {
  if (
    !isValidCode(officeCode) ||
    !isValidCode(schoolCode) ||
    !isValidDate(fromDate) ||
    !isValidDate(toDate) ||
    Number(fromDate) > Number(toDate)
  ) {
    return withResultMeta([]);
  }

  const cacheKey = `range:${officeCode}:${schoolCode}:${fromDate}:${toDate}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson('mealServiceDietInfo', {
      pIndex: '1',
      pSize: '100', // 한 달(약 20~25일) 분량으로 100개면 충분
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      MLSV_FROM_YMD: fromDate,
      MLSV_TO_YMD: toDate,
    });

    if (data.mealServiceDietInfo && data.mealServiceDietInfo[1] && data.mealServiceDietInfo[1].row) {
      const rows = data.mealServiceDietInfo[1].row;
      const totalCount = Number(data.mealServiceDietInfo[0]?.head?.[0]?.list_total_count) || rows.length;
      const meals = rows.map(meal => ({
        date: normalizeText(meal.MLSV_YMD),
        mealType: normalizeText(meal.MMEAL_SC_NM, '급식'), // 조식, 중식, 석식
        menu: normalizeMenu(meal.DDISH_NM),
        calories: normalizeText(meal.CAL_INFO, '열량 정보 없음'),
      }));

      const result = withResultMeta(meals, totalCount);
      setCached(cacheKey, result, MEAL_CACHE_TTL_MS);
      return result;
    }
    const result = withResultMeta([]);
    setCached(cacheKey, result, MEAL_CACHE_TTL_MS);
    return result;
  } catch (error) {
    console.error('기간 급식 정보 조회 오류:', error.message);
    throw new Error('기간 급식 정보를 불러오는 중 오류가 발생했습니다.');
  }
}

module.exports = {
  searchSchools,
  getMeals,
  getMealsByRange,
};
