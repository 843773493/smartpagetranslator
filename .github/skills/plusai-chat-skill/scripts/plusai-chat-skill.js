const { chromium } = require('playwright');

async function sendMessage({ account, message, userDataDir, headless = true, timeout = 30000 }) {
  let browser, context, page;
  try {
    if (userDataDir) {
      // Persistent context reuses cookies/login
      context = await chromium.launchPersistentContext(userDataDir, { headless });
      page = await context.newPage();
    } else {
      browser = await chromium.launch({ headless });
      context = await browser.newContext();
      page = await context.newPage();
    }

    await page.goto('https://cc01.plusai.io/app/user/', { waitUntil: 'domcontentloaded', timeout });

    // Check login
    const loggedIn = await page.$('text=已登录为');
    if (!loggedIn) {
      throw new Error('未检测到已登录状态。请提供 `userDataDir` 或在非 headless 模式下登录一次。');
    }

    // If user supplied account, try to click it; otherwise use 快速换号
    if (account) {
      const btn = await page.$(`xpath=//button[normalize-space(.)='${account}']`);
      if (!btn) {
        throw new Error(`找不到账号按钮：${account}`);
      }
      await btn.click();
      await page.waitForTimeout(400);
    } else {
      const quick = await page.$("button:has-text('快速换号')");
      if (quick) {
        await quick.click();
        await page.waitForTimeout(400);
      }
    }

    // Focus composer and type message into the contenteditable editor (#prompt-textarea)
    const composer = await page.$('#prompt-textarea');
    if (!composer) throw new Error('找不到聊天输入框 (#prompt-textarea)');

    await composer.click();
    await page.keyboard.type(message, { delay: 30 });

    // Click send button
    const sendBtn = await page.$('button[data-testid="send-button"]');
    if (!sendBtn) throw new Error('找不到发送按钮');

    const before = await page.textContent('body');
    await sendBtn.click();

    // Wait for assistant reply to appear
    const responseText = await page.waitForFunction(
      ({ beforeText }) => {
        const now = document.body.innerText || '';
        if (now === beforeText) return false;
        if (now.includes('ChatGPT 说：')) return now;
        if (now.includes('\nChatGPT') || now.includes('ChatGPT')) return now;
        return false;
      },
      { polling: 500, timeout },
      { beforeText: before }
    );

    const full = await responseText.jsonValue();
    const fullStr = String(full);

    let reply = '';
    const m1 = fullStr.match(/ChatGPT\s*说：\s*([\s\S]*)/);
    if (m1) {
      reply = m1[1].trim();
    } else {
      reply = fullStr.slice(-1000).trim();
    }

    return reply;
  } finally {
    if (context && !userDataDir) await context.close();
    if (browser) await browser.close();
  }
}

module.exports = { sendMessage };

// CLI compatibility
if (require.main === module) {
  (async () => {
    const argv = require('minimist')(process.argv.slice(2));
    const account = argv.account || argv.a;
    const message = argv.message || argv.m;
    const userDataDir = argv.userDataDir || argv.u;
    const headless = argv.headless !== 'false';

    if (!message) {
      console.error('请使用 --message 或 -m 指定要发送的消息，例如:');
      console.error('  node scripts/plusai-chat-skill.js --message "你好"');
      process.exit(1);
    }

    try {
      const r = await sendMessage({ account, message, userDataDir, headless });
      console.log('=== reply start ===');
      console.log(r);
      console.log('=== reply end ===');
    } catch (err) {
      console.error('错误：', err.message || err);
      process.exit(2);
    }
  })();
}