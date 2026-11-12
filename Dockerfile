FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install -w server --omit=dev --no-audit --no-fund
COPY server server
COPY app-build app-build
ENV PORT=8080 DB_PATH=/data/stock-iq.db
VOLUME /data
EXPOSE 8080
CMD ["node", "--no-warnings", "node_modules/.bin/tsx", "server/src/index.ts"]
