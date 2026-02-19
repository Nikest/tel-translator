require('dotenv').config();
const WebSocket = require('ws');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_STANDARD_VOICE_ID;   // Мультиязычный голос (eleven_turbo_v2_5)

/**
 * Класс для управления Text-to-Speech через ElevenLabs Realtime API
 */
class ElevenLabsTTS {
    constructor(outputFormat = 'pcm_16000', targetWs = null, label = 'Phone', streamSid = null) {
        this.ws = null;
        this.isReady = false;
        this.audioQueue = [];
        this.targetWs = targetWs;  // WebSocket для отправки аудио (phone)
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.outputFormat = outputFormat;  // 'ulaw_8000'
        this.label = label;
        this.streamSid = streamSid;  // Для SignalWire (phone)
        this.voiceId = ELEVENLABS_VOICE_ID;

        console.log(`[ElevenLabs TTS ${this.label}] Using voice: ${this.voiceId?.substring(0, 8)}...`);
    }

    /**
     * Подключение к ElevenLabs WebSocket API
     * @param {WebSocket} targetWs - WebSocket соединение для отправки аудио
     * @param {string} streamSid - SignalWire stream ID (опционально, для phone)
     */
    connect(targetWs = null, streamSid = null) {
        if (targetWs) this.targetWs = targetWs;
        if (streamSid) this.streamSid = streamSid;

        const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?model_id=eleven_turbo_v2_5&output_format=${this.outputFormat}`;

        this.ws = new WebSocket(wsUrl, {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY
            }
        });

        this.ws.on('open', () => {
            console.log(`[ElevenLabs TTS ${this.label}] ✓ Connected`);

            // Отправляем начальную конфигурацию
            const config = {
                text: ' ',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true,
                    speed: 0.975, // Увеличено на 30% (0.75 * 1.30 = 0.975)
                },
                generation_config: {
                    chunk_length_schedule: [120, 160, 250, 290]
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
                            console.log(`[ElevenLabs TTS ${this.label}] → Sent audio chunk to phone`);
                        } else {
                            // Для operator: обычный формат
                            this.targetWs.send(JSON.stringify({
                                type: 'audio',
                                payload: audioBase64
                            }));
                            console.log(`[ElevenLabs TTS ${this.label}] → Sent audio chunk to operator`);
                        }
                    } else {
                        console.error(`[ElevenLabs TTS ${this.label}] ❌ Target WS not ready`);
                    }
                }

                // ElevenLabs отправляет isFinal когда генерация завершена
                if (response.isFinal) {
                    console.log(`[ElevenLabs TTS ${this.label}] ✓ Audio generation completed`);
                }

                // Обработка ошибок
                if (response.error) {
                    console.error(`[ElevenLabs TTS ${this.label}] ❌ Error:`, response.error);
                }

            } catch (e) {
                // Если не JSON, возможно это бинарные данные (для некоторых моделей)
                console.error(`[ElevenLabs TTS ${this.label}] ❌ Parse error:`, e.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[ElevenLabs TTS ${this.label}] ❌ WS Error:`, error.message);
        });

        this.ws.on('close', () => {
            console.log(`[ElevenLabs TTS ${this.label}] Connection closed`);
            this.isReady = false;

            // Попытка переподключения
            if (this.reconnectAttempts < this.maxReconnectAttempts && this.targetWs) {
                this.reconnectAttempts++;
                console.log(`[ElevenLabs TTS ${this.label}] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                setTimeout(() => this.connect(this.targetWs, this.streamSid), 2000);
            }
        });
    }

    /**
     * Озвучивает текст и отправляет аудио оператору
     * @param {string} text - Текст для озвучки
     * @returns {Promise<void>}
     */
    async playTTS(text) {
        if (!text || text.trim().length === 0) {
            return;
        }

        if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error(`[ElevenLabs TTS ${this.label}] ❌ WebSocket not ready`);
            return;
        }

        try {
            // Отправляем текст для озвучки
            const message = {
                text: text + ' ',
                try_trigger_generation: true
            };

            this.ws.send(JSON.stringify(message));
            console.log(`[ElevenLabs TTS ${this.label}] → Generating audio for: "${text.substring(0, 50)}..."`);

            // Отправляем пустое сообщение для завершения и flush генерации
            setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const flushMessage = {
                        text: '',
                        flush: true
                    };
                    this.ws.send(JSON.stringify(flushMessage));
                    console.log(`[ElevenLabs TTS ${this.label}] → Flushing audio generation`);
                }
            }, 100);

        } catch (error) {
            console.error(`[ElevenLabs TTS ${this.label}] ❌ Error sending text:`, error.message);
        }
    }

    /**
     * Закрывает соединение
     */
    close() {
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
function initTTSForPhone(phoneWs, streamSid) {
    if (!ttsForPhone) {
        ttsForPhone = new ElevenLabsTTS('ulaw_8000', phoneWs, 'Phone', streamSid);
        ttsForPhone.connect();
    }
}

/**
 * Озвучивает текст для абонента (на определённом языке абонента)
 * @param {string} text - Текст для озвучки
 * @returns {Promise<void>}
 */
async function playTTSForPhone(text) {
    if (!ttsForPhone) {
        console.error('[ElevenLabs TTS Phone] ❌ TTS not initialized');
        return;
    }
    await ttsForPhone.playTTS(text);
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
    closeTTS
};