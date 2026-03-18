FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

# Start both the web server and bot using a simple process manager
CMD ["sh", "-c", "node server.js & node bot.js & wait"]
