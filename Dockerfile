FROM node:20-slim

# get_iplayer needs Perl + HTTPS + XML + JSON modules, plus ffmpeg for audio conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
        perl \
        libwww-perl \
        liblwp-protocol-https-perl \
        libxml-libxml-perl \
        libjson-perl \
        libio-socket-ssl-perl \
        libnet-ssleay-perl \
        libmojolicious-perl \
        ffmpeg \
        atomicparsley \
        wget \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the get_iplayer Perl script directly from the project's master branch
RUN wget -q -O /usr/local/bin/get_iplayer \
        https://raw.githubusercontent.com/get-iplayer/get_iplayer/master/get_iplayer \
    && chmod +x /usr/local/bin/get_iplayer

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

# downloads is bind-mounted via docker-compose so files are accessible on the host
VOLUME /app/downloads

EXPOSE 3000

CMD ["node", "server.js"]
