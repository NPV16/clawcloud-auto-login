/**
 * ClawCloud 自动登录 & 余额监控 (Node.js 版)
 * - Авторизация через GitHub (поддержка 2FA через Telegram)
 * - Парсинг баланса кредитов ($4.99 / $5 used)
 * - Автоматическое обновление GH_SESSION в GitHub Secrets
 */

const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const sodium = require('libsodium-wrappers');

// ==================== 配置 (Environment Variables) ====================
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
        const icon = icons[level] || "•";
        const line = `${icon} ${msg}`;
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
        this.ok = !!(this.token && this.chatId);
        this.apiBase = `https://api.telegram.org/bot${this.token}`;
    }

    async send(msg) {
        if (!this.ok) return;
        try {
            await axios.post(`${this.apiBase}/sendMessage`, {
                chat_id: this.chatId,
                text: msg,
                parse_mode: "HTML"
            });
        } catch (e) { /* ignore */ }
    }

    async photo(filePath, caption = "") {
        if (!this.ok || !fs.existsSync(filePath)) return;
        try {
            const form = new FormData();
            form.append('chat_id', this.chatId);
            form.append('caption', caption.substring(0, 1024));
            form.append('photo', fs.createReadStream(filePath));
            await axios.post(`${this.apiBase}/sendPhoto`, form, { headers: form.getHeaders() });
        } catch (e) { /* ignore */ }
    }

    async waitCode(timeoutSec = 120) {
        if (!this.ok) return null;
        let offset = 0;
        const deadline = Date.now() + timeoutSec * 1000;
        logger.log(`Ожидание кода из Telegram (/code XXXXXX)...`, "INFO");
        while (Date.now() < deadline) {
            try {
                const res = await axios.get(`${this.apiBase}/getUpdates`, { params: { offset: offset, timeout: 10 } });
                if (res.data.ok) {
                    for (const upd of res.data.result) {
                        offset = upd.update_id + 1;
                        if (upd.message && String(upd.message.chat.id) === String(this.chatId)) {
                            const match = (upd.message.text || "").match(/^\/code\s+(\d{6,8})$/);
                            if (match) return match[1];
                        }
                    }
                }
            } catch (e) { await sleep(2000); }
        }
        return null;
    }
}

