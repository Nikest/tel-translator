# Используем легкую версию Node.js
FROM node:20-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY package.json ./

# Устанавливаем зависимости
RUN npm install --production

# Копируем остальной код
COPY index.js ./

# Открываем порт (по умолчанию 8080, SignalWire будет стучаться сюда)
EXPOSE 8080

# Запускаем приложение
CMD ["node", "index.js"]