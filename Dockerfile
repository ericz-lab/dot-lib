# ---- build ----
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime ----
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY server ./server
COPY --from=build /app/dist/client ./dist/client
EXPOSE 8787
USER bun
CMD ["bun", "server/index.ts"]
