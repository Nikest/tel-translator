const { MongoClient } = require('mongodb');

const DB_NAME = 'translator';
let clientPromise = null;

function getClient() {
    if (!clientPromise) {
        const url = process.env.MONGO_URL;
        if (!url) {
            console.error('[ErrorLogger] MONGO_URL not set, errors will not be saved to DB');
            return null;
        }
        const client = new MongoClient(url);
        clientPromise = client.connect();
    }
    return clientPromise;
}

async function logError(errorName) {
    const time = new Date().toISOString().substring(11, 19);
    const entry = {
        time,
        error: errorName,
        createdAt: new Date(),
    };

    try {
        const client = await getClient();
        if (!client) return;
        const db = client.db(DB_NAME);
        await db.collection('translation-bot-errors').insertOne(entry);
    } catch (err) {
        console.error('[ErrorLogger] Failed to write to DB:', err.message);
    }
}

module.exports = { logError };
