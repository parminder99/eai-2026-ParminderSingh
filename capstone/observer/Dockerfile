FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY shared ./shared
COPY grading/schema ./grading/schema
COPY observer ./observer
CMD ["node", "observer/server.mjs"]
