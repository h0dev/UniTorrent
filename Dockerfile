FROM node:18-alpine

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json ./
RUN npm install --production

# Copy app source
COPY . .

# Expose HF Spaces port
EXPOSE 7860

ENV PORT=7860

CMD ["node", "addon.js"]
