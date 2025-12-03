FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production

# Копируем код И html файл
COPY index.js ./
COPY index.html ./

EXPOSE 8080
CMD ["node", "index.js"]