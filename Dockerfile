FROM python:3.12.14-slim-bookworm AS python
FROM node:22.23.3-bookworm-slim
COPY --from=python /usr/local/ /usr/local/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
