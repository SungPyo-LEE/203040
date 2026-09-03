# ── 묘한특허(patent-siege) ─────────────────────────────────────────────
# 외부 의존성이 하나도 없다(WebSocket 서버를 Node 내장 모듈로 직접 구현).
# 그래서 빌드 단계를 나눌 이유가 없어 단일 스테이지로 둔다.
FROM node:20-alpine

# 컨테이너 안에서 죽은 프로세스를 거두고 시그널을 제대로 전달해 준다.
# 이게 없으면 Render 가 배포를 갈아끼울 때 SIGTERM 이 node 에 닿지 않아 종료가 늘어진다.
RUN apk add --no-cache tini

WORKDIR /app

# 의존성 정의를 먼저 복사해 이 레이어를 캐시한다 — 소스만 바뀌면 설치를 건너뛴다
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# node 이미지에 이미 있는 비루트 계정으로 낮춰서 돌린다
USER node

# Render 는 PORT 를 주입한다. 로컬에서 그냥 실행할 때를 위한 기본값이다.
ENV NODE_ENV=production \
    PORT=10000
EXPOSE 10000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
