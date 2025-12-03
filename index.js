require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ==============================================================================
// CONFIGURATION & TUNING
// ==============================================================================
// 1. Half-Duplex Mode: The most robust fix for PSTN Echo.
//    If true, the bot ignores ALL user input while it is speaking.
//    This effectively functions as a software Echo Suppressor.
const ENFORCE_HALF_DUPLEX = true;

// 2. VAD Sensitivity:
//    0.5 is default. 0.6 or 0.7 makes it harder for echo to trigger interruption.
const VAD_THRESHOLD = 0.6;

// 3. Echo Debounce:
//    Time (ms) to keep the mic closed AFTER the AI finishes sending audio.
//    This accounts for network traversal time (Node -> SignalWire -> Phone).
//    Echo can arrive 200-500ms after the server finishes sending.
const ECHO_DEBOUNCE_MS = 500;
// ==============================================================================

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Translator Bot is running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (connection) => {
    console.log(' Client connected');

    let streamSid = null;
    let openAiWs = null;
    let pendingSessionParams = null;

    // STATE MACHINE FOR ECHO PREVENTION
    let isAiSpeaking = false;
    let debounceTimer = null;

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
                    // TUNING: Increasing threshold to ignore low-volume echo
                    threshold: VAD_THRESHOLD,
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

            // -----------------------------------------------------------------
            // EVENT: AI SENDING AUDIO (Start of Echo Risk)
            // -----------------------------------------------------------------
            if (response.type === 'response.audio.delta' && response.delta) {
                // Lock the gate immediately
                isAiSpeaking = true;

                // Clear any pending unlock timer (if we started speaking again quickly)
                if (debounceTimer) clearTimeout(debounceTimer);

                const msg = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                };
                connection.send(JSON.stringify(msg));
            }

            // -----------------------------------------------------------------
            // EVENT: AI FINISHED SENDING (End of Echo Risk + Latency)
            // -----------------------------------------------------------------
            if (response.type === 'response.audio.done') {
                // We do NOT unlock immediately. We wait for the audio to travel
                // to the phone, play out, and potential echo to return.
                debounceTimer = setTimeout(() => {
                    isAiSpeaking = false;
                    console.log(' Mic Unlocked (Echo Debounce Complete)');
                }, ECHO_DEBOUNCE_MS);
            }

            // -----------------------------------------------------------------
            // EVENT: INTERRUPTION DETECTED
            // -----------------------------------------------------------------
            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('[Interruption] OpenAI detected speech');

                // GATE CHECK: If we are speaking, this is likely ECHO.
                if (ENFORCE_HALF_DUPLEX && isAiSpeaking) {
                    console.log('[Interruption] BLOCKED: AI is currently speaking. Ignoring VAD trigger.');
                    return;
                }

                // If valid interruption (AI not speaking):
                console.log('[Interruption] VALID. Clearing buffer and cancelling.');
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
                    console.log(` Stream Started: ${streamSid}`);
                    const params = msg.start.customParameters || {};
                    const originLang = params.originLang || 'Russian';
                    const translatingLang = params.translatingLang || 'English';

                    if (openAiWs.readyState === WebSocket.OPEN) {
                        sendSessionUpdate(originLang, translatingLang);
                    } else {
                        console.log(' OpenAI connecting... parameters queued.');
                        pendingSessionParams = { originLang, translatingLang };
                    }
                    break;

                case 'media':
                    // -----------------------------------------------------------------
                    // CRITICAL FIX: THE ECHO GATE
                    // -----------------------------------------------------------------
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        // If Half-Duplex is on and AI is speaking, we DROP the packet.
                        // We do not send it to OpenAI.
                        // This prevents OpenAI from hearing the echo.
                        if (ENFORCE_HALF_DUPLEX && isAiSpeaking) {
                            // Packet dropped.
                            return;
                        }

                        const audioAppend = {
                            type: 'input_audio_buffer.append',
                            audio: msg.media.payload
                        };
                        openAiWs.send(JSON.stringify(audioAppend));
                    }
                    break;

                case 'stop':
                    console.log(` Stream Stopped: ${streamSid}`);
                    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
                    break;
            }
        } catch (e) {
            console.error(' Message error:', e);
        }
    });

    connection.on('close', () => {
        console.log(' Client disconnected');
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});