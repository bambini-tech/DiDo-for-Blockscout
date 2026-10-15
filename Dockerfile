# DiDo for Blockscout: one service, the page and the API together.
# BLOCKSCOUT_API_KEY comes from the host's environment variables (on Railway:
# the service's Variables tab); it is never baked into the image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json VERSION ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json VERSION ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
