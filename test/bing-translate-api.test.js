// Integration test for `bing-translate-api`: translate an English sentence to Chinese.
// Run with: node test/bing-translate-api.test.js
// To skip network integration tests set SKIP_BING_TRANSLATE_TEST=1

const assert = require('assert');
let mod;
try {
    mod = require('bing-translate-api');
} catch (err) {
    console.error('Failed to require module `bing-translate-api`: ', err.message);
    process.exit(2);
}

// Optionally skip this test in CI or offline environments
if (process.env.SKIP_BING_TRANSLATE_TEST === '1') {
    console.log('⏭️ Skipped: SKIP_BING_TRANSLATE_TEST=1');
    process.exit(0);
}

(async () => {
    const text = `Hello, world!`;
    // const text = `Hello, world! This is a comprehensive integration test for the translator designed to exercise the system using a substantially larger block of English prose. The purpose of this sample is to verify that translating longer content — including multiple sentences, varied punctuation, numbers such as 2026, and repeated phrases — behaves correctly under realistic conditions. The paragraph below intentionally mixes descriptive language, technical terms like translation, concurrency, API, timeout, and everyday expressions to better emulate actual user content and to challenge tokenizer and chunking behavior. It also contains longer compound clauses, parenthetical remarks, and lists: quick brown fox, lazy dog; testing, validation, monitoring; input/output pairs. Overall, this text aims to approach nine hundred characters in length so the translator must handle medium-to-large payloads without truncation or failure. Please translate the meaning faithfully and preserve the general structure and readability while rendering the content in Simplified Chinese.`;
    const TIMEOUT_MS = 15000; // 15s

    function timeout(ms) {
        return new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms));
    }

    try {
        const result = await Promise.race([
            mod.translate(text, null, 'zh-Hans'),
            timeout(TIMEOUT_MS),
        ]);

        // `bing-translate-api` may return a string or an object containing `translation`
        const translated = typeof result === 'string' ? result : (result && (result.translation || result.translatedText || ''));

        assert.ok(translated && translated.trim().length > 0, 'Translated text should be non-empty');

        // Ensure the translated text contains at least one CJK character
        const containsCJK = /[\u4E00-\u9FFF]/.test(translated);
        assert.ok(containsCJK, `Expected translated text to contain Chinese characters. Received: ${translated}`);

        console.log('✅ Translation integration test passed');
        process.exit(0);
    } catch (err) {
        console.error('❌ Translation integration test failed:', err && err.message ? err.message : String(err));
        process.exit(1);
    }
})();
