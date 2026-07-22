# Stage 1: build the React frontend
FROM node:22-slim AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

# Stage 2: the API server (serves the built frontend)
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MODEL_CACHE_DIR=/models
ENV WEB_DIST=/app/web-dist
COPY services/api/package*.json ./
RUN npm ci --omit=dev
COPY services/api/tsconfig.json ./
COPY services/api/src ./src
COPY --from=web-build /web/dist ./web-dist
EXPOSE 8080
CMD ["npm", "start"]
