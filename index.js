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
    // ВАЖНО: Переменная для хранения параметров, если OpenAI еще не готов
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
                    silence_duration_ms: 600,
                    create_response: true
                }
            }
        };
        openAiWs.send(JSON.stringify(sessionConfig));
        console.log(`[OpenAI] Session updated: ${originLang} <-> ${translatingLang}`);
    };

    openAiWs.on('open', () => {
        console.log('[OpenAI] Connected to Model');
        // ВАЖНО: Если параметры уже ждут, отправляем их сразу после подключения
        if (pendingSessionParams) {
            sendSessionUpdate(pendingSessionParams.originLang, pendingSessionParams.translatingLang);
            pendingSessionParams = null; // Очищаем
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
                console.log('[Interruption] User started speaking');
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

                    // ВАЖНО: Проверяем статус подключения
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        sendSessionUpdate(originLang, translatingLang);
                    } else {
                        // Если еще не подключились, сохраняем на будущее
                        console.log('[SignalWire] OpenAI connecting... parameters queued.');
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
                    console.log(`[SignalWire] Stream Stopped: ${streamSid}`);
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