// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

async function test() {
  const schoolName = process.argv.slice(2).join(' ').trim();
  if (!schoolName) {
    throw new Error('Usage: npm run smoke:neis -- <school name>');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL('https://open.neis.go.kr/hub/schoolInfo');
    url.search = new URLSearchParams({
      Type: 'json',
      pIndex: '1',
      pSize: '10',
      SCHUL_NM: schoolName,
    }).toString();

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });

    if (!res.ok) {
      throw new Error(`NEIS HTTP ${res.status}`);
    }

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(e.message);
  } finally {
    clearTimeout(timeout);
  }
}

test();
