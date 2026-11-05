# syntax=docker/dockerfile:1

# ---------- 阶段 1：前端构建 ----------
FROM node:20-alpine AS web
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY vite.config.ts tailwind.config.* postcss.config.* tsconfig*.json index.html ./
COPY src ./src
RUN npm run build

# ---------- 阶段 2：后端运行 ----------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    YONMAN_DATA_DIR=/app/data \
    YONMAN_DIST_DIR=/app/dist

WORKDIR /app

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ ./server/
COPY --from=web /app/dist ./dist

# 数据目录（SQLite + 工作区文件），挂载卷即可持久化
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8000

CMD ["python", "server/run.py"]
