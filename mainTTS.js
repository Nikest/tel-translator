require('dotenv').config();
const WebSocket = require('ws');
const { logError } = require('./errorLogger');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_STANDARD_VOICE_ID;   // Мультиязычный голос (eleven_turbo_v2_5)

/**
 * Класс для управления Text-to-Speech через ElevenLabs Realtime API
 */
class ElevenLabsTTS {
    constructor(outputFormat = 'pcm_16000', targetWs = null, label = 'Phone', streamSid = null, notifyWs = null) {
        this.ws = null;
        this.isReady = false;
        this.audioQueue = [];
        this.targetWs = targetWs;  // WebSocket для отправки аудио (phone)
        this.notifyWs = notifyWs;  // WebSocket оператора для уведомлений об ошибках
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.outputFormat = outputFormat;  // 'ulaw_8000'
        this.label = label;
        this.streamSid = streamSid;  // Для SignalWire (phone)
        this.voiceId = ELEVENLABS_VOICE_ID;
        this.pendingMsgId = null;
        this.audioChunksSent = 0;
        this.onDelivered = null;
        this.deliveryTimeout = null;  // Timer for delivery confirmation

        console.log(`[ElevenLabs TTS ${this.label}] Using voice: ${this.voiceId?.substring(0, 8)}...`);
    }

    notifyError(errorName) {
        logError(`ElevenLabs TTS ${this.label}: ${errorName}`);
        if (this.notifyWs && this.notifyWs.readyState === WebSocket.OPEN) {
            this.notifyWs.send(JSON.stringify({ type: 'error', msg: 'Translation bot error' }));
        }
    }

