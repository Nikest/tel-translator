require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { initTTSForOperator, initTTSForPhone, playTTSForOperator, playTTSForPhone, closeTTS } = require('./mainTTS');

const PORT = process.env.PORT || 8080;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

let waitingOperator = null;

// --- HTTP Server ---
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        });
    } else {
        res.writeHead(200);
        res.end('Translator Bridge Running');
    }
});

// --- WebSocket Server ---
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    if (pathname === '/call') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.clientType = 'phone';
            wss.emit('connection', ws, request);
        });
    } else if (pathname === '/operator') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.clientType = 'operator';
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    // --- Оператор подключился ---
    if (ws.clientType === 'operator') {
        console.log('[Operator] ✓ Connected via browser');
        waitingOperator = ws;

        ws.send(JSON.stringify({ type: 'status', msg: 'Waiting for a call...' }));

        ws.on('close', () => {
            console.log('[Operator] Disconnected');
            if (waitingOperator === ws) waitingOperator = null;
        });

        ws.on('error', (err) => {
            console.error('[Operator] ❌ Error:', err.message);
        });

        return;
    }

    // --- Звонок от абонента ---
    console.log('[Phone] 📞 Incoming call from SignalWire');

    if (!waitingOperator || waitingOperator.readyState !== WebSocket.OPEN) {
        console.log('[System] ❌ No operator available, rejecting call');
        ws.close();
        return;
    }

    const operatorWs = waitingOperator;
    waitingOperator = null;

    operatorWs.send(JSON.stringify({ type: 'status', msg: 'Call Connected!' }));
    console.log('[System] ✓ Bridge created: Phone ↔ Operator');

    startTranslationSession(ws, operatorWs);
});

// --- Soniox WebSocket Connection ---
function createSonioxConnection(config, onTranslation, onError) {
    const ws = new WebSocket(SONIOX_WS_URL);
    let translationBuffer = '';
    let isConfigured = false;
    let flushTimeout = null;

    // Функция для отправки буфера
    const flushBuffer = () => {
        if (flushTimeout) {
            clearTimeout(flushTimeout);
            flushTimeout = null;
        }
        if (translationBuffer.trim().length > 0) {
            const translation = translationBuffer.trim();
            translationBuffer = '';

            const timestamp = new Date().toISOString().substring(11, 23);
            console.log(`[Soniox ${config.name} ${timestamp}] ✓ Translation: ${translation}`);

            onTranslation(translation);
        }
    };

    // Сброс таймера буфера
    const resetFlushTimer = () => {
        if (flushTimeout) clearTimeout(flushTimeout);
        // Отправляем буфер через 1.5 секунды тишины
        flushTimeout = setTimeout(flushBuffer, 1500);
    };

    ws.on('open', () => {
        console.log(`[Soniox ${config.name}] ✓ Connected`);

        // Отправляем конфигурацию
        const configMessage = {
            api_key: SONIOX_API_KEY,
            model: 'stt-rt-preview',
            audio_format: config.audioFormat,
            sample_rate: config.sampleRate,
            num_channels: 1,
            language_hints: [config.sourceLanguage],
            language_hints_strict: true,
            enable_endpoint_detection: true,
            translation: {
                type: 'one_way',
                target_language: config.targetLanguage
            }
        };

        ws.send(JSON.stringify(configMessage));
        isConfigured = true;
        console.log(`[Soniox ${config.name}] ✓ Configured: ${config.sourceLanguage} → ${config.targetLanguage}`);
    });

    ws.on('message', (data) => {
        try {
            const response = JSON.parse(data.toString());

            if (response.error_code) {
                console.error(`[Soniox ${config.name}] ❌ Error ${response.error_code}: ${response.error_message}`);
                onError(response.error_message);
                return;
            }

            if (response.finished) {
                console.log(`[Soniox ${config.name}] Stream finished`);
                if (flushTimeout) clearTimeout(flushTimeout);
                // Отправляем оставшийся буфер
                if (translationBuffer.trim().length > 0) {
                    onTranslation(translationBuffer.trim());
                    translationBuffer = '';
                }
                return;
            }

            if (response.tokens && response.tokens.length > 0) {


                for (const token of response.tokens) {
                    // Собираем только переведённые финальные токены
                    if (token.translation_status === 'translation' && token.is_final) {
                        translationBuffer += token.text;
                    }
                }

                // Сбрасываем таймер при получении токенов
                if (translationBuffer.length > 0) {
                    resetFlushTimer();
                }

                // Проверяем, есть ли конец предложения в буфере
                const hasSentenceEnd = /[.!?。？！]\s*$/.test(translationBuffer);

                // Или проверяем флаг endpoint в ответе
                const hasEndpoint = response.endpoint !== undefined;

                // Отправляем если есть конец предложения или endpoint
                if ((hasSentenceEnd || hasEndpoint) && translationBuffer.trim().length > 0) {
                    if (flushTimeout) {
                        clearTimeout(flushTimeout);
                        flushTimeout = null;
                    }
                    const translation = translationBuffer.trim();
                    translationBuffer = '';

                    const timestamp = new Date().toISOString().substring(11, 23);
                    console.log(`[Soniox ${config.name} ${timestamp}] ✓ Translation: ${translation}`);

                    onTranslation(translation);
                }
            }
        } catch (e) {
            console.error(`[Soniox ${config.name}] ❌ Parse error:`, e.message);
        }
    });

    ws.on('error', (error) => {
        console.error(`[Soniox ${config.name}] ❌ WebSocket error:`, error.message);
        onError(error.message);
    });

    ws.on('close', () => {
        console.log(`[Soniox ${config.name}] Connection closed`);
    });

    return {
        send: (audioBuffer) => {
            if (ws.readyState === WebSocket.OPEN && isConfigured) {
                ws.send(audioBuffer);
            }
        },
        close: () => {
            if (flushTimeout) clearTimeout(flushTimeout);
            flushBuffer(); // Отправляем остаток буфера
            if (ws.readyState === WebSocket.OPEN) {
                // Отправляем пустой фрейм для graceful close
                ws.send(Buffer.alloc(0));
            }
        },
        isOpen: () => ws.readyState === WebSocket.OPEN
    };
}

