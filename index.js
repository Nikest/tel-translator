require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Translator Bot is running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (connection) => {
    console.log('[SignalWire] Client connected');

    let streamSid = null;
    let openAiWs = null;
    let sessionReady = false;
    let audioQueue = [];
    let pendingSessionParams = null;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
        console.error('Missing OPENAI_API_KEY in env');
        connection.close();
        return;
    }

    openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    const sendSessionUpdate = (originLang, translatingLang) => {
        const sessionConfig = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: `You are a professional real-time translator. 
Your task is to translate conversation between ${originLang} and ${translatingLang}.
1. If you hear ${originLang}, translate it to ${translatingLang} and speak.
2. If you hear ${translatingLang}, translate it to ${originLang} and speak.
3. Keep your voice neutral. Do not add conversational fillers. Just translate.`,
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 600
                }
            }
        };
        openAiWs.send(JSON.stringify(sessionConfig));
        console.log(`[OpenAI] Session update sent: ${originLang} <-> ${translatingLang}`);
    };

    openAiWs.on('open', () => {
        console.log('[OpenAI] Connected to Model');

        // Отправляем конфигурацию сразу после подключения
        if (pendingSessionParams) {
            sendSessionUpdate(pendingSessionParams.originLang, pendingSessionParams.translatingLang);
            pendingSessionParams = null;
        } else {
            // Дефолтная конфигурация, если параметры еще не пришли
            sendSessionUpdate('Russian', 'English');
        }
    });

    openAiWs.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            // Сессия готова - можно отправлять аудио
            if (response.type === 'session.updated') {
                sessionReady = true;
                console.log('[OpenAI] Session ready');

                // Отправляем накопленное аудио из очереди
                if (audioQueue.length > 0) {
                    console.log(`[OpenAI] Sending ${audioQueue.length} queued audio chunks`);
                    audioQueue.forEach(audioData => {
                        openAiWs.send(JSON.stringify(audioData));
                    });
                    audioQueue = [];
                }
            }

            // Отправка переведенного аудио обратно в SignalWire
            if (response.type === 'response.audio.delta' && response.delta) {
                const msg = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                };
                connection.send(JSON.stringify(msg));
            }

            // Обработка прерывания (пользователь начал говорить)
            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[Interruption] User started speaking');
                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));
                openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            }

            // Логирование ошибок от OpenAI
            if (response.type === 'error') {
                console.error('[OpenAI] Error response:', response.error);
            }
        } catch (e) {
            console.error('[OpenAI] Error processing message:', e);
        }
    });

    openAiWs.on('error', (error) => {
        console.error('[OpenAI] WebSocket error:', error);
    });

    openAiWs.on('close', (code, reason) => {
        console.log(`[OpenAI] Connection closed (code: ${code}, reason: ${reason})`);
        // Закрываем SignalWire соединение, если OpenAI отключился
        if (connection.readyState === WebSocket.OPEN) {
            connection.close();
        }
    });

    connection.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    streamSid = msg.start.streamSid;
                    console.log(`[SignalWire] Stream Started: ${streamSid}`);

                    // Извлекаем параметры из разных возможных мест
                    const params = msg.start.customParameters || msg.start.parameters || {};
                    const originLang = params.originLang || 'Russian';
                    const translatingLang = params.translatingLang || 'English';

                    console.log('[SignalWire] Parameters:', { originLang, translatingLang });

                    // Проверяем статус подключения OpenAI
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        sendSessionUpdate(originLang, translatingLang);
                    } else if (openAiWs.readyState === WebSocket.CONNECTING) {
                        // Если еще подключается, сохраняем параметры
                        console.log('[SignalWire] OpenAI connecting... parameters queued.');
                        pendingSessionParams = { originLang, translatingLang };
                    } else {
                        console.error('[SignalWire] OpenAI connection failed');
                        connection.close();
                    }
                    break;

                case 'media':
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        const audioAppend = {
                            type: 'input_audio_buffer.append',
                            audio: msg.media.payload
                        };

                        // Если сессия готова, отправляем сразу
                        if (sessionReady) {
                            openAiWs.send(JSON.stringify(audioAppend));
                        } else {
                            // Иначе добавляем в очередь
                            audioQueue.push(audioAppend);
                        }
                    }
                    break;

                case 'stop':
                    console.log(`[SignalWire] Stream Stopped: ${streamSid}`);
                    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.close();
                    }
                    break;

                default:
                    // Логируем неожиданные события для отладки
                    console.log(`[SignalWire] Unhandled event: ${msg.event}`);
            }
        } catch (e) {
            console.error('[SignalWire] Message error:', e);
        }
    });

    connection.on('close', () => {
        console.log('[SignalWire] Client disconnected');
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.close();
        }
    });

    connection.on('error', (error) => {
        console.error('[SignalWire] WebSocket error:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Translator Bot listening on port ${PORT}`);
});