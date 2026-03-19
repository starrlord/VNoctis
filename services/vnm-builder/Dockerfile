FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu curl unzip bzip2 \
    jpegoptim pngquant libwebp-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Custom web presplash image — copied over the SDK default at container start
COPY web-presplash.webp /app/web-presplash.webp
# Custom index page — replaces the SDK default index.html at container start
COPY index_mod.html /app/index_mod.html

RUN mkdir -p /web-builds /games /renpy-sdk

EXPOSE 3002

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "src/main.py"]
