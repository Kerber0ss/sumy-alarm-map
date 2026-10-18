FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY server.py sumy-regions.json ./
COPY public/ ./public/

USER 65532:65532
EXPOSE 8765
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8765"]
