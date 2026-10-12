FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng python3 python3-venv ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/piper && /opt/piper/bin/pip install --no-cache-dir piper-tts
RUN mkdir -p /opt/voices && \
    curl -fsSL https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx -o /opt/voices/en_US-amy-medium.onnx && \
    curl -fsSL https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx.json -o /opt/voices/en_US-amy-medium.onnx.json
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 3000 40000/udp
CMD ["node","src/server.js"]
