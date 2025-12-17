require('dotenv').config();
const WebSocket = require('ws');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';

/**
 * Класс для управления текстовым переводом через OpenAI Realtime API
 */
class RealtimeTranslator {
    constructor(sourceLang, targetLang) {
        this.sourceLang = sourceLang;
        this.targetLang = targetLang;
        this.ws = null;
        this.isReady = false;
        this.pendingRequests = []; // FIFO queue: [{ resolve, reject, text }]
        this.requestQueue = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;

        this.connect();
    }

    connect() {
        const direction = this.sourceLang === 'ru' ? 'RU→EN' : 'EN→RU';

        this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        this.ws.on('open', () => {
            console.log(`[Realtime Translation ${direction}] ✓ Connected`);

            // Конфигурация для текстового перевода
            const instruction = this.sourceLang === 'ru'
                ? 'Translate from Russian to English. Output only the translation, nothing else. Be concise and fast.'
                : 'Translate from English to Russian. Output only the translation, nothing else. Be concise and fast.';

            const config = {
                type: 'session.update',
                session: {
                    modalities: ['text'],
                    instructions: instruction,
                    temperature: 0.3,
                    max_response_output_tokens: 500
                }
            };

            this.ws.send(JSON.stringify(config));
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (response.type === 'session.updated') {
                    this.isReady = true;
                    console.log(`[Realtime Translation ${direction}] ✓ Session ready`);
                    this.reconnectAttempts = 0;

                    // Обрабатываем очередь
                    this.processQueue();
                }

                // Получаем полный текст перевода
                if (response.type === 'response.text.done') {
                    const translatedText = response.text || '';

                    // FIFO: первый ответ для первого запроса
                    if (this.pendingRequests.length > 0) {
                        const { resolve } = this.pendingRequests.shift();
                        resolve(translatedText);
                    }
                }

                // Обработка ошибок
                if (response.type === 'error') {
                    console.error(`[Realtime Translation ${direction}] ❌`, response.error?.message);

                    // Отклоняем первый ожидающий запрос
                    if (this.pendingRequests.length > 0) {
                        const { reject } = this.pendingRequests.shift();
                        reject(new Error(response.error?.message || 'Translation error'));
                    }
                }

            } catch (e) {
                console.error(`[Realtime Translation ${direction}] ❌ Parse error:`, e.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[Realtime Translation ${direction}] ❌ WS Error:`, error.message);
        });

        this.ws.on('close', () => {
            console.log(`[Realtime Translation ${direction}] Connection closed`);
            this.isReady = false;

            // Отклоняем все ожидающие запросы
            while (this.pendingRequests.length > 0) {
                const { reject } = this.pendingRequests.shift();
                reject(new Error('WebSocket connection closed'));
            }

            // Попытка переподключения
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                console.log(`[Realtime Translation ${direction}] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                setTimeout(() => this.connect(), 2000);
            }
        });
    }

    processQueue() {
        while (this.requestQueue.length > 0 && this.isReady) {
            const { text, resolve, reject } = this.requestQueue.shift();
            this._sendTranslation(text, resolve, reject);
        }
    }

    _sendTranslation(text, resolve, reject) {
        if (!this.isReady || this.ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not ready'));
            return;
        }

        try {
            // Создаем conversation item с текстом для перевода
            const conversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: text
                        }
                    ]
                }
            };

            this.ws.send(JSON.stringify(conversationItem));

            // Запрашиваем ответ
            const responseCreate = {
                type: 'response.create',
                response: {
                    modalities: ['text']
                }
            };

            this.ws.send(JSON.stringify(responseCreate));

            // Добавляем в FIFO очередь ожидания
            this.pendingRequests.push({ resolve, reject, text });

            // Устанавливаем таймаут на случай отсутствия ответа
            setTimeout(() => {
                const index = this.pendingRequests.findIndex(r => r.resolve === resolve);
                if (index !== -1) {
                    const removed = this.pendingRequests.splice(index, 1)[0];
                    removed.reject(new Error('Translation timeout'));
                }
            }, 10000);

        } catch (error) {
            reject(error);
        }
    }

    async translate(text) {
        if (!text || text.trim().length === 0) {
            return '';
        }

        return new Promise((resolve, reject) => {
            if (this.isReady && this.ws.readyState === WebSocket.OPEN) {
                this._sendTranslation(text, resolve, reject);
            } else {
                // Добавляем в очередь, если не готово
                this.requestQueue.push({ text, resolve, reject });
            }
        });
    }

    close() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}

// Создаем глобальные инстансы переводчиков
let ruToEnTranslator = null;
let enToRuTranslator = null;

/**
 * Инициализация переводчиков (вызывается при старте сессии)
 */
function initTranslators() {
    if (!ruToEnTranslator) {
        ruToEnTranslator = new RealtimeTranslator('ru', 'en');
    }
    if (!enToRuTranslator) {
        enToRuTranslator = new RealtimeTranslator('en', 'ru');
    }
}

/**
 * Переводит текст с русского на английский
 * @param {string} text - Текст на русском языке
 * @returns {Promise<string>} - Переведенный текст на английском
 */
async function translateRuToEn(text) {
    if (!ruToEnTranslator) {
        initTranslators();
    }

    try {
        return await ruToEnTranslator.translate(text);
    } catch (error) {
        console.error('[Translation RU→EN] ❌ Error:', error.message);
        return `[Translation error: ${text}]`;
    }
}

/**
 * Переводит текст с английского на русский
 * @param {string} text - Текст на английском языке
 * @returns {Promise<string>} - Переведенный текст на русском
 */
async function translateEnToRu(text) {
    if (!enToRuTranslator) {
        initTranslators();
    }

    try {
        return await enToRuTranslator.translate(text);
    } catch (error) {
        console.error('[Translation EN→RU] ❌ Error:', error.message);
        return `[Translation error: ${text}]`;
    }
}

/**
 * Закрывает все соединения переводчиков
 */
function closeTranslators() {
    if (ruToEnTranslator) {
        ruToEnTranslator.close();
        ruToEnTranslator = null;
    }
    if (enToRuTranslator) {
        enToRuTranslator.close();
        enToRuTranslator = null;
    }
}

module.exports = {
    translateRuToEn,
    translateEnToRu,
    initTranslators,
    closeTranslators
};
