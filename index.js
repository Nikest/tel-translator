require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4o-realtime-preview-2024-12-17';

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

    // Состояние для RU→EN
    let ruToEnReady = false;
    let ruToEnQueue = [];

    // Состояние для EN→RU
    let enToRuReady = false;
    let enToRuQueue = [];

    // --- OpenAI: Russian → English (для оператора) ---
    const ai_RuToEn = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`, {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    // --- OpenAI: English → Russian (для абонента) ---
    const ai_EnToRu = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`, {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    // =====================
    // RU → EN (Phone → Operator)
    // =====================
    ai_RuToEn.on('open', () => {
        console.log('[OpenAI RU→EN] ✓ Connected');

        const config = {
            type: 'session.update',
            session: {
                modalities: ['audio', 'text'],
                instructions: 'You are a real-time interpreter. Translate Russian speech to English. Output only the English translation, nothing else. No commentary, no explanations.',
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'pcm16',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 200
                },
                input_audio_transcription: {
                    model: 'whisper-1'
                },
                temperature: 0.6
            }
        };
        ai_RuToEn.send(JSON.stringify(config));
    });

    ai_RuToEn.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            if (response.type === 'session.updated') {
                ruToEnReady = true;
                console.log('[OpenAI RU→EN] ✓ Session ready');

                // Отправляем накопленную очередь
                if (ruToEnQueue.length > 0) {
                    console.log(`[OpenAI RU→EN] → Flushing ${ruToEnQueue.length} queued chunks`);
                    ruToEnQueue.forEach(audio => ai_RuToEn.send(JSON.stringify(audio)));
                    ruToEnQueue = [];
                }
            }

            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[Phone] 🎤 Speaking...');
            }

            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log(`[Phone] 📝 "${response.transcript}"`);
            }

            if (response.type === 'response.audio.delta' && response.delta) {
                // Отправляем PCM16 аудио оператору
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'audio',
                        payload: response.delta
                    }));
                }
            }

            if (response.type === 'response.audio_transcript.done') {
                console.log(`[AI→Operator] 🔊 "${response.transcript}"`);
            }

            if (response.type === 'error') {
                if (response.error?.code !== 'input_audio_buffer_commit_empty') {
                    console.error('[OpenAI RU→EN] ❌', response.error?.message);
                }
            }

        } catch (e) {
            console.error('[OpenAI RU→EN] ❌ Parse error:', e.message);
        }
    });

    ai_RuToEn.on('error', (e) => console.error('[OpenAI RU→EN] ❌ WS Error:', e.message));
    ai_RuToEn.on('close', () => console.log('[OpenAI RU→EN] Connection closed'));

    // =====================
    // EN → RU (Operator → Phone)
    // =====================
    ai_EnToRu.on('open', () => {
        console.log('[OpenAI EN→RU] ✓ Connected');

        const config = {
            type: 'session.update',
            session: {
                modalities: ['audio', 'text'],
                instructions: 'You are a real-time interpreter. Translate English speech to Russian. Output only the Russian translation, nothing else. No commentary, no explanations.',
                voice: 'echo',
                input_audio_format: 'pcm16',
                output_audio_format: 'g711_ulaw',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 200
                },
                input_audio_transcription: {
                    model: 'whisper-1'
                },
                temperature: 0.6
            }
        };
        ai_EnToRu.send(JSON.stringify(config));
    });

    ai_EnToRu.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            if (response.type === 'session.updated') {
                enToRuReady = true;
                console.log('[OpenAI EN→RU] ✓ Session ready');

                // Отправляем накопленную очередь
                if (enToRuQueue.length > 0) {
                    console.log(`[OpenAI EN→RU] → Flushing ${enToRuQueue.length} queued chunks`);
                    enToRuQueue.forEach(audio => ai_EnToRu.send(JSON.stringify(audio)));
                    enToRuQueue = [];
                }
            }

            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[Operator] 🎤 Speaking...');
            }

            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log(`[Operator] 📝 "${response.transcript}"`);
            }

            if (response.type === 'response.audio.delta' && response.delta) {
                // Отправляем G.711 аудио на телефон
                if (streamSid && phoneWs.readyState === WebSocket.OPEN) {
                    phoneWs.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    }));
                }
            }

            if (response.type === 'response.audio_transcript.done') {
                console.log(`[AI→Phone] 🔊 "${response.transcript}"`);
            }

            if (response.type === 'error') {
                if (response.error?.code !== 'input_audio_buffer_commit_empty') {
                    console.error('[OpenAI EN→RU] ❌', response.error?.message);
                }
            }

        } catch (e) {
            console.error('[OpenAI EN→RU] ❌ Parse error:', e.message);
        }
    });

    ai_EnToRu.on('error', (e) => console.error('[OpenAI EN→RU] ❌ WS Error:', e.message));
    ai_EnToRu.on('close', () => console.log('[OpenAI EN→RU] Connection closed'));

    // =====================
    // Маршрутизация аудио
    // =====================

    // От телефона → OpenAI RU→EN
    phoneWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Phone] ✓ Stream started: ${streamSid.substring(0, 8)}...`);
            }

            if (msg.event === 'media') {
                const audioData = {
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload
                };

                if (ai_RuToEn.readyState === WebSocket.OPEN) {
                    if (ruToEnReady) {
                        ai_RuToEn.send(JSON.stringify(audioData));
                    } else {
                        ruToEnQueue.push(audioData);
                    }
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

    // От оператора → OpenAI EN→RU
    operatorWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.type === 'audio') {
                const audioData = {
                    type: 'input_audio_buffer.append',
                    audio: msg.payload
                };

                if (ai_EnToRu.readyState === WebSocket.OPEN) {
                    if (enToRuReady) {
                        ai_EnToRu.send(JSON.stringify(audioData));
                    } else {
                        enToRuQueue.push(audioData);
                    }
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

        if (ai_RuToEn.readyState === WebSocket.OPEN) ai_RuToEn.close();
        if (ai_EnToRu.readyState === WebSocket.OPEN) ai_EnToRu.close();
        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.close();

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
        if (ai_RuToEn.readyState === WebSocket.OPEN) ai_RuToEn.close();
        if (ai_EnToRu.readyState === WebSocket.OPEN) ai_EnToRu.close();
        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.close();
    });
}

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 Translator Bridge running on port ${PORT}`);
    console.log(`📞 Phone endpoint: /call`);
    console.log(`💻 Operator endpoint: /operator`);
    console.log(`🔗 Model: ${OPENAI_MODEL}`);
});