class SecretUpdater {
    constructor() {
        this.token = CONFIG.REPO_TOKEN;
        this.repo = CONFIG.GITHUB_REPOSITORY;
    }
    async update(name, value) {
        if (!this.token || !this.repo) return false;
        try {
            await sodium.ready;
            const headers = { "Authorization": `token ${this.token}`, "Accept": "application/vnd.github.v3+json" };
            const { data: keyData } = await axios.get(`https://api.github.com/repos/${this.repo}/actions/secrets/public-key`, { headers });
            const binkey = sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL);
            const encBytes = sodium.crypto_box_seal(sodium.from_string(value), binkey);
            await axios.put(`https://api.github.com/repos/${this.repo}/actions/secrets/${name}`, {
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
        try {
            await page.screenshot({ path: filename });
            this.shots.push(filename);
            return filename;
        } catch (e) { return null; }
    }

    async getBalance(page) {
        logger.log("Шаг: Переход на страницу Plan для парсинга баланса...", "STEP");
        try {
            await page.goto(`${CONFIG.CLAW_CLOUD_URL}/plan`, { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForSelector('text=Credits Available', { timeout: 20000 });

            // Более гибкий поиск через evaluate
            const balanceData = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('div, span, p'));
                // Ищем элемент с цифрами баланса (напр. $4.99)
                const mainBalance = elements.find(el => /^\$\d+\.\d+$/.test(el.innerText.trim()))?.innerText || "Н/Д";
                // Ищем строку с использованием (напр. $0/5 used)
                const details = elements.find(el => el.innerText.includes('used'))?.innerText || "0/5 used";
                return { mainBalance, details };
            });

            const info = `${balanceData.mainBalance} (${balanceData.details.trim()})`;
            logger.log(`Баланс получен: ${info}`, "SUCCESS");
            return info;
        } catch (e) {
            logger.log(`Ошибка парсинга баланса: ${e.message}`, "WARN");
            const s = await this.shot(page, "balance_error");
            if (s) await this.tg.photo(s, "Ошибка при поиске баланса");
            return "Ошибка (см. скриншот)";
        }
    }

    async loginGithub(page) {
        logger.log("Вход в GitHub...", "STEP");
        try {
            await page.fill('input[name="login"]', CONFIG.GH_USERNAME);
            await page.fill('input[name="password"]', CONFIG.GH_PASSWORD);
            await page.click('input[type="submit"]');
            await sleep(5000);

            if (page.url().includes('two-factor')) {
                const s = await this.shot(page, "2fa_required");
                await this.tg.send("🔐 <b>Требуется 2FA</b>\n\nОтправьте в этот чат:\n<code>/code XXXXXX</code>");
                if (s) await this.tg.photo(s);
                
                const code = await this.tg.waitCode(CONFIG.TWO_FACTOR_WAIT);
                if (code) {
                    logger.log(`Код получен, ввожу: ${code}`, "SUCCESS");
                    await page.fill('input[autocomplete="one-time-code"]', code);
                    await page.keyboard.press('Enter');
                    await sleep(5000);
                } else {
                    throw new Error("Тайм-аут ожидания кода 2FA");
                }
            }
            return !page.url().includes('login');
        } catch (e) {
            logger.log(`Ошибка логина GitHub: ${e.message}`, "ERROR");
            return false;
        }
    }

    async notify(ok, balance = "", err = "") {
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Shanghai' });
        let msg = `<b>🤖 ClawCloud Monitor</b>\n\n` +
                  `<b>Статус:</b> ${ok ? "✅ Успех" : "❌ Ошибка"}\n` +
                  `<b>Баланс:</b> <code>${balance || "Н/Д"}</code>\n` +
                  `<b>Время:</b> ${now}`;
        
        if (err) msg += `\n<b>Детали:</b> <code>${err}</code>`;
        msg += `\n\n<b>Логи:</b>\n${logger.getRecentLogs()}`;
        
        await this.tg.send(msg);
        if (this.shots.length > 0) {
            await this.tg.photo(this.shots[this.shots.length - 1], ok ? "Успешное завершение" : "Скриншот ошибки");
        }
    }

    async run() {
        logger.log("Запуск скрипта мониторинга...");
        const browser = await chromium.launch({ 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        if (CONFIG.GH_SESSION) {
            await context.addCookies([{ name: 'user_session', value: CONFIG.GH_SESSION, domain: 'github.com', path: '/' }]);
            logger.log("Загружена существующая сессия", "SUCCESS");
        }

        const page = await context.newPage();

        try {
            logger.log("Переход на ClawCloud...", "STEP");
            await page.goto(CONFIG.SIGNIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
            await sleep(3000);

            if (page.url().includes('signin')) {
                logger.log("Требуется авторизация через GitHub", "INFO");
                await page.click('button:has-text("GitHub")');
                await sleep(5000);
                
                if (page.url().includes('github.com/login')) {
                    const success = await this.loginGithub(page);
                    if (!success) throw new Error("Не удалось войти в GitHub");
                }
            }

            // Ждем перенаправления в панель ClawCloud
            await page.waitForURL(/claw\.cloud/, { timeout: 40000 });
            logger.log("Авторизация успешна", "SUCCESS");

            // ПАРСИНГ БАЛАНСА
            const balance = await this.getBalance(page);
            
            // Сохранение/обновление сессии в GitHub Secrets
            const cookies = await context.cookies();
            const session = cookies.find(c => c.name === 'user_session');
            if (session) {
                const updated = await this.secret.update('GH_SESSION', session.value);
                if (updated) logger.log("GH_SESSION обновлен в GitHub Secrets", "SUCCESS");
            }

            await this.shot(page, "success_final");
            await this.notify(true, balance);
            logger.log("Скрипт успешно завершен", "SUCCESS");

        } catch (e) {
            logger.log(`Критическая ошибка: ${e.message}`, "ERROR");
            await this.shot(page, "critical_error");
            await this.notify(false, "Ошибка", e.message);
        } finally {
            await browser.close();
        }
    }
}

// Запуск
(new AutoLogin()).run();
