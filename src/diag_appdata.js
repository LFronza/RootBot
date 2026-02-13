const { rootServer } = require('@rootsdk/server-bot');
require('dotenv').config();

async function run() {
    console.log("--- AppData Diagnostic ---");
    const all = await rootServer.dataStore.appData.select("*");
    console.log(`Found ${all.length} keys.`);
    all.forEach(kv => {
        console.log(`Key: "${kv.key}" | Value: "${kv.value}"`);
    });
    process.exit(0);
}

run();
