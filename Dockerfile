FROM node:lts-slim

WORKDIR /app

# Install required dependencies,
# see Puppeteer container image: https://github.com/puppeteer/puppeteer/blob/0107ad8f08fc17d30492bd767c0bda62a870ae65/docker/Dockerfile

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y wget gnupg \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./

RUN yarn --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./

COPY src src

RUN yarn build

CMD ["/app/dist/index.mjs"]