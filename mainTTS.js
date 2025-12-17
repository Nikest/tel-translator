require('dotenv').config();
const WebSocket = require('ws');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_STANDARD_VOICE_ID;

/**
 * Класс для управления Text-to-Speech через ElevenLabs Realtime API
 */
class ElevenLabsTTS {
    constructor() {
        this.ws = null;
        this.isReady = false;
        this.audioQueue = [];
        this.operatorWs = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
    }

    /**
     * Подключение к ElevenLabs WebSocket API
     * @param {WebSocket} operatorWs - WebSocket соединение с оператором
     */
    connect(operatorWs) {
        this.operatorWs = operatorWs;

        const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_turbo_v2_5&output_format=pcm_16000`;

        this.ws = new WebSocket(wsUrl, {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY
            }
        });

        this.ws.on('open', () => {
            console.log('[ElevenLabs TTS] ✓ Connected');

            // Отправляем начальную конфигурацию
            const config = {
                text: ' ',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true
                },
                generation_config: {
                    chunk_length_schedule: [120, 160, 250, 290]
                },
                xi_api_key: ELEVENLABS_API_KEY
            };

            this.ws.send(JSON.stringify(config));
            this.isReady = true;
            this.reconnectAttempts = 0;

            console.log('[ElevenLabs TTS] ✓ Session ready');
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // Обработка аудио chunks
                if (response.audio) {
                    const audioBase64 = response.audio;
                    const audioSize = audioBase64.length;
                    console.log(`[ElevenLabs TTS] 🔊 Received audio chunk: ${audioSize} bytes`);

                    // Отправляем аудио оператору
                    if (this.operatorWs && this.operatorWs.readyState === WebSocket.OPEN) {
                        this.operatorWs.send(JSON.stringify({
                            type: 'audio',
                            payload: audioBase64
                        }));
                        console.log(`[ElevenLabs TTS] → Sent audio chunk to operator`);
                    } else {
                        console.error('[ElevenLabs TTS] ❌ Operator WS not ready');
                    }
                }

                // ElevenLabs отправляет isFinal когда генерация завершена
                if (response.isFinal) {
                    console.log('[ElevenLabs TTS] ✓ Audio generation completed');
                }

                // Обработка ошибок
                if (response.error) {
                    console.error('[ElevenLabs TTS] ❌ Error:', response.error);
                }

            } catch (e) {
                // Если не JSON, возможно это бинарные данные (для некоторых моделей)
                console.error('[ElevenLabs TTS] ❌ Parse error:', e.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('[ElevenLabs TTS] ❌ WS Error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('[ElevenLabs TTS] Connection closed');
            this.isReady = false;

            // Попытка переподключения
            if (this.reconnectAttempts < this.maxReconnectAttempts && this.operatorWs) {
                this.reconnectAttempts++;
                console.log(`[ElevenLabs TTS] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                setTimeout(() => this.connect(this.operatorWs), 2000);
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
            console.error('[ElevenLabs TTS] ❌ WebSocket not ready');
            return;
        }

        try {
            // Отправляем текст для озвучки
            const message = {
                text: text,
                try_trigger_generation: true
            };

            this.ws.send(JSON.stringify(message));
            console.log(`[ElevenLabs TTS] → Generating audio for: "${text.substring(0, 50)}..."`);

        } catch (error) {
            console.error('[ElevenLabs TTS] ❌ Error sending text:', error.message);
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
        this.operatorWs = null;
    }
}

// Глобальный инстанс TTS
let ttsInstance = null;

/**
 * Инициализация TTS (вызывается при старте сессии)
 * @param {WebSocket} operatorWs - WebSocket соединение с оператором
 */
function initTTS(operatorWs) {
    if (!ttsInstance) {
        ttsInstance = new ElevenLabsTTS();
    }
    ttsInstance.connect(operatorWs);
}

/**
 * Озвучивает текст
 * @param {string} text - Текст для озвучки
 * @returns {Promise<void>}
 */
async function playTTS(text) {
    if (!ttsInstance) {
        console.error('[ElevenLabs TTS] ❌ TTS not initialized');
        return;
    }
    await ttsInstance.playTTS(text);
}

/**
 * Закрывает TTS соединение
 */
function closeTTS() {
    if (ttsInstance) {
        ttsInstance.close();
        ttsInstance = null;
    }
}

module.exports = {
    initTTS,
    playTTS,
    closeTTS
};