    /**
     * Подключение к ElevenLabs WebSocket API
     * @param {WebSocket} targetWs - WebSocket соединение для отправки аудио
     * @param {string} streamSid - SignalWire stream ID (опционально, для phone)
     */
    connect(targetWs = null, streamSid = null) {
        if (targetWs) this.targetWs = targetWs;
        if (streamSid) this.streamSid = streamSid;

        const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?model_id=eleven_v3&output_format=${this.outputFormat}&optimize_streaming_latency=3`;

        this.ws = new WebSocket(wsUrl, {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY
            }
        });

        this.ws.on('unexpected-response', (request, response) => {
            let responseBody = '';
            response.on('data', (chunk) => {
                responseBody += chunk;
            });
            response.on('end', () => {
                console.error(`[ElevenLabs TTS ${this.label}] ❌ HTTP ${response.statusCode} Error Details:`, responseBody);
            });
        });

        this.ws.on('open', () => {
            console.log(`[ElevenLabs TTS ${this.label}] ✓ Connected`);

            // Отправляем начальную конфигурацию
            const config = {
                text: ' ',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.25,
                    use_speaker_boost: true,
                    speed: 0.975,
                },
                generation_config: {
                    chunk_length_schedule: [50]
                }
            };

            this.ws.send(JSON.stringify(config));
            console.log(`[ElevenLabs TTS ${this.label}] → Sent initial config`);
            this.isReady = true;
            this.reconnectAttempts = 0;

            console.log(`[ElevenLabs TTS ${this.label}] ✓ Session ready`);
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // Обработка аудио chunks
                if (response.audio) {
                    const audioBase64 = response.audio;
                    const audioSize = audioBase64.length;
                    console.log(`[ElevenLabs TTS ${this.label}] 🔊 Received audio chunk: ${audioSize} bytes`);

                    // Отправляем аудио в зависимости от направления
                    if (this.targetWs && this.targetWs.readyState === WebSocket.OPEN) {
                        if (this.streamSid) {
                            // Для phone (SignalWire): формат G.711 µ-law
                            this.targetWs.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: audioBase64 }
                            }));
                            this.audioChunksSent++;
                        } else {
                            // Для operator: обычный формат
                            this.targetWs.send(JSON.stringify({
                                type: 'audio',
                                payload: audioBase64
                            }));
                        }

                        // Reset delivery timeout — confirm delivery 800ms after last audio chunk
                        if (this.pendingMsgId) {
                            if (this.deliveryTimeout) clearTimeout(this.deliveryTimeout);
                            this.deliveryTimeout = setTimeout(() => {
                                if (this.pendingMsgId && this.onDelivered) {
                                    const delivered = this.audioChunksSent > 0;
                                    console.log(`[ElevenLabs TTS ${this.label}] ✓ Audio delivery confirmed (${this.audioChunksSent} chunks)`);
                                    this.onDelivered(this.pendingMsgId, delivered);
                                    this.pendingMsgId = null;
                                }
                            }, 800);
                        }
                    } else {
                        console.error(`[ElevenLabs TTS ${this.label}] ❌ Target WS not ready`);
                        // Audio lost — notify failure
                        if (this.deliveryTimeout) { clearTimeout(this.deliveryTimeout); this.deliveryTimeout = null; }
                        if (this.pendingMsgId && this.onDelivered) {
                            this.onDelivered(this.pendingMsgId, false);
                            this.pendingMsgId = null;
                        }
                    }
                }

                // ElevenLabs sends isFinal when the connection is closing (backup check)
                if (response.isFinal) {
                    if (this.deliveryTimeout) { clearTimeout(this.deliveryTimeout); this.deliveryTimeout = null; }
                    const delivered = this.audioChunksSent > 0;
                    console.log(`[ElevenLabs TTS ${this.label}] ✓ Audio generation completed (${this.audioChunksSent} chunks, ${delivered ? 'delivered' : 'failed'})`);
                    if (this.pendingMsgId && this.onDelivered) {
                        this.onDelivered(this.pendingMsgId, delivered);
                        this.pendingMsgId = null;
                    }
                }

                // Обработка ошибок
                if (response.error) {
                    console.error(`[ElevenLabs TTS ${this.label}] ❌ Error:`, response.error);
                    this.notifyError(response.error);
                }

            } catch (e) {
                // Если не JSON, возможно это бинарные данные (для некоторых моделей)
                console.error(`[ElevenLabs TTS ${this.label}] ❌ Parse error:`, e.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[ElevenLabs TTS ${this.label}] ❌ WS Error:`, error.message);
            this.notifyError(error.message);
        });

        this.ws.on('close', () => {
            console.log(`[ElevenLabs TTS ${this.label}] Connection closed`);
            this.isReady = false;

            // Попытка переподключения
            if (this.reconnectAttempts < this.maxReconnectAttempts && this.targetWs) {
                this.reconnectAttempts++;
                console.log(`[ElevenLabs TTS ${this.label}] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                setTimeout(() => this.connect(this.targetWs, this.streamSid), 500);
            }
        });
    }

    /**
     * Озвучивает текст и отправляет аудио оператору
     * @param {string} text - Текст для озвучки
     * @returns {Promise<void>}
     */
    async playTTS(text, msgId = null) {
        if (!text || text.trim().length === 0) {
            return;
        }

        // Clear any pending delivery from previous message
        if (this.deliveryTimeout) { clearTimeout(this.deliveryTimeout); this.deliveryTimeout = null; }

        this.pendingMsgId = msgId;
        this.audioChunksSent = 0;

        // If reconnecting, wait up to 5 seconds for connection
        if (!this.isReady && this.reconnectAttempts > 0) {
            console.log(`[ElevenLabs TTS ${this.label}] ⏳ Waiting for reconnect...`);
            const waitReady = await new Promise((resolve) => {
                const start = Date.now();
                const check = () => {
                    if (this.isReady) return resolve(true);
                    if (Date.now() - start > 5000) return resolve(false);
                    setTimeout(check, 200);
                };
                check();
            });
            if (!waitReady) {
                console.error(`[ElevenLabs TTS ${this.label}] ❌ Reconnect timeout, dropping text`);
                if (this.pendingMsgId && this.onDelivered) {
                    this.onDelivered(this.pendingMsgId, false);
                    this.pendingMsgId = null;
                }
                return;
            }
        }

        if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error(`[ElevenLabs TTS ${this.label}] ❌ WebSocket not ready`);
            if (this.pendingMsgId && this.onDelivered) {
                this.onDelivered(this.pendingMsgId, false);
                this.pendingMsgId = null;
            }
            return;
        }

        try {
            // Для коротких фраз добавляем завершающую точку если нет пунктуации —
            // это помогает ElevenLabs корректно сгенерировать конец фразы
            let ttsText = text.trim();
            if (ttsText.length < 30 && !/[.!?。？！,;:…]$/.test(ttsText)) {
                ttsText = ttsText + '.';
            }

            // Отправляем текст для озвучки
            const message = {
                text: ttsText + ' ',
                try_trigger_generation: true
            };

            this.ws.send(JSON.stringify(message));
            console.log(`[ElevenLabs TTS ${this.label}] → Generating audio for: "${text.substring(0, 50)}..." (${ttsText.length} chars)`);

            // Flush генерации — для коротких фраз даём чуть больше времени
            const flushDelay = ttsText.length < 30 ? 200 : 100;
            setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const flushMessage = {
                        text: '',
                        flush: true
                    };
                    this.ws.send(JSON.stringify(flushMessage));
                    console.log(`[ElevenLabs TTS ${this.label}] → Flushing audio generation`);
                }
            }, flushDelay);

        } catch (error) {
            console.error(`[ElevenLabs TTS ${this.label}] ❌ Error sending text:`, error.message);
        }
    }

    /**
     * Закрывает соединение
     */
    close() {
        if (this.deliveryTimeout) { clearTimeout(this.deliveryTimeout); this.deliveryTimeout = null; }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Отправляем финальное сообщение для завершения генерации
            try {
                this.ws.send(JSON.stringify({ text: '' }));
            } catch (e) {
                // Игнорируем ошибки при закрытии
            }

            this.ws.close();
        }
        this.isReady = false;
        this.targetWs = null;
    }
}

// Глобальный инстанс TTS
let ttsForPhone = null;     // Для абонента (µ-law, мультиязычный голос)

/**
 * Инициализация TTS для абонента (вызывается при старте сессии)
 * Озвучивает переведённый текст на языке абонента
 * @param {WebSocket} phoneWs - WebSocket соединение с абонентом
 * @param {string} streamSid - SignalWire stream ID
 */
function initTTSForPhone(phoneWs, streamSid, notifyWs) {
    if (!ttsForPhone) {
        ttsForPhone = new ElevenLabsTTS('ulaw_8000', phoneWs, 'Phone', streamSid, notifyWs);
        ttsForPhone.connect();
    }
}

/**
 * Озвучивает текст для абонента (на определённом языке абонента)
 * @param {string} text - Текст для озвучки
 * @returns {Promise<void>}
 */
async function playTTSForPhone(text, msgId = null) {
    if (!ttsForPhone) {
        console.error('[ElevenLabs TTS Phone] ❌ TTS not initialized');
        return;
    }
    await ttsForPhone.playTTS(text, msgId);
}

function setTTSDeliveryCallback(callback) {
    if (ttsForPhone) {
        ttsForPhone.onDelivered = callback;
    }
}

/**
 * Закрывает все TTS соединения
 */
function closeTTS() {
    if (ttsForPhone) {
        ttsForPhone.close();
        ttsForPhone = null;
    }
}

module.exports = {
    initTTSForPhone,
    playTTSForPhone,
    setTTSDeliveryCallback,
    closeTTS
};