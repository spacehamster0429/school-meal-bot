# School Meal Bot

대한민국 학교의 급식 정보를 Discord에서 조회하는 봇입니다. 교육부 NEIS Open API를 사용하며 서버와 DM에서 모두 동작합니다.

### 급식봇 초대 및 사용: https://discord.com/oauth2/authorize?client_id=1506973963237199884

## 기능

- `/학교설정`: 학교를 검색해 사용자 기본 학교로 저장
- `/급식`: 오늘, 내일, 모레, 이번 주, 이번 달 또는 `YYYYMMDD` 급식 조회
- 학교 검색 결과 선택 메뉴와 여러 날짜 페이지 이동
- NEIS 요청 캐시, Discord 요청 속도 제한, SQLite WAL 저장
- Podman/Docker 컨테이너 및 rootless Quadlet 예제

## 실행

Node.js 22 이상이 필요합니다.

```bash
cp .env.example .env
npm ci
npm run deploy
npm start
```

`.env`에 다음 값을 설정합니다.

```dotenv
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
NEIS_API_KEY=your_neis_api_key_here
```

`NEIS_API_KEY`는 NEIS Open API 키입니다. 키가 없으면 NEIS의 무인증 허용 범위에서 요청합니다.

구문 검사와 선택적 NEIS 스모크 테스트:

```bash
npm run check
npm run smoke:neis -- "검색할 학교명"
```

## 컨테이너

```bash
podman build -t localhost/school-meal-bot:latest .
podman run --rm \
  --env-file .env \
  -v school-meal-data:/data:Z \
  localhost/school-meal-bot:latest
```

`deploy/school-meal-bot.container`는 rootless Podman Quadlet 예제입니다. 환경변수 파일은 `~/.config/school-meal-bot/school-meal-bot.env`, 데이터는 `~/.local/share/school-meal-bot`에 둡니다.

## 데이터와 개인정보

봇은 기능 제공을 위해 로컬 SQLite DB에 Discord 사용자 ID와 선택한 학교의 교육청 코드, 학교 코드, 학교명을 저장합니다. DB 파일은 기본적으로 권한 `0600`으로 제한되며 외부 분석이나 원격 텔레메트리를 사용하지 않습니다.

저장소에는 운영 토큰, 실제 DB, 로그 또는 사용자 데이터가 포함되지 않습니다. `.env`와 DB 파일은 Git 및 컨테이너 빌드 컨텍스트에서 제외됩니다.

## 라이선스

Copyright 2026 우주햄찌.

Apache License 2.0에 따라 배포됩니다. 자세한 내용은 [LICENSE](LICENSE)와 [NOTICE](NOTICE)를 확인하세요.
