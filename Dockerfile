FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
ENV PORT=8787 DEALRADAR_DB=/data/dealradar.db NODE_OPTIONS=--disable-warning=ExperimentalWarning
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
