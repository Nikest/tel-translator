require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { initTTSForPhone, playTTSForPhone, closeTTS } = require('./mainTTS');

const PORT = process.env.PORT || 8080;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

// Доступные языки для оператора
const OPERATOR_LANGUAGES = [
    { code: 'en', name: 'English', flag: '\u{1F1EC}\u{1F1E7}' },
    { code: 'ru', name: 'Russian', flag: '\u{1F1F7}\u{1F1FA}' },
    { code: 'de', name: 'German', flag: '\u{1F1E9}\u{1F1EA}' },
    { code: 'fr', name: 'French', flag: '\u{1F1EB}\u{1F1F7}' },
    { code: 'it', name: 'Italian', flag: '\u{1F1EE}\u{1F1F9}' },
    { code: 'es', name: 'Spanish', flag: '\u{1F1EA}\u{1F1F8}' },
    { code: 'pl', name: 'Polish', flag: '\u{1F1F5}\u{1F1F1}' },
    { code: 'ro', name: 'Romanian', flag: '\u{1F1F7}\u{1F1F4}' }
];

let waitingOperator = null;

// --- CORS Helper ---
const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3001', 'http://localhost:4000'];

function setCORSHeaders(res, req) {
    const origin = req.headers.origin;
    if (CORS_ALLOWED_ORIGINS.includes('*') || CORS_ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        setCORSHeaders(res, req);
        res.writeHead(204);
        res.end();
        return;
    }

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
    } else if (req.method === 'GET' && req.url === '/api/settings') {
        setCORSHeaders(res, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ operatorLanguages: OPERATOR_LANGUAGES }));
    } else {
        res.writeHead(200);
        res.end('Translator Bridge Running');
    }
});

