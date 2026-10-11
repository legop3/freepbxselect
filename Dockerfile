FROM node:22-alpine
RUN apk add --no-cache espeak-ng ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 3000 40000/udp
CMD ["node","src/server.js"]
