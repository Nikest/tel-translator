require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
const { translateRuToEn } = require('./translationModule');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
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

    // --- DeepGram Transcription (для тестирования скорости) ---
    const deepgram = createClient(DEEPGRAM_API_KEY);
    let deepgramLive = null;

    // Инициализация DeepGram Live Transcription
    try {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'ru',
            encoding: 'mulaw',
            sample_rate: 8000,
            channels: 1,
            smart_format: true,
            punctuate: true,
            interim_results: true
        });

        deepgramLive.on('open', () => {
            console.log('[DeepGram] ✓ Connected for live transcription');
        });

        deepgramLive.on('Results', async (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && transcript.length > 0) {
                const isFinal = data.is_final;
                const timestamp = new Date().toISOString().substring(11, 23);
                const marker = isFinal ? '✓' : '⋯';
                console.log(`[DeepGram ${timestamp}] ${marker} ${transcript}`);

                // Переводим только финальные результаты
                if (isFinal) {
                    const translatedText = await translateRuToEn(transcript);
                    const translationTimestamp = new Date().toISOString().substring(11, 23);
                    console.log(`[Translation ${translationTimestamp}] EN: ${translatedText}`);
                }
            }
        });

        deepgramLive.on('error', (error) => {
            console.error('[DeepGram] ❌ Error:', error);
        });

        deepgramLive.on('close', () => {
            console.log('[DeepGram] Connection closed');
        });

    } catch (error) {
        console.error('[DeepGram] ❌ Failed to initialize:', error.message);
    }

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
                instructions: `You are a professional SIMULTANEOUS interpreter for real-time call translation.

CONTEXT: Customer (Russian) ↔ Operator (English). You translate Russian to English in REAL-TIME.

CRITICAL REQUIREMENTS:
1. START translating immediately - do NOT wait for complete sentences
2. Translate phrase-by-phrase as you hear it - CONTINUOUS FLOW
3. NEVER pause or stop translating if the speaker continues
4. Keep speaking even if new input arrives - finish your current phrase first
5. Preserve ALL words, names, numbers, addresses EXACTLY
6. Maintain emotional tone and urgency
7. Use natural conversational English for customer service
8. For unclear audio, translate what you can and continue

SPEED: Prioritize low latency over perfect grammar. Natural flow is critical.

OUTPUT: Only the English translation. No meta-commentary.`,
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'pcm16',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.3,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 400
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
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'speaking',
                        speaker: 'client',
                        status: 'started'
                    }));
                }
            }

            if (response.type === 'input_audio_buffer.speech_stopped') {
                console.log('[Phone] 🎤 Stopped speaking');
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'speaking',
                        speaker: 'client',
                        status: 'stopped'
                    }));
                }
            }

            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'client',
                        text: response.transcript,
                        language: 'ru'
                    }));
                }
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
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'ai_translation',
                        text: response.transcript,
                        language: 'en'
                    }));
                }
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
                instructions: `You are a professional SIMULTANEOUS interpreter for real-time call translation.

CONTEXT: Operator (English) ↔ Customer (Russian). You translate English to Russian in REAL-TIME.

CRITICAL REQUIREMENTS:
1. START translating immediately - do NOT wait for complete sentences
2. Translate phrase-by-phrase as you hear it - CONTINUOUS FLOW
3. NEVER pause or stop translating if the speaker continues
4. Keep speaking even if new input arrives - finish your current phrase first
5. Preserve ALL words, names, numbers, addresses EXACTLY
6. Maintain professional, polite tone for customer service
7. Use clear, natural Russian that any customer understands
8. For unclear audio, translate what you can and continue

SPEED: Prioritize low latency over perfect grammar. Natural flow is critical.

OUTPUT: Only the Russian translation. No meta-commentary.`,
                voice: 'echo',
                input_audio_format: 'pcm16',
                output_audio_format: 'g711_ulaw',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.3,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 400
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
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'speaking',
                        speaker: 'operator',
                        status: 'started'
                    }));
                }
            }

            if (response.type === 'input_audio_buffer.speech_stopped') {
                console.log('[Operator] 🎤 Stopped speaking');
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'speaking',
                        speaker: 'operator',
                        status: 'stopped'
                    }));
                }
            }

            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log(`[Operator] 📝 "${response.transcript}"`);
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'operator',
                        text: response.transcript,
                        language: 'en'
                    }));
                }
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
                if (operatorWs.readyState === WebSocket.OPEN) {
                    operatorWs.send(JSON.stringify({
                        type: 'transcript',
                        speaker: 'ai_translation_to_client',
                        text: response.transcript,
                        language: 'ru'
                    }));
                }
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

    // От телефона → OpenAI RU→EN + DeepGram
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

                // Отправка в OpenAI для перевода
                if (ai_RuToEn.readyState === WebSocket.OPEN) {
                    if (ruToEnReady) {
                        ai_RuToEn.send(JSON.stringify(audioData));
                    } else {
                        ruToEnQueue.push(audioData);
                    }
                }

                // Отправка в DeepGram для транскрипции (тестирование)
                if (deepgramLive && msg.media.payload) {
                    try {
                        // Декодируем base64 аудио и отправляем в DeepGram
                        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                        deepgramLive.send(audioBuffer);
                    } catch (e) {
                        console.error('[DeepGram] ❌ Failed to send audio:', e.message);
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

        // Закрываем DeepGram соединение
        if (deepgramLive) {
            try {
                deepgramLive.finish();
                console.log('[DeepGram] ✓ Connection closed');
            } catch (e) {
                console.error('[DeepGram] ❌ Error closing:', e.message);
            }
        }

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