# Headless-browser full-content fetch service (deep research).
# Base image ships Chromium + all OS deps preinstalled, matched to playwright 1.49.0.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
# The browsers are already in the image — don't re-download them on npm install.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV PORT=8009
EXPOSE 8009
CMD ["node", "server.mjs"]
