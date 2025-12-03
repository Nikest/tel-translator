require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url'); // Подключаем модуль для разбора URL

const PORT = process.env.PORT || 8080;

// HTTP сервер (для health-check и обработки upgrade)
const server = http.createServer((req, res) => {
    // Простой ответ для корня, чтобы знать, что сервер жив
    if (req.method === 'GET') {
        res.writeHead(200);
        res.end('Translator Bot is online');
    }
});

// Создаем WS сервер в режиме "noServer" (без автоматической привязки)
const wss = new WebSocket.Server({ noServer: true });

// Ручная обработка подключения (Handshake)
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    // ПРОВЕРКА РОУТА: принимаем только если путь /call
    if (pathname === '/call') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        // Если стучатся на /streams или корень - разрываем соединение
        console.log(`[Access Denied] Connection attempt on invalid route: ${pathname}`);
        socket.destroy();
    }
});

wss.on('connection', (connection) => {
    console.log('[SignalWire] Client connected to /call');

    let streamSid = null;
    let openAiWs = null;
    let pendingSessionParams = null; // Буфер для параметров

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
        console.log(`[OpenAI] Session updated: ${originLang} <-> ${translatingLang}`);
    };

    openAiWs.on('open', () => {
        console.log('[OpenAI] Connected to Model');
        if (pendingSessionParams) {
            sendSessionUpdate(pendingSessionParams.originLang, pendingSessionParams.translatingLang);
            pendingSessionParams = null;
        }
    });

    openAiWs.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            if (response.type === 'response.audio.delta' && response.delta) {
                const msg = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                };
                connection.send(JSON.stringify(msg));
            }

            if (response.type === 'input_audio_buffer.speech_started') {
                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));
                openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            }
        } catch (e) {
            console.error('[OpenAI] Error processing message:', e);
        }
    });

    openAiWs.on('error', (error) => {
        console.error('[OpenAI] Error:', error);
    });

    connection.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    streamSid = msg.start.streamSid;
                    console.log(`[SignalWire] Stream Started: ${streamSid}`);

                    const params = msg.start.customParameters || {};
                    const originLang = params.originLang || 'Russian';
                    const translatingLang = params.translatingLang || 'English';

                    if (openAiWs.readyState === WebSocket.OPEN) {
                        sendSessionUpdate(originLang, translatingLang);
                    } else {
                        pendingSessionParams = { originLang, translatingLang };
                    }
                    break;

                case 'media':
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        const audioAppend = {
                            type: 'input_audio_buffer.append',
                            audio: msg.media.payload
                        };
                        openAiWs.send(JSON.stringify(audioAppend));
                    }
                    break;

                case 'stop':
                    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
                    break;
            }
        } catch (e) {
            console.error('[SignalWire] Message error:', e);
        }
    });

    connection.on('close', () => {
        console.log('[SignalWire] Client disconnected');
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});