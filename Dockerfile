FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 && npx tsc && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
