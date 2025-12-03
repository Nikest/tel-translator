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
    let isResponseActive = false; // Флаг активного ответа от OpenAI

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
                instructions: `You are a helpful assistant that translates between ${originLang} and ${translatingLang}. 
Listen to what the user says and translate it to the other language. Always respond with audio.`,
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 500,
                    silence_duration_ms: 1200
                },
                input_audio_transcription: {
                    model: 'whisper-1'
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

                // ВАЖНО: Прерываем только если идет активный ответ
                if (isResponseActive) {
                    console.log('[Interruption] User interrupted during response - clearing');
                    connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                    }));
                    openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
                    isResponseActive = false;
                }
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
                        modalities: ['audio'],
                        instructions: 'Translate what you heard and respond in audio.'
                    }
                }));
            }

            // Начался ответ от AI
            if (response.type === 'response.audio_transcript.delta' ||
                response.type === 'response.audio.delta') {
                isResponseActive = true;
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
                isResponseActive = false;
            }

            if (response.type === 'response.done') {
                console.log('[OpenAI] Full response done');
                isResponseActive = false;
            }

            // Транскрипция входящего аудио (для отладки)
            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log('[OpenAI] 🎤 User said:', response.transcript);
            }

            // Текст ответа AI (для отладки)
            if (response.type === 'response.output_item.added') {
                console.log('[OpenAI] 💬 Response item added:', JSON.stringify(response.item));
            }

            if (response.type === 'response.content_part.added') {
                console.log('[OpenAI] 📝 Content part added:', JSON.stringify(response.part));
            }

            if (response.type === 'response.audio_transcript.delta') {
                console.log('[OpenAI] 🔊 Audio transcript delta:', response.delta);
            }

            if (response.type === 'response.audio_transcript.done') {
                console.log('[OpenAI] ✅ AI translated:', response.transcript);
            }

            // Логирование ошибок от OpenAI
            if (response.type === 'error') {
                console.error('[OpenAI] Error:', JSON.stringify(response.error));
                // Если ошибка связана с пустым буфером, игнорируем - это нормально при прерывании
                if (response.error.code !== 'input_audio_buffer_commit_empty') {
                    console.error('[OpenAI] Critical error, may need attention');
                }
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

                    const params = msg.start.customParameters || msg.start.parameters || {};
                    const originLang = params.originLang || 'Russian';
                    const translatingLang = params.translatingLang || 'English';

                    console.log('[SignalWire] Translation:', `${originLang} <-> ${translatingLang}`);

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

                case 'connected':
                    console.log('[SignalWire] Connection confirmed');
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