// --- Translation Session ---
function startTranslationSession(phoneWs, operatorWs) {
    let streamSid = null;
    let sonioxPhone = null;
    let sonioxOperator = null;

    // --- Soniox для Phone (RU → EN) ---
    sonioxPhone = createSonioxConnection(
        {
            name: 'Phone RU→EN',
            audioFormat: 'mulaw',
            sampleRate: 8000,
            sourceLanguage: 'ru',
            targetLanguage: 'en'
        },
        async (translatedText) => {
            // Отправляем перевод оператору (текст)
            if (operatorWs.readyState === WebSocket.OPEN) {
                operatorWs.send(JSON.stringify({
                    type: 'transcript',
                    speaker: 'client',
                    text: translatedText,
                    language: 'en'
                }));
            }

            // Озвучиваем для оператора
            await playTTSForOperator(translatedText);
        },
        (error) => {
            console.error('[Phone Translation] Error:', error);
        }
    );

    // --- Soniox для Operator (EN → RU) ---
    sonioxOperator = createSonioxConnection(
        {
            name: 'Operator EN→RU',
            audioFormat: 'pcm_s16le',
            sampleRate: 24000,
            sourceLanguage: 'en',
            targetLanguage: 'ru'
        },
        async (translatedText) => {
            // Отправляем перевод оператору (что будет сказано абоненту)
            if (operatorWs.readyState === WebSocket.OPEN) {
                operatorWs.send(JSON.stringify({
                    type: 'transcript',
                    speaker: 'operator_translated',
                    text: translatedText,
                    language: 'ru'
                }));
            }

            // Озвучиваем для абонента
            await playTTSForPhone(translatedText);
        },
        (error) => {
            console.error('[Operator Translation] Error:', error);
        }
    );

    // --- Обработка сообщений от Phone (SignalWire) ---
    phoneWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;

                // Инициализируем TTS для абонента
                initTTSForPhone(phoneWs, streamSid);
            }

            if (msg.event === 'media' && sonioxPhone) {
                try {
                    // Декодируем base64 mulaw аудио и отправляем в Soniox
                    const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                    sonioxPhone.send(audioBuffer);
                } catch (e) {
                    console.error('[Soniox Phone] ❌ Failed to send audio:', e.message);
                }
            }

            if (msg.event === 'stop') {
                console.log('[Phone] Call ended');
                closeAll();
            }

        } catch (e) {
            // Игнорируем ошибки парсинга
        }
    });

    // Инициализируем TTS для оператора
    initTTSForOperator(operatorWs);

    // --- Обработка сообщений от Operator ---
    operatorWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.type === 'audio' && sonioxOperator) {
                try {
                    // Декодируем base64 PCM16 и отправляем в Soniox
                    const audioBuffer = Buffer.from(msg.payload, 'base64');
                    sonioxOperator.send(audioBuffer);
                } catch (e) {
                    console.error('[Soniox Operator] ❌ Failed to send audio:', e.message);
                }
            }

        } catch (e) {
            // Игнорируем ошибки парсинга
        }
    });

    // =====================
    // Закрытие сессии
    // =====================
    const closeAll = () => {
        console.log('[System] Closing all connections...');

        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.close();

        // Закрываем Soniox соединения
        if (sonioxPhone) {
            sonioxPhone.close();
            console.log('[Soniox Phone] ✓ Connection closed');
        }

        if (sonioxOperator) {
            sonioxOperator.close();
            console.log('[Soniox Operator] ✓ Connection closed');
        }

        // Закрываем TTS
        closeTTS();

        // Возвращаем оператора в режим ожидания
        if (operatorWs.readyState === WebSocket.OPEN) {
            operatorWs.send(JSON.stringify({ type: 'status', msg: 'Waiting for a call...' }));
            waitingOperator = operatorWs;
            console.log('[System] ✓ Operator returned to waiting state');
        }
    };

    phoneWs.on('close', closeAll);
    phoneWs.on('error', (err) => {
        console.error('[Phone] ❌ Error:', err.message);
        closeAll();
    });

    operatorWs.on('close', () => {
        console.log('[Operator] Disconnected during call');
        if (sonioxPhone) sonioxPhone.close();
        if (sonioxOperator) sonioxOperator.close();
        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.close();
        closeTTS();
    });
}

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 Translator Bridge running on port ${PORT}`);
    console.log(`📞 Phone endpoint: /call`);
    console.log(`💻 Operator endpoint: /operator`);
});