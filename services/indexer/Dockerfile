FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MODEL_CACHE_DIR=/models
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
CMD ["npm", "start"]
