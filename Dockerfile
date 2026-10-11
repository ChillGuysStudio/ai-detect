# Self-hostable single container: Bun API + built Svelte frontend + Chromium + tesseract.
# Run: docker build -t ai-detect . && docker run -p 3000:3000 ai-detect
# Open http://localhost:3000

FROM oven/bun:1 AS frontend
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN bun install
COPY frontend/ ./
RUN bun run build

FROM oven/bun:1-slim AS app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium tesseract-ocr tesseract-ocr-eng poppler-utils \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src/ ./src/
COPY --from=frontend /app/frontend-dist ./frontend-dist
ENV CHROME_EXECUTABLE=/usr/bin/chromium \
	PORT=3000 \
	CHUNK_CONCURRENCY=5 \
	SUBMIT_GAP_MS=1500
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://localhost:3000/api/jobs/nope').then(r=>{if(r.status!==404)throw 0})"
CMD ["bun", "run", "src/server.ts"]
