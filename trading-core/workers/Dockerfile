# Dedicated independent market-data worker ONLY. Do not select this Dockerfile
# for the existing WhatsApp/Tinder backend service.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY trading-core/workers/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY trading-core/workers/databento_feed.py ./databento_feed.py
ENV TRADING_FEED_OUTBOX=/private-data/trading/market-outbox.sqlite
CMD ["python", "databento_feed.py"]
