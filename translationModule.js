require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSLATION_MODEL = 'gpt-4o-mini';

/**
 * Переводит текст с русского на английский
 * @param {string} text - Текст на русском языке
 * @returns {Promise<string>} - Переведенный текст на английском
 */
async function translateRuToEn(text) {
    if (!text || text.trim().length === 0) {
        return '';
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: TRANSLATION_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'Translate from Russian to English. Output only the translation, nothing else.'
                    },
                    {
                        role: 'user',
                        content: text
                    }
                ],
                temperature: 0,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();

    } catch (error) {
        console.error('[Translation RU→EN] ❌ Error:', error.message);
        return `[Translation error: ${text}]`;
    }
}

/**
 * Переводит текст с английского на русский
 * @param {string} text - Текст на английском языке
 * @returns {Promise<string>} - Переведенный текст на русском
 */
async function translateEnToRu(text) {
    if (!text || text.trim().length === 0) {
        return '';
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: TRANSLATION_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'Translate from English to Russian. Output only the translation, nothing else.'
                    },
                    {
                        role: 'user',
                        content: text
                    }
                ],
                temperature: 0,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();

    } catch (error) {
        console.error('[Translation EN→RU] ❌ Error:', error.message);
        return `[Translation error: ${text}]`;
    }
}

module.exports = {
    translateRuToEn,
    translateEnToRu
};
