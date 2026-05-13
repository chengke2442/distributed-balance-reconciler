FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/main"]
