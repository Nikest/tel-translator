require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
const { translateRuToEn, translateEnToRu, initTranslators, closeTranslators } = require('./translationModule');
const { initTTSForOperator, initTTSForPhone, playTTSForOperator, playTTSForPhone, closeTTS } = require('./mainTTS');

const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

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

// --- Translation Session ---
function startTranslationSession(phoneWs, operatorWs) {
    let streamSid = null;

    // --- Инициализация Realtime переводчиков ---
    initTranslators();

    // --- DeepGram Transcription для абонента (RU) ---
    const deepgram = createClient(DEEPGRAM_API_KEY);
    let deepgramPhone = null;
    let deepgramOperator = null;

    // Инициализация DeepGram для Phone (русский)
    try {
        deepgramPhone = deepgram.listen.live({
            model: 'nova-2',
            language: 'ru',
            encoding: 'mulaw',
            sample_rate: 8000,
            channels: 1,
            smart_format: true,
            punctuate: true,
            interim_results: false  // Только финальные результаты
        });

        deepgramPhone.on('open', () => {
            console.log('[DeepGram Phone RU] ✓ Connected for live transcription');
        });

        deepgramPhone.on('Results', async (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && transcript.length > 0 && data.is_final) {
                const timestamp = new Date().toISOString().substring(11, 23);
                console.log(`[DeepGram Phone ${timestamp}] ✓ ${transcript}`);

                // Отправляем транскрипцию оператору (оригинал на русском)
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'client',
                        text: transcript,
                        language: 'ru'
                    }));
                }

                // Переводим RU→EN
                const translatedText = await translateRuToEn(transcript);
                const translationTimestamp = new Date().toISOString().substring(11, 23);
                console.log(`[Translation ${translationTimestamp}] EN: ${translatedText}`);

                // Отправляем перевод оператору
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'ai_translation',
                        text: translatedText,
                        language: 'en'
                    }));
                }

                // Озвучиваем переведенный текст и отправляем оператору
                await playTTSForOperator(translatedText);
            }
        });

        deepgramPhone.on('error', (error) => {
            console.error('[DeepGram Phone] ❌ Error:', error);
        });

        deepgramPhone.on('close', () => {
            console.log('[DeepGram Phone] Connection closed');
        });

    } catch (error) {
        console.error('[DeepGram Phone] ❌ Failed to initialize:', error.message);
    }

    // Инициализация DeepGram для Operator (английский)
    try {
        deepgramOperator = deepgram.listen.live({
            model: 'nova-2',
            language: 'en',
            encoding: 'linear16',
            sample_rate: 24000,
            channels: 1,
            smart_format: true,
            punctuate: true,
            interim_results: false  // Только финальные результаты
        });

        deepgramOperator.on('open', () => {
            console.log('[DeepGram Operator EN] ✓ Connected for live transcription');
        });

        deepgramOperator.on('Results', async (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && transcript.length > 0 && data.is_final) {
                const timestamp = new Date().toISOString().substring(11, 23);
                console.log(`[DeepGram Operator ${timestamp}] ✓ ${transcript}`);

                // Отправляем транскрипцию оператору (что он сам сказал на английском)
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'operator',
                        text: transcript,
                        language: 'en'
                    }));
                }

                // Переводим EN→RU
                const translatedText = await translateEnToRu(transcript);
                const translationTimestamp = new Date().toISOString().substring(11, 23);
                console.log(`[Translation ${translationTimestamp}] RU: ${translatedText}`);

                // Отправляем перевод оператору
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'ai_translation_to_client',
                        text: translatedText,
                        language: 'ru'
                    }));
                }

                // Озвучиваем переведенный текст и отправляем абоненту
                await playTTSForPhone(translatedText);
            }
        });

        deepgramOperator.on('error', (error) => {
            console.error('[DeepGram Operator] ❌ Error:', error);
        });

        deepgramOperator.on('close', () => {
            console.log('[DeepGram Operator] Connection closed');
        });

    } catch (error) {
        console.error('[DeepGram Operator] ❌ Failed to initialize:', error.message);
    }

    // --- Инициализация TTS после получения streamSid ---
    phoneWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Phone] ✓ Stream started: ${streamSid.substring(0, 8)}...`);

                // Инициализируем TTS для абонента
                initTTSForPhone(phoneWs, streamSid);
            }

            if (msg.event === 'media' && deepgramPhone) {
                try {
                    // Декодируем base64 аудио и отправляем в DeepGram
                    const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                    deepgramPhone.send(audioBuffer);
                } catch (e) {
                    console.error('[DeepGram Phone] ❌ Failed to send audio:', e.message);
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

    // От оператора → DeepGram
    operatorWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.type === 'audio' && deepgramOperator) {
                try {
                    // Декодируем base64 PCM16 и отправляем в DeepGram
                    const audioBuffer = Buffer.from(msg.payload, 'base64');
                    deepgramOperator.send(audioBuffer);
                } catch (e) {
                    console.error('[DeepGram Operator] ❌ Failed to send audio:', e.message);
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

        // Закрываем DeepGram соединения
        if (deepgramPhone) {
            try {
                deepgramPhone.finish();
                console.log('[DeepGram Phone] ✓ Connection closed');
            } catch (e) {
                console.error('[DeepGram Phone] ❌ Error closing:', e.message);
            }
        }

        if (deepgramOperator) {
            try {
                deepgramOperator.finish();
                console.log('[DeepGram Operator] ✓ Connection closed');
            } catch (e) {
                console.error('[DeepGram Operator] ❌ Error closing:', e.message);
            }
        }

        // Закрываем Realtime переводчики
        closeTranslators();

        // Закрываем TTS
        closeTTS();

        // Возвращаем оператора в режим ожидания (не закрываем его соединение!)
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
        if (deepgramPhone) deepgramPhone.finish();
        if (deepgramOperator) deepgramOperator.finish();
        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.close();
        closeTranslators();
        closeTTS();
    });
}

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 Translator Bridge running on port ${PORT}`);
    console.log(`📞 Phone endpoint: /call`);
    console.log(`💻 Operator endpoint: /operator`);
});
