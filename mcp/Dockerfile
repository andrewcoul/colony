FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY firecrawl-server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "firecrawl-server.mjs"]
