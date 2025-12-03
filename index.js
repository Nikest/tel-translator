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
3. Keep your voice neutral. Do not add conversational fillers. Just translate.
4. IMPORTANT: Always respond immediately after hearing speech.`,
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 800
                },
                temperature: 0.8,
                max_response_output_tokens: 4096
            }
        };
        openAiWs.send(JSON.stringify(sessionConfig));
        console.log(`[OpenAI] Session update sent: ${originLang} <-> ${translatingLang}`);
    };

    openAiWs.on('open', () => {
        console.log('[OpenAI] Connected to Model');

        if (pendingSessionParams) {
            sendSessionUpdate(pendingSessionParams.originLang, pendingSessionParams.translatingLang);
            pendingSessionParams = null;
        } else {
            sendSessionUpdate('Russian', 'English');
        }
    });

    openAiWs.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            // Логируем все события для отладки
            console.log('[OpenAI] Event:', response.type);

            // Сессия готова
            if (response.type === 'session.updated') {
                sessionReady = true;
                console.log('[OpenAI] Session ready');

                if (audioQueue.length > 0) {
                    console.log(`[OpenAI] Sending ${audioQueue.length} queued audio chunks`);
                    audioQueue.forEach(audioData => {
                        openAiWs.send(JSON.stringify(audioData));
                    });
                    audioQueue = [];
                }
            }

            // Пользователь начал говорить
            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[OpenAI] Speech started');
            }

            // Пользователь закончил говорить - коммитим буфер
            if (response.type === 'input_audio_buffer.speech_stopped') {
                console.log('[OpenAI] Speech stopped - committing buffer');
                openAiWs.send(JSON.stringify({
                    type: 'input_audio_buffer.commit'
                }));
            }

            // Буфер закоммичен - запрашиваем ответ
            if (response.type === 'input_audio_buffer.committed') {
                console.log('[OpenAI] Buffer committed - creating response');
                openAiWs.send(JSON.stringify({
                    type: 'response.create',
                    response: {
                        modalities: ['text', 'audio'],
                        instructions: 'Translate the speech you just heard and respond in audio format.'
                    }
                }));
            }

            // Получаем чанки переведенного аудио
            if (response.type === 'response.audio.delta' && response.delta) {
                console.log('[OpenAI] Audio delta received, length:', response.delta.length);
                const msg = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                };
                connection.send(JSON.stringify(msg));
            }

            // Ответ завершен
            if (response.type === 'response.audio.done') {
                console.log('[OpenAI] Audio response completed');
            }

            // Обработка прерывания (пользователь начал говорить во время ответа)
            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[Interruption] User interrupted - clearing output');
                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));
                openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            }

            // Транскрипция (для отладки)
            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log('[OpenAI] Transcription:', response.transcript);
            }

            // Логирование ошибок от OpenAI
            if (response.type === 'error') {
                console.error('[OpenAI] Error response:', JSON.stringify(response.error));
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
                    console.log('[SignalWire] Full start message:', JSON.stringify(msg.start, null, 2));

                    const params = msg.start.customParameters || msg.start.parameters || {};
                    const originLang = params.originLang || 'Russian';
                    const translatingLang = params.translatingLang || 'English';

                    console.log('[SignalWire] Parameters:', { originLang, translatingLang });

                    if (openAiWs.readyState === WebSocket.OPEN) {
                        sendSessionUpdate(originLang, translatingLang);
                    } else if (openAiWs.readyState === WebSocket.CONNECTING) {
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

                        if (sessionReady) {
                            openAiWs.send(JSON.stringify(audioAppend));
                        } else {
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
                    console.log(`[SignalWire] Event: ${msg.event}`);
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