---
name: plusai-chat-skill
description: '在后台与 PlusAI ChatGPT 自动对话：自动选择账号或按指定账号切换，发送消息并返回模型回复。Use when you want to programmatically send messages to PlusAI/ChatGPT, automate account selection, run headless background chats, or integrate PlusAI responses into scripts.'
---

# PlusAI Chat Skill

## When to Use This Skill

- 当你需要通过脚本自动向 PlusAI（https://cc01.plusai.io/）发送消息并读取模型回复时。
- 当你想要在**后台（headless）**环境中自动切换账号或使用指定账号发送消息时。
- 当你需要把 PlusAI 模型的响应集成到自动化流程、测试或监控中时。

## Prerequisites

- Node.js 18+ 和 npm
- Playwright（Chrome/Chromium）: 使用前请运行 `npm i playwright` 并 `npx playwright install chromium`
- （可选）已登录的浏览器用户配置目录（用于复用 PlusAI 登录状态），传入 `--userDataDir`。

## Files

- `scripts/plusai-chat-skill.js` — 可复用的脚本：既支持作为 CLI 调用，也导出 `sendMessage` 函数供程序化使用。
- `validate.js` — 简单的 SKILL.md 验证脚本（用于 `npm run skill:validate`）。

## Step-by-Step Workflows

1. 安装依赖：
   - npm install
   - npm i playwright minimist
   - npx playwright install chromium

2. 作为 CLI 使用（无持久会话）：
   - node scripts/plusai-chat-skill.js --message "你好"

3. 复用已登录会话（推荐）：
   - node scripts/plusai-chat-skill.js --message "你好" --userDataDir "C:/Users/you/AppData/Local/Google/Chrome/User Data/Profile 1"

4. 程序化调用（示例）：
   ```js
   const { sendMessage } = require('./scripts/plusai-chat-skill');
   (async () => {
     const reply = await sendMessage({ message: '你好', userDataDir: 'C:/.../Profile 1', headless: true });
     console.log(reply);
   })();
   ```

## Troubleshooting

- 如果脚本报错“未检测到已登录状态”，请提供 `--userDataDir` 指向包含已登录会话的浏览器配置目录，或使用 `--headless false` 手动登录一次。
- 若元素定位失败，确保页面未改版或类名/文本发生变化；更新选择器后重试。

## Validation

Run `npm run skill:validate` inside this skill folder to validate `SKILL.md` frontmatter basic constraints.

## References

- Template: `.github/skill/make-skill-template/SKILL.md`
