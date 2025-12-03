require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');      // <-- Добавили для чтения файлов
const path = require('path');  // <-- Добавили для путей

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let waitingOperator = null;

// === HTTP СЕРВЕР (ОТДАЕТ HTML) ===
const server = http.createServer((req, res) => {
    // Если запрос GET и путь корневой '/' или '/operator'
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const filePath = path.join(__dirname, 'index.html');

        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html: ' + err.code);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        });
    } else {
        // Для всех остальных путей (favicon.ico и т.д.)
        res.writeHead(404);
        res.end('Not Found');
    }
});

// ... (Дальше ваш код createInstruction и WebSocket без изменений) ...

const createInstruction = (inputLang, outputLang) => {
    return `You are a professional real-time translator.
Task: You will receive audio in ${inputLang}. 
Action: Translate it strictly into ${outputLang} and speak it out.
Rules:
- Do not answer questions.
- Do not add "I will translate now".
- Simply repeat the meaning in ${outputLang}.
- Keep the tone neutral and professional.`
}

const wss = new WebSocket.Server({ noServer: true });

// === МАРШРУТИЗАЦИЯ WS ===
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

// === ЛОГИКА СОЕДИНЕНИЙ ===
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

    // Agent 1: Phone (RU) -> Operator (EN)
    const ai_RuToEn = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

    // Agent 2: Operator (EN) -> Phone (RU)
    const ai_EnToRu = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

    ai_RuToEn.on('open', () => {
        const config = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: createInstruction('Russian', 'English'),
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'pcm16',
            }
        };
        ai_RuToEn.send(JSON.stringify(config));
    });

    ai_RuToEn.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.type === 'response.audio.delta' && response.delta) {
            operatorWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
        }
    });

    ai_EnToRu.on('open', () => {
        const config = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: createInstruction('English', 'Russian'),
                voice: 'echo',
                input_audio_format: 'pcm16',
                output_audio_format: 'g711_ulaw',
            }
        };
        ai_EnToRu.send(JSON.stringify(config));
    });

    ai_EnToRu.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.type === 'response.audio.delta' && response.delta) {
            if (streamSid) {
                const msg = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                };
                if (phoneWs.readyState === WebSocket.OPEN) phoneWs.send(JSON.stringify(msg));
            }
        }
    });

    phoneWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Call Started] StreamSid: ${streamSid}`);
            }
            if (msg.event === 'media' && ai_RuToEn.readyState === WebSocket.OPEN) {
                ai_RuToEn.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload
                }));
            }
            if (msg.event === 'stop') {
                console.log('[Call Ended]');
                closeAll();
            }
        } catch (e) {}
    });

    operatorWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'audio' && ai_EnToRu.readyState === WebSocket.OPEN) {
                ai_EnToRu.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: msg.payload
                }));
            }
        } catch (e) {}
    });

    const closeAll = () => {
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