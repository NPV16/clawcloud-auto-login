/**
 * ClawCloud 自动登录 & 余额监控 (Node.js 版)
 * Регион: EU Central 1 (Frankfurt)
 */

const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const sodium = require('libsodium-wrappers');

// ==================== КОНФИГУРАЦИЯ ====================
const CONFIG = {
    // Измененный URL для европейского региона
    CLAW_CLOUD_URL: "https://eu-central-1.run.claw.cloud", 
    TWO_FACTOR_WAIT: parseInt(process.env.TWO_FACTOR_WAIT || "120"),
    GH_USERNAME: process.env.GH_USERNAME,
    GH_PASSWORD: process.env.GH_PASSWORD,
    GH_SESSION: process.env.GH_SESSION,
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    REPO_TOKEN: process.env.REPO_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY
};

CONFIG.SIGNIN_URL = `${CONFIG.CLAW_CLOUD_URL}/signin`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Logger {
    constructor() { this.logs = []; }
    log(msg, level = "INFO") {
        const icons = { "INFO": "ℹ️", "SUCCESS": "✅", "ERROR": "❌", "WARN": "⚠️", "STEP": "🔹" };
        const line = `${icons[level] || "•"} ${msg}`;
        console.log(line);
        this.logs.push(line);
    }
}
const logger = new Logger();

class Telegram {
    constructor() {
        this.token = CONFIG.TG_BOT_TOKEN;
        this.chatId = CONFIG.TG_CHAT_ID;
        this.apiBase = `https://api.telegram.org/bot${this.token}`;
    }
    async send(msg) {
        try { await axios.post(`${this.apiBase}/sendMessage`, { chat_id: this.chatId, text: msg, parse_mode: "HTML" }); } catch (e) {}
    }
    async photo(filePath, caption = "") {
        if (!fs.existsSync(filePath)) return;
        try {
            const form = new FormData();
            form.append('chat_id', this.chatId);
            form.append('caption', caption.substring(0, 1024));
            form.append('photo', fs.createReadStream(filePath));
            await axios.post(`${this.apiBase}/sendPhoto`, form, { headers: form.getHeaders() });
        } catch (e) {}
    }
    async waitCode(timeoutSec = 120) {
        let offset = 0;
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
            try {
                const res = await axios.get(`${this.apiBase}/getUpdates`, { params: { offset, timeout: 10 } });
                if (res.data.ok) {
                    for (const upd of res.data.result) {
                        offset = upd.update_id + 1;
                        if (upd.message && String(upd.message.chat.id) === String(this.chatId)) {
                            const match = (upd.message.text || "").match(/^\/code\s+(\d{6,8})$/);
                            if (match) return match[1];
                        }
                    }
                }
            } catch (e) {}
            await sleep(2000);
        }
        return null;
    }
}

class AutoLogin {
    constructor() {
        this.tg = new Telegram();
        this.shots = [];
    }

    async shot(page, name) {
        const filename = `${Date.now()}_${name}.png`;
        await page.screenshot({ path: filename });
        this.shots.push(filename);
        return filename;
    }

    async getBalance(page) {
        logger.log("Переход в раздел биллинга...", "STEP");
        try {
            // Ищем кнопку с балансом в шапке или принудительно идем в /plan
            const upgradeBtn = page.locator('div:has-text("Upgrade Plan"), .ant-tag-blue').first();
            if (await upgradeBtn.isVisible({ timeout: 10000 })) {
                await upgradeBtn.click();
            } else {
                await page.goto(`${CONFIG.CLAW_CLOUD_URL}/plan`, { waitUntil: 'networkidle' });
            }

            await page.waitForSelector('text=Credits Available', { timeout: 20000 });
            await sleep(3000);

            return await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('div, span, b'));
                const moneyRegex = /\$\d+\.\d+/;
                const balanceEl = els.find(el => moneyRegex.test(el.innerText) && el.innerText.length < 12);
                const usedEl = els.find(el => el.innerText.toLowerCase().includes('used'));
                return `${balanceEl ? balanceEl.innerText.trim() : "Н/Д"} ${usedEl ? '(' + usedEl.innerText.trim() + ')' : ''}`;
            });
        } catch (e) {
            return "Ошибка парсинга баланса";
        }
    }

    async handleGithub(page) {
        if (page.url().includes('github.com/login')) {
            logger.log("Ввод данных GitHub...", "STEP");
            await page.fill('input[name="login"]', CONFIG.GH_USERNAME);
            await page.fill('input[name="password"]', CONFIG.GH_PASSWORD);
            await page.click('input[type="submit"]');
            await sleep(5000);
        }
        if (page.url().includes('two-factor')) {
            await this.tg.send("🔐 <b>Нужен 2FA код для EU региона</b>");
            const code = await this.tg.waitCode(CONFIG.TWO_FACTOR_WAIT);
            if (code) {
                await page.fill('input[autocomplete="one-time-code"]', code);
                await page.keyboard.press('Enter');
                await sleep(5000);
            }
        }
        const authBtn = page.locator('button[name="authorize"]');
        if (await authBtn.isVisible({ timeout: 5000 })) {
            await authBtn.click();
            await sleep(5000);
        }
    }

    async run() {
        logger.log(`Запуск мониторинга для региона EU...`);
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

        if (CONFIG.GH_SESSION) {
            await context.addCookies([{ name: 'user_session', value: CONFIG.GH_SESSION, domain: 'github.com', path: '/' }]);
        }

        const page = await context.newPage();

        try {
            await page.goto(CONFIG.SIGNIN_URL, { waitUntil: 'networkidle' });
            
            // Нажимаем GitHub на странице входа
            const githubBtn = page.locator('button:has-text("GitHub"), [class*="github"]').first();
            if (await githubBtn.isVisible()) {
                await githubBtn.click();
                await sleep(5000);
                await this.handleGithub(page);
            }

            await page.waitForURL(/claw\.cloud/, { timeout: 60000 });
            await sleep(8000); 

            const balance = await this.getBalance(page);
            
            await this.shot(page, "eu_final");
            await this.tg.send(`<b>🤖 ClawCloud EU</b>\nСтатус: ✅ Успех\nБаланс: <code>${balance}</code>`);

        } catch (e) {
            logger.log(e.message, "ERROR");
            await this.tg.send(`<b>🤖 ClawCloud EU</b>\n❌ Ошибка: ${e.message}`);
        } finally {
            await browser.close();
        }
    }
}

(new AutoLogin()).run();
