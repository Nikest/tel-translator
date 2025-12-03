require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// === ПРОВЕРКИ ===
if (!OPENAI_API_KEY) {
    console.error("FATAL ERROR: OPENAI_API_KEY is missing!");
    process.exit(1);
}
console.log(`Key loaded: ...${OPENAI_API_KEY.slice(-4)}`);

let waitingOperator = null;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500); res.end('Error loading index.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content);
            }
        });
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

const createInstruction = (inputLang, outputLang) => {
    return `You are a translator. Translate ${inputLang} to ${outputLang}. 
    IMPORTANT: Just translate. Do not add intro. 
    If you hear silence, stay silent.`
}

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    if (pathname === '/call') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.isOperator = false;
            wss.emit('connection', ws, request);
        });
    } else if (pathname === '/operator') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.isOperator = true;
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    if (ws.isOperator) {
        console.log('[System] Operator connected via Web');
        waitingOperator = ws;
        ws.on('close', () => {
            console.log('[System] Operator disconnected');
            if (waitingOperator === ws) waitingOperator = null;
        });
        ws.send(JSON.stringify({ type: 'status', msg: 'Waiting for a call...' }));
        return;
    }

    console.log('[SignalWire] Incoming call...');
    if (!waitingOperator || waitingOperator.readyState !== WebSocket.OPEN) {
        console.log('[System] No operator available. Rejecting call.');
        ws.close();
        return;
    }

    const operatorWs = waitingOperator;
    waitingOperator = null;

    operatorWs.send(JSON.stringify({ type: 'status', msg: 'Call Connected!' }));
    console.log('[System] Bridge created: Phone <-> Operator');

    startTranslationSession(ws, operatorWs);
});

function startTranslationSession(phoneWs, operatorWs) {
    let streamSid = null;

    // Вспомогательная функция для пульса в логах (чтобы не спамить)
    let packetsRu = 0;
    let packetsEn = 0;
    const logPulse = (direction) => {
        if (direction === 'ru') {
            packetsRu++;
            if (packetsRu % 50 === 0) process.stdout.write('.'); // Входящие от телефона
        } else {
            packetsEn++;
            if (packetsEn % 50 === 0) process.stdout.write('*'); // Входящие от Оператора
        }
    };

    const createOpenAISocket = (name) => {
        const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
        });
        ws.on('error', (e) => console.error(`\n[OpenAI ${name}] Error:`, e.message));
        return ws;
    };

    const ai_RuToEn = createOpenAISocket('Ru->En');
    const ai_EnToRu = createOpenAISocket('En->Ru');

    // === НАСТРОЙКА RU (PHONE) -> EN (OPERATOR) ===
    ai_RuToEn.on('open', () => {
        console.log('\n[OpenAI Ru->En] Connected!');
        const config = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: createInstruction('Russian', 'English'),
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'pcm16',
                turn_detection: { type: 'server_vad', threshold: 0.5 }
            }
        };
        ai_RuToEn.send(JSON.stringify(config));

        // ТЕСТ: Заставляем бота сказать что-то Оператору сразу
        setTimeout(() => {
            ai_RuToEn.send(JSON.stringify({
                type: 'response.create',
                response: { modalities: ['audio', 'text'], instructions: 'Say "System Ready" in English' }
            }));
        }, 1000);
    });

    ai_RuToEn.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            // ЛОГИРУЕМ ТО, ЧТО БОТ УСЛЫШАЛ (ТЕКСТ)
            if (response.type === 'response.audio_transcript.done') {
                console.log(`\n[RU Heard]: "${response.transcript}"`);
            }
            if (response.type === 'response.audio.delta' && response.delta) {
                operatorWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
            }
        } catch (e) {}
    });

    // === НАСТРОЙКА EN (OPERATOR) -> RU (PHONE) ===
    ai_EnToRu.on('open', () => {
        console.log('\n[OpenAI En->Ru] Connected!');
        const config = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: createInstruction('English', 'Russian'),
                voice: 'echo',
                input_audio_format: 'pcm16',
                output_audio_format: 'g711_ulaw',
                turn_detection: { type: 'server_vad', threshold: 0.5 }
            }
        };
        ai_EnToRu.send(JSON.stringify(config));
    });

    ai_EnToRu.on('message', (data) => {
        try {
            const response = JSON.parse(data);

            // ЛОГИРУЕМ ТО, ЧТО БОТ УСЛЫШАЛ (ТЕКСТ)
            if (response.type === 'response.audio_transcript.done') {
                console.log(`\n[EN Heard]: "${response.transcript}"`);
            }
            if (response.type === 'response.audio.delta' && response.delta) {
                if (streamSid && phoneWs.readyState === WebSocket.OPEN) {
                    phoneWs.send(JSON.stringify({ event: 'media', streamSid: streamSid, media: { payload: response.delta } }));
                }
            }
        } catch (e) {}
    });

    // === МАРШРУТИЗАЦИЯ ОТ КЛИЕНТОВ ===
    phoneWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`\n[Call Started] StreamSid: ${streamSid}`);
            }
            if (msg.event === 'media' && ai_RuToEn.readyState === WebSocket.OPEN) {
                logPulse('ru'); // Рисуем точку
                ai_RuToEn.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
            }
            if (msg.event === 'stop') closeAll();
        } catch (e) {}
    });

    operatorWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'audio' && ai_EnToRu.readyState === WebSocket.OPEN) {
                logPulse('en'); // Рисуем звездочку
                ai_EnToRu.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.payload }));
            }
        } catch (e) {}
    });

    const closeAll = () => {
        console.log('\n[System] Closing session');
        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.close();
        if (operatorWs.readyState === WebSocket.OPEN) operatorWs.close();
        if (ai_RuToEn.readyState === WebSocket.OPEN) ai_RuToEn.close();
        if (ai_EnToRu.readyState === WebSocket.OPEN) ai_EnToRu.close();
        waitingOperator = null;
    };

    phoneWs.on('close', closeAll);
    operatorWs.on('close', closeAll);
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});