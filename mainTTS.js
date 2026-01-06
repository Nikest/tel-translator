require('dotenv').config();
const WebSocket = require('ws');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_RUSSIAN_VOICE_ID = process.env.ELEVENLABS_STANDARD_VOICE_ID;   // Русский голос для абонента
const ELEVENLABS_ENGLISH_VOICE_ID = process.env.ELEVENLABS_ENGLISH_VOICE_ID;   // Английский голос для оператора

/**
 * Класс для управления Text-to-Speech через ElevenLabs Realtime API
 */
class ElevenLabsTTS {
    constructor(outputFormat = 'pcm_16000', targetWs = null, direction = 'RU→EN', streamSid = null) {
        this.ws = null;
        this.isReady = false;
        this.audioQueue = [];
        this.targetWs = targetWs;  // WebSocket для отправки аудио (operator или phone)
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.outputFormat = outputFormat;  // 'pcm_16000' или 'ulaw_8000'
        this.direction = direction;  // 'RU→EN' или 'EN→RU'
        this.streamSid = streamSid;  // Для SignalWire (phone)

        // Выбираем голос в зависимости от направления:
        // RU→EN: озвучиваем английский текст → английский голос
        // EN→RU: озвучиваем русский текст → русский голос
        this.voiceId = direction === 'RU→EN' ? ELEVENLABS_ENGLISH_VOICE_ID : ELEVENLABS_RUSSIAN_VOICE_ID;

        console.log(`[ElevenLabs TTS ${this.direction}] Using voice: ${this.voiceId?.substring(0, 8)}...`);
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
            console.log(`[ElevenLabs TTS ${this.direction}] ✓ Connected`);

            // Отправляем начальную конфигурацию
            const config = {
                text: ' ',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true,
                    speed: 0.75,
                },
                generation_config: {
                    chunk_length_schedule: [120, 160, 250, 290]
                }
            };

            this.ws.send(JSON.stringify(config));
            console.log(`[ElevenLabs TTS ${this.direction}] → Sent initial config`);
            this.isReady = true;
            this.reconnectAttempts = 0;

            console.log(`[ElevenLabs TTS ${this.direction}] ✓ Session ready`);
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // Обработка аудио chunks
                if (response.audio) {
                    const audioBase64 = response.audio;
                    const audioSize = audioBase64.length;
                    console.log(`[ElevenLabs TTS ${this.direction}] 🔊 Received audio chunk: ${audioSize} bytes`);

                    // Отправляем аудио в зависимости от направления
                    if (this.targetWs && this.targetWs.readyState === WebSocket.OPEN) {
                        if (this.streamSid) {
                            // Для phone (SignalWire): формат G.711 µ-law
                            this.targetWs.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: audioBase64 }
                            }));
                            console.log(`[ElevenLabs TTS ${this.direction}] → Sent audio chunk to phone`);
                        } else {
                            // Для operator: обычный формат
                            this.targetWs.send(JSON.stringify({
                                type: 'audio',
                                payload: audioBase64
                            }));
                            console.log(`[ElevenLabs TTS ${this.direction}] → Sent audio chunk to operator`);
                        }
                    } else {
                        console.error(`[ElevenLabs TTS ${this.direction}] ❌ Target WS not ready`);
                    }
                }

                // ElevenLabs отправляет isFinal когда генерация завершена
                if (response.isFinal) {
                    console.log(`[ElevenLabs TTS ${this.direction}] ✓ Audio generation completed`);
                }

                // Обработка ошибок
                if (response.error) {
                    console.error(`[ElevenLabs TTS ${this.direction}] ❌ Error:`, response.error);
                }

            } catch (e) {
                // Если не JSON, возможно это бинарные данные (для некоторых моделей)
                console.error(`[ElevenLabs TTS ${this.direction}] ❌ Parse error:`, e.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[ElevenLabs TTS ${this.direction}] ❌ WS Error:`, error.message);
        });

        this.ws.on('close', () => {
            console.log(`[ElevenLabs TTS ${this.direction}] Connection closed`);
            this.isReady = false;

            // Попытка переподключения
            if (this.reconnectAttempts < this.maxReconnectAttempts && this.targetWs) {
                this.reconnectAttempts++;
                console.log(`[ElevenLabs TTS ${this.direction}] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
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
            console.error(`[ElevenLabs TTS ${this.direction}] ❌ WebSocket not ready`);
            return;
        }

        try {
            // Отправляем текст для озвучки
            const message = {
                text: text + ' ',
                try_trigger_generation: true
            };

            this.ws.send(JSON.stringify(message));
            console.log(`[ElevenLabs TTS ${this.direction}] → Generating audio for: "${text.substring(0, 50)}..."`);

            // Отправляем пустое сообщение для завершения и flush генерации
            setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const flushMessage = {
                        text: '',
                        flush: true
                    };
                    this.ws.send(JSON.stringify(flushMessage));
                    console.log(`[ElevenLabs TTS ${this.direction}] → Flushing audio generation`);
                }
            }, 100);

        } catch (error) {
            console.error(`[ElevenLabs TTS ${this.direction}] ❌ Error sending text:`, error.message);
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

// Глобальные инстансы TTS
let ttsForOperator = null;  // Для оператора (RU→EN, PCM16, английский голос)
let ttsForPhone = null;     // Для абонента (EN→RU, µ-law, русский голос)

/**
 * Инициализация TTS для оператора (вызывается при старте сессии)
 * Озвучивает английский текст (перевод речи клиента)
 * @param {WebSocket} operatorWs - WebSocket соединение с оператором
 */
function initTTSForOperator(operatorWs) {
    if (!ttsForOperator) {
        ttsForOperator = new ElevenLabsTTS('pcm_16000', operatorWs, 'RU→EN');
        ttsForOperator.connect();
    }
}

/**
 * Инициализация TTS для абонента (вызывается при старте сессии)
 * Озвучивает русский текст (перевод речи оператора)
 * @param {WebSocket} phoneWs - WebSocket соединение с абонентом
 * @param {string} streamSid - SignalWire stream ID
 */
function initTTSForPhone(phoneWs, streamSid) {
    if (!ttsForPhone) {
        ttsForPhone = new ElevenLabsTTS('ulaw_8000', phoneWs, 'EN→RU', streamSid);
        ttsForPhone.connect();
    }
}

/**
 * Озвучивает текст для оператора (английский текст)
 * @param {string} text - Текст для озвучки (EN)
 * @returns {Promise<void>}
 */
async function playTTSForOperator(text) {
    if (!ttsForOperator) {
        console.error('[ElevenLabs TTS RU→EN] ❌ TTS not initialized');
        return;
    }
    await ttsForOperator.playTTS(text);
}

/**
 * Озвучивает текст для абонента (русский текст)
 * @param {string} text - Текст для озвучки (RU)
 * @returns {Promise<void>}
 */
async function playTTSForPhone(text) {
    if (!ttsForPhone) {
        console.error('[ElevenLabs TTS EN→RU] ❌ TTS not initialized');
        return;
    }
    await ttsForPhone.playTTS(text);
}

/**
 * Закрывает все TTS соединения
 */
function closeTTS() {
    if (ttsForOperator) {
        ttsForOperator.close();
        ttsForOperator = null;
    }
    if (ttsForPhone) {
        ttsForPhone.close();
        ttsForPhone = null;
    }
}

module.exports = {
    initTTSForOperator,
    initTTSForPhone,
    playTTSForOperator,
    playTTSForPhone,
    closeTTS
};