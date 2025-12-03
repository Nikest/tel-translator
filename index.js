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

    openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    const sendSessionUpdate = (originLang, translatingLang) => {
        const sessionConfig = {
            type: 'session.update',
            session: {
                modalities: ['audio', 'text'],
                // Короткие инструкции = быстрее обработка
                instructions: `Simultaneous interpreter: ${originLang} ↔ ${translatingLang}. Translate everything immediately. If you hear ${originLang}, output ${translatingLang}. If you hear ${translatingLang}, output ${originLang}. Audio only, no commentary.`,
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.4,           // чуть чувствительнее (было 0.5)
                    prefix_padding_ms: 150,   // меньше буфера перед речью (было 300)
                    silence_duration_ms: 150  // быстрее реагируем на паузы (было 500)
                },
                input_audio_transcription: {
                    model: 'whisper-1'
                },
                temperature: 0.5  // меньше = быстрее и стабильнее (было 0.8)
            }
        };
        openAiWs.send(JSON.stringify(sessionConfig));
        console.log(`[OpenAI] Session configured: ${originLang} ⟷ ${translatingLang}`);
    };

    openAiWs.on('open', () => {
        console.log('[OpenAI] ✓ Connected to Realtime API');

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

            if (response.type === 'session.updated') {
                sessionReady = true;
                console.log('[OpenAI] ✓ Session ready');

                if (audioQueue.length > 0) {
                    console.log(`[OpenAI] → Sending ${audioQueue.length} queued audio chunks`);
                    audioQueue.forEach(audioData => {
                        openAiWs.send(JSON.stringify(audioData));
                    });
                    audioQueue = [];
                }
            }

            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[User] 🎤 Speech started');
            }

            if (response.type === 'input_audio_buffer.speech_stopped') {
                console.log('[User] 🎤 Speech stopped');
            }

            if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log(`[User] 📝 "${response.transcript}"`);
            }

            if (response.type === 'response.created') {
                console.log('[AI] 🤖 Translating...');
            }

            // Отправляем аудио сразу как получаем
            if (response.type === 'response.audio.delta' && response.delta) {
                const msg = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                };
                connection.send(JSON.stringify(msg));
            }

            if (response.type === 'response.audio_transcript.done') {
                console.log(`[AI] ✅ "${response.transcript}"`);
            }

            if (response.type === 'response.done') {
                const hasAudio = response.response?.output?.some(
                    item => item.type === 'audio'
                );
                if (!hasAudio) {
                    console.log('[AI] ⚠️ No audio in response');
                }
            }

            if (response.type === 'error') {
                if (response.error.code === 'input_audio_buffer_commit_empty') {
                    return;
                }
                console.error('[OpenAI] ❌ Error:', response.error.message);
            }

        } catch (e) {
            console.error('[OpenAI] ❌ Processing error:', e);
        }
    });

    openAiWs.on('error', (error) => {
        console.error('[OpenAI] ❌ WebSocket error:', error);
    });

    openAiWs.on('close', (code, reason) => {
        console.log(`[OpenAI] Connection closed (${code}${reason ? ': ' + reason : ''})`);
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
                    console.log(`[SignalWire] ✓ Stream started: ${streamSid.substring(0, 8)}...`);

                    const params = msg.start.customParameters || msg.start.parameters || {};
                    const originLang = params.originLang || 'Russian';
                    const translatingLang = params.translatingLang || 'English';

                    console.log(`[SignalWire] Languages: ${originLang} ⟷ ${translatingLang}`);

                    if (openAiWs.readyState === WebSocket.OPEN) {
                        sendSessionUpdate(originLang, translatingLang);
                    } else if (openAiWs.readyState === WebSocket.CONNECTING) {
                        pendingSessionParams = { originLang, translatingLang };
                    } else {
                        console.error('[SignalWire] ❌ OpenAI not connected');
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
                    console.log('[SignalWire] Stream stopped');
                    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.close();
                    }
                    break;

                case 'connected':
                    console.log('[SignalWire] ✓ Connection confirmed');
                    break;
            }
        } catch (e) {
            console.error('[SignalWire] ❌ Message error:', e);
        }
    });

    connection.on('close', () => {
        console.log('[SignalWire] Client disconnected');
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.close();
        }
    });

    connection.on('error', (error) => {
        console.error('[SignalWire] ❌ WebSocket error:', error);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Translator Bot listening on port ${PORT}`);
    console.log(`📞 Ready for low-latency translation`);
});