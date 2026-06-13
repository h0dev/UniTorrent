FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY src/ ./src/

EXPOSE 7860

ENV PORT=7860

CMD ["node", "src/index.js"]
