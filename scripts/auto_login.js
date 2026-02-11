/**
 * ClawCloud 自动登录 & 余额监控 (Node.js 版)
 * - Принудительный клик по кнопке GitHub при входе
 * - Переход в Account Center через кнопку Upgrade в хедере
 * - Универсальный парсинг баланса ($X.XX)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const sodium = require('libsodium-wrappers');

// ==================== 配置 ====================
const CONFIG = {
    CLAW_CLOUD_URL: "https://ap-southeast-1.run.claw.cloud", 
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
    getRecentLogs() { return this.logs.slice(-6).join("\n"); }
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

class SecretUpdater {
    async update(name, value) {
        if (!CONFIG.REPO_TOKEN || !CONFIG.GITHUB_REPOSITORY) return false;
        try {
            await sodium.ready;
            const headers = { "Authorization": `token ${CONFIG.REPO_TOKEN}`, "Accept": "application/vnd.github.v3+json" };
            const { data: keyData } = await axios.get(`https://api.github.com/repos/${CONFIG.GITHUB_REPOSITORY}/actions/secrets/public-key`, { headers });
            const binkey = sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL);
            const encBytes = sodium.crypto_box_seal(sodium.from_string(value), binkey);
            await axios.put(`https://api.github.com/repos/${CONFIG.GITHUB_REPOSITORY}/actions/secrets/${name}`, {
                encrypted_value: sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL),
                key_id: keyData.key_id
            }, { headers });
            return true;
        } catch (e) { return false; }
    }
}

class AutoLogin {
    constructor() {
        this.tg = new Telegram();
        this.secret = new SecretUpdater();
        this.shots = [];
    }

    async shot(page, name) {
        const filename = `${Date.now()}_${name}.png`;
        await page.screenshot({ path: filename });
        this.shots.push(filename);
        return filename;
    }

    async getBalance(page) {
        logger.log("Шаг: Поиск баланса через раздел Plan...", "STEP");
        try {
            // 1. Пытаемся кликнуть на кнопку Upgrade Plan в хедере (где виден баланс на скриншоте)
            const upgradeBtn = page.locator('div:has-text("Upgrade Plan")').first();
            if (await upgradeBtn.isVisible({ timeout: 10000 })) {
                await upgradeBtn.click();
            } else {
                // Если кнопки нет, идем по прямой ссылке
                await page.goto(`${CONFIG.CLAW_CLOUD_URL}/plan`, { waitUntil: 'networkidle' });
            }

            // 2. Ждем загрузки страницы биллинга
            await page.waitForSelector('text=Credits Available', { timeout: 20000 });
            await sleep(3000);

            // 3. Парсим данные баланса
            const data = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('div, span, p, b'));
                const moneyRegex = /\$\d+\.\d+/;
                const balanceEl = els.find(el => moneyRegex.test(el.innerText) && el.innerText.length < 15);
                const usedEl = els.find(el => el.innerText.toLowerCase().includes('used'));
                return {
                    main: balanceEl ? balanceEl.innerText.trim() : "Н/Д",
                    used: usedEl ? usedEl.innerText.trim() : ""
                };
            });

            const result = `${data.main} ${data.used ? '(' + data.used + ')' : ''}`;
            logger.log(`Баланс найден: ${result}`, "SUCCESS");
            return result;
        } catch (e) {
            logger.log(`Не удалось найти баланс: ${e.message}`, "WARN");
            return "Н/Д (ошибка парсинга)";
        }
    }

    async loginGithub(page) {
        logger.log("Вход в GitHub...", "STEP");
        await page.fill('input[name="login"]', CONFIG.GH_USERNAME);
        await page.fill('input[name="password"]', CONFIG.GH_PASSWORD);
        await page.click('input[type="submit"]');
        await sleep(5000);

        if (page.url().includes('two-factor')) {
            await this.tg.send("🔐 <b>Нужен 2FA код</b>\nОтправьте <code>/code XXXXXX</code>");
            const code = await this.tg.waitCode(CONFIG.TWO_FACTOR_WAIT);
            if (code) {
                await page.fill('input[autocomplete="one-time-code"]', code);
                await page.keyboard.press('Enter');
                await sleep(5000);
            }
        }
        
        // Обработка кнопки Authorize
        const authBtn = page.locator('button[name="authorize"]');
        if (await authBtn.isVisible({ timeout: 5000 })) {
            await authBtn.click();
            await sleep(5000);
        }
        return true;
    }

    async notify(ok, balance = "", err = "") {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Shanghai' });
        let msg = `<b>🤖 ClawCloud Monitor</b>\n\n<b>Статус:</b> ${ok ? "✅ Успех" : "❌ Ошибка"}\n<b>Баланс:</b> <code>${balance}</code>\n<b>Время:</b> ${now}`;
        if (err) msg += `\n<b>Детали:</b> <code>${err}</code>`;
        await this.tg.send(msg);
        if (this.shots.length > 0) await this.tg.photo(this.shots[this.shots.length - 1], "Скриншот сессии");
    }

    async run() {
        logger.log("Запуск процесса...");
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

        if (CONFIG.GH_SESSION) {
            await context.addCookies([{ name: 'user_session', value: CONFIG.GH_SESSION, domain: 'github.com', path: '/' }]);
        }

        const page = await context.newPage();

        try {
            await page.goto(CONFIG.SIGNIN_URL, { waitUntil: 'networkidle' });
            
            // Если мы на странице логина, жмем GitHub
            if (page.url().includes('signin')) {
                const ghBtn = page.locator('button:has-text("GitHub"), .ant-btn-github');
                if (await ghBtn.isVisible()) {
                    await ghBtn.click();
                    await sleep(5000);
                    if (page.url().includes('github.com/login')) {
                        await this.loginGithub(page);
                    }
                }
            }

            await page.waitForURL(/claw\.cloud/, { timeout: 60000 });
            logger.log("Авторизация успешна", "SUCCESS");
            await sleep(8000); 

            // Сбор баланса
            const balance = await this.getBalance(page);
            
            // Обновление сессии
            const cookies = await context.cookies();
            const session = cookies.find(c => c.name === 'user_session');
            if (session) await this.secret.update('GH_SESSION', session.value);

            await this.shot(page, "final");
            await this.notify(true, balance);

        } catch (e) {
            logger.log(e.message, "ERROR");
            await this.notify(false, "Н/Д", e.message);
        } finally {
            await browser.close();
        }
    }
}

(new AutoLogin()).run();
