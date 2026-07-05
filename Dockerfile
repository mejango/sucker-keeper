FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
ENV DB_PATH=/data/keeper.db
EXPOSE 3000
CMD ["node", "src/server.js"]
