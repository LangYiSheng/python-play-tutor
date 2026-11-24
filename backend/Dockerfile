FROM python:3.13-slim@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1
WORKDIR /app/backend
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# 讲解要把 PDF 渲染成页图（poppler），并把引擎产出的 wav 转成 mp3。
# 用 lame 而不是 ffmpeg：只要 wav→mp3，ffmpeg 会把镜像多撑 300MB+，lame 只占几 MB。
RUN sed -i 's|^URIs: http://deb.debian.org/debian$|URIs: https://mirrors.tuna.tsinghua.edu.cn/debian|' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils lame \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.lock
COPY backend/app/ ./app/
COPY backend/alembic/ ./alembic/
COPY backend/alembic.ini ./alembic.ini
COPY shared/world/ /app/shared/world/
COPY frontend/public/assets/maps/ /app/frontend/public/assets/maps/
RUN useradd --uid 10001 --create-home reborn && mkdir -p /app/storage /app/data/course && chown -R reborn:reborn /app
USER reborn
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