// --- WebSocket Server ---
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const parsed = url.parse(request.url, true);
    const pathname = parsed.pathname;

    if (pathname === '/call') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.clientType = 'phone';
            wss.emit('connection', ws, request);
        });
    } else if (pathname === '/operator') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.clientType = 'operator';
            ws.operatorLanguage = parsed.query.lang || 'en';
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    // --- Оператор подключился ---
    if (ws.clientType === 'operator') {
        console.log(`[Operator] ✓ Connected via browser (language: ${ws.operatorLanguage})`);
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

    // Сброс таймера буфера (уменьшено с 1500мс до 800мс)
    const resetFlushTimer = () => {
        if (flushTimeout) clearTimeout(flushTimeout);
        // Отправляем буфер через 800мс тишины (было 1500мс)
        flushTimeout = setTimeout(flushBuffer, 800);
    };

    ws.on('open', () => {
        console.log(`[Soniox ${config.name}] ✓ Connected`);

        // Базовая конфигурация (оптимизировано для низкой латентности)
        const configMessage = {
            api_key: SONIOX_API_KEY,
            model: 'stt-rt-preview',
            audio_format: config.audioFormat,
            sample_rate: config.sampleRate,
            num_channels: 1,
            enable_endpoint_detection: true,
            // Ускоряем финализацию токенов (по умолчанию может быть до 9000мс)
            max_non_final_tokens_duration_ms: 1000,
            translation: {
                type: 'one_way',
                target_language: config.targetLanguage
            }
        };

        // Авто-определение языка или фиксированный язык
        if (config.autoDetect) {
            configMessage.enable_language_identification = true;
        } else {
            configMessage.language_hints = [config.sourceLanguage];
            configMessage.language_hints_strict = true;
        }

        ws.send(JSON.stringify(configMessage));
        isConfigured = true;

        const sourceDesc = config.autoDetect ? 'auto-detect' : config.sourceLanguage;
        console.log(`[Soniox ${config.name}] ✓ Configured: ${sourceDesc} → ${config.targetLanguage} (low-latency mode)`);
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

                    // Отслеживаем определённый язык абонента (из original-токенов)
                    if (config.autoDetect && token.is_final && token.translation_status === 'original' && token.language) {
                        if (config.onLanguageDetected) {
                            config.onLanguageDetected(token.language);
                        }
                    }
                }

                // Сбрасываем таймер при получении токенов
                if (translationBuffer.length > 0) {
                    resetFlushTimer();
                }

                // Проверяем наличие <end> токена - сигнал endpoint detection
                const hasEndToken = response.tokens.some(t => t.text === '<end>' && t.is_final);

                // Проверяем, есть ли конец предложения в буфере
                const hasSentenceEnd = /[.!?。？！]\s*$/.test(translationBuffer);

                // Отправляем если есть конец предложения или endpoint
                if ((hasSentenceEnd || hasEndToken) && translationBuffer.trim().length > 0) {
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

    const operatorLang = operatorWs.operatorLanguage || 'en';
    // Язык абонента определяется автоматически через Soniox
    let detectedCallerLanguage = null;

    console.log(`[Session] Operator language: ${operatorLang}, Caller language: auto-detect`);

    // --- Soniox для Phone (auto-detect → operator language) ---
    sonioxPhone = createSonioxConnection(
        {
            name: `Phone ?→${operatorLang.toUpperCase()}`,
            audioFormat: 'mulaw',
            sampleRate: 8000,
            autoDetect: true,
            targetLanguage: operatorLang,
            onLanguageDetected: (lang) => {
                if (lang && lang !== detectedCallerLanguage) {
                    detectedCallerLanguage = lang;
                    console.log(`[Session] Caller language detected: ${lang}`);

                    // Уведомляем оператора об определённом языке
                    if (operatorWs.readyState === WebSocket.OPEN) {
                        operatorWs.send(JSON.stringify({
                            type: 'caller_language',
                            language: lang
                        }));
                    }

                    // Пересоздаём Soniox для оператора с нужным целевым языком,
                    // если он ещё не настроен на этот язык
                    recreateOperatorSoniox(lang);
                }
            }
        },
        async (translatedText) => {
            // Отправляем перевод оператору (текст)
            if (operatorWs.readyState === WebSocket.OPEN) {
                operatorWs.send(JSON.stringify({
                    type: 'transcript',
                    speaker: 'client',
                    text: translatedText,
                    language: operatorLang
                }));
            }
        },
        (error) => {
            console.error('[Phone Translation] Error:', error);
        }
    );

    // Функция создания/пересоздания Soniox для оператора
    let operatorSonioxTargetLang = null;

    function recreateOperatorSoniox(callerLang) {
        // Не пересоздаём если целевой язык тот же
        if (operatorSonioxTargetLang === callerLang) return;
        // Если язык абонента совпадает с языком оператора — перевод не нужен,
        // но мы всё равно создаём для транскрипции
        operatorSonioxTargetLang = callerLang;

        // Закрываем предыдущее соединение
        if (sonioxOperator) {
            sonioxOperator.close();
            console.log(`[Soniox Operator] Reconnecting: ${operatorLang} → ${callerLang}`);
        }

        sonioxOperator = createSonioxConnection(
            {
                name: `Operator ${operatorLang.toUpperCase()}→${callerLang.toUpperCase()}`,
                audioFormat: 'pcm_s16le',
                sampleRate: 24000,
                sourceLanguage: operatorLang,
                targetLanguage: callerLang
            },
            async (translatedText) => {
                // Отправляем перевод оператору (что будет сказано абоненту)
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'operator_translated',
                        text: translatedText,
                        language: callerLang
                    }));
                }

                // Озвучиваем для абонента на его языке
                await playTTSForPhone(translatedText);
            },
            (error) => {
                console.error('[Operator Translation] Error:', error);
            }
        );
    }

    // --- Обработка сообщений от Phone (SignalWire) ---
    phoneWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;

                // Инициализируем TTS для абонента (без фиксированного языка — он определится позже)
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