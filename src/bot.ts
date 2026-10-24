/**
 * SMA-бот: сигнал по рыночным данным Binance (mainnet), исполнение на Alpaca (крипто, пары к USD).
 * По умолчанию торгует на PAPER-счёте Alpaca.
 *
 * Капитал бота по графику пополнений:
 *   капитал = BOT_CAPITAL_USD + BOT_MONTHLY_USD × (число 1-х чисел месяца после BOT_START)
 * Каждое пополнение делится поровну между парами («корзины»).
 *
 * Логика (без хранения состояния):
 *  - позиция и денежный поток корзины восстанавливаются из истории ордеров бота
 *    (clientOrderId начинается с "smabot");
 *  - свободные деньги корзины = её доля капитала + продажи − покупки;
 *  - сигнал «держать»: всё свободное докупается (вход или довложение нового пополнения);
 *  - сигнал «вне рынка»: позиция продаётся целиком, пополнения копятся в USD до следующего входа;
 *  - пропущенный или повторный запуск безопасен: бот просто приводит корзины к сигналу.
 *
 * ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALPACA_API_KEY, ALPACA_SECRET_KEY,
 *      ALPACA_BASE (paper по умолчанию), BOT_CAPITAL_USD (1000), BOT_MONTHLY_USD (0),
 *      BOT_START (YYYY-MM-DD, обязателен при BOT_MONTHLY_USD > 0), MIN_ORDER_USD (10),
 *      SMA_PERIOD (50), SYMBOLS (BTCUSDT,ETHUSDT — пары Binance к USDT для сигнала; на Alpaca торгуются BTC/USD, ETH/USD),
 *      DRY_RUN ("1"), ALLOW_LIVE ("1").
 */
import { pathToFileURL } from "node:url";
import { Alpaca, filledQuote, floorToStep, type Asset } from "./alpaca.ts";
import {
    SYMBOLS,
    dailyCloses,
    envNum,
    escapeHtml,
    evaluate,
    fmtPct,
    fmtPrice,
    htmlToMarkdown,
    renderSignals,
    sendTelegram,
    writeSummary,
    type Signal,
} from "./signal.ts";

const PREFIX = "smabot";

interface Config {
    base: string;
    key: string;
    secret: string;
    initial: number;
    monthly: number;
    start: Date | null;
    minOrder: number;
    dryRun: boolean;
}

function readConfig(env = process.env): Config {
    const nonNeg = (x: number) => x >= 0;
    const monthly = envNum(env, "BOT_MONTHLY_USD", 0, nonNeg, "нужно неотрицательное число");
    const start = env.BOT_START ? new Date(`${env.BOT_START}T00:00:00Z`) : null;
    if (start && Number.isNaN(start.getTime())) throw new Error(`BOT_START="${env.BOT_START}" — нужен формат YYYY-MM-DD`);
    if (monthly > 0 && !start) throw new Error("При BOT_MONTHLY_USD > 0 нужен BOT_START (YYYY-MM-DD).");
    return {
        base: env.ALPACA_BASE ?? "https://paper-api.alpaca.markets",
        key: env.ALPACA_API_KEY ?? "",
        secret: env.ALPACA_SECRET_KEY ?? "",
        initial: envNum(env, "BOT_CAPITAL_USD", 1000, nonNeg, "нужно неотрицательное число"),
        monthly,
        start,
        minOrder: envNum(env, "MIN_ORDER_USD", 10, (x) => x > 0, "нужно положительное число"),
        dryRun: env.DRY_RUN === "1",
    };
}

/** Сколько 1-х чисел месяца наступило после даты старта (включительно по сегодня, UTC). */
export function monthsElapsed(start: Date, now = new Date()): number {
    const m = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
    return Math.max(m, 0);
}

interface Slot {
    a: Asset;
    qty: number;
    cash: number; // продажи − покупки
    px: number;
    note: string;
    executed: boolean; // реально отправленный ордер — попадёт в отчёт даже при сбое дальше
}

const orderId = (a: Asset) => `${PREFIX}_${a.base}${a.quote}_${Math.floor(Date.now() / 1000)}`;

/** Пара Binance для сигнала → пара Alpaca для исполнения: BTCUSDT → BTC/USD. */
const alpacaSymbol = (s: string) => `${s.replace(/USDT$/, "")}/USD`;

export async function run(): Promise<string> {
    const cfg = readConfig();
    const isPaper = cfg.base.includes("paper-api");
    if (!isPaper && process.env.ALLOW_LIVE !== "1") {
        throw new Error(`ALPACA_BASE=${cfg.base} не paper. Для реальной торговли нужен ALLOW_LIVE=1.`);
    }
    // Ключи нужны и в DRY_RUN: без них Alpaca не отдаёт ни ассеты, ни цены.
    if (!cfg.key || !cfg.secret) throw new Error("Нет ALPACA_API_KEY / ALPACA_SECRET_KEY.");

    const months = cfg.start ? monthsElapsed(cfg.start) : 0;
    const capital = cfg.initial + cfg.monthly * months;
    const per = capital / SYMBOLS.length;

    const signals = new Map<string, Signal>();
    for (const s of SYMBOLS) signals.set(s, evaluate(await dailyCloses(s)));

    const ex = new Alpaca(cfg.base, cfg.key, cfg.secret);
    let freeCash = await ex.buyingPower();
    const held = await ex.positions();

    const slots = new Map<string, Slot>();
    for (const s of SYMBOLS) {
        if (!s.endsWith("USDT")) throw new Error(`${s}: поддерживаются только пары к USDT (сигнал) → USD (Alpaca).`);
        const a = await ex.asset(alpacaSymbol(s));
        // Капитал, MIN_ORDER_USD и округление суммы покупки до 0.01 — всё в USD.
        if (a.quote !== "USD") throw new Error(`${a.symbol}: котировка в ${a.quote}, поддерживаются только пары к USD.`);
        const { qty, cash } = await ex.book(a.symbol, PREFIX);
        slots.set(s, { a, qty, cash, px: await ex.price(a.symbol), note: "без изменений", executed: false });
    }
    // Порог входа. Для выхода берём только минимум биржи: MIN_ORDER_USD не должен запирать позицию.
    const minTrade = (st: Slot) => Math.max(cfg.minOrder, st.a.minNotional);

    try {
        // 1) Продажи: сигнал «вне рынка» — закрываем позицию целиком.
        for (const [s, st] of slots) {
            if (signals.get(s)!.inMarket || st.qty <= 0) continue;
            const q = floorToStep(Math.min(st.qty, ex.heldQty(held, st.a.symbol)), st.a.step);
            if (Number(q) * st.px < st.a.minNotional) {
                st.note = `продать нечего (остаток ${q} ${st.a.base})`;
            } else if (cfg.dryRun) {
                st.note = `DRY_RUN: продал бы ${q} ${st.a.base}`;
            } else {
                const o = await ex.market(st.a.symbol, "sell", { qty: q }, orderId(st.a));
                const got = filledQuote(o);
                freeCash += got;
                st.qty -= Number(o.filled_qty);
                st.cash += got;
                st.executed = true;
                st.note = `🔴 ПРОДАНО ${o.filled_qty} ${st.a.base} → ${fmtPrice(got)} ${st.a.quote}`;
            }
        }

        // 2) Покупки: сигнал «держать» — вкладываем всё свободное в корзине (вход или новое пополнение).
        for (const [s, st] of slots) {
            if (!signals.get(s)!.inMarket) continue;
            const idle = per + st.cash;
            if (!Number.isFinite(idle) || idle < minTrade(st)) continue;
            const wasHolding = st.qty * st.px >= st.a.minNotional;
            const amt = floorToStep(Math.min(idle, freeCash), "0.01");
            const what = wasHolding ? "довложение" : "вход";
            if (!(Number(amt) >= minTrade(st))) {
                st.note = `${what}: не хватает ${st.a.quote} на счёте (нужно ${fmtPrice(idle)}, доступно ${fmtPrice(freeCash)})`;
            } else if (cfg.dryRun) {
                st.note = `DRY_RUN: ${what}, купил бы на ${fmtPrice(Number(amt))} ${st.a.quote}`;
            } else {
                const o = await ex.market(st.a.symbol, "buy", { notional: amt }, orderId(st.a));
                const q = Number(o.filled_qty);
                const spent = filledQuote(o);
                freeCash -= spent;
                st.qty += q;
                st.cash -= spent;
                st.executed = true;
                st.note = `🟢 ${wasHolding ? "ДОКУПЛЕНО" : "КУПЛЕНО"} ${o.filled_qty} ${st.a.base} на ${fmtPrice(spent)} ${st.a.quote} (~${fmtPrice(q ? spent / q : 0)})`;
            }
        }
    } catch (e) {
        // Сбой на второй паре не должен скрыть уже исполненный ордер по первой.
        const done = [...slots].filter(([, st]) => st.executed).map(([s, st]) => `${s}: ${st.note}`);
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(done.length ? `${msg}\n\nУспели исполнить:\n${done.join("\n")}` : msg);
    }

    // Отчёт
    const lines = [
        renderSignals(signals),
        "",
        `<b>Исполнение</b> (${isPaper ? "Alpaca paper" : "⚠️ Alpaca LIVE"}${cfg.dryRun ? ", DRY_RUN" : ""})`,
    ];
    let total = 0;
    let idleTotal = 0;
    for (const [s, st] of slots) {
        const idle = Math.max(per + st.cash, 0);
        const value = idle + st.qty * st.px;
        total += value;
        idleTotal += idle;
        lines.push(`<b>${s.replace(/USDT$/, "")}</b>: ${st.note}`);
        lines.push(`   корзина ${fmtPrice(value)} USD, из них в USD ${fmtPrice(idle)}`);
    }
    lines.push("");
    lines.push(`Вложено: ${fmtPrice(capital)} USD` + (cfg.monthly > 0 ? ` (${fmtPrice(cfg.initial)} + ${months}×${fmtPrice(cfg.monthly)})` : ""));
    lines.push(`Стоимость: ${fmtPrice(total)} USD (${fmtPct(total / capital - 1)}), в USD ${fmtPrice(idleTotal)}`);
    if (freeCash + 1 < idleTotal) {
        lines.push(`⚠️ На счёте ${fmtPrice(freeCash)} USD — меньше, чем ждут корзины. Пополнение не пришло?`);
    }
    return lines.join("\n");
}

async function main(): Promise<void> {
    try {
        const text = await run();
        console.log(text);
        // Сводку пишем ДО Telegram: отчёт не должен пропадать, если Telegram недоступен.
        await writeSummary(htmlToMarkdown(text)).catch((e) => console.error(`summary: ${e}`));
        await sendTelegram(text);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`ERROR: ${msg}`);
        // В сводке — блок кода: внутри него ничего не интерпретируется, даже HTML-страница от апстрима.
        await writeSummary(`## ❗️ SMA-бот: ошибка\n\n\`\`\`\n${msg}\n\`\`\``).catch((e2) => console.error(`summary: ${e2}`));
        // Без escape любая HTML-страница от апстрима (451/502) ломает parse_mode=HTML и алерт не доходит.
        await sendTelegram(`❗️ SMA-бот: ошибка\n<code>${escapeHtml(msg.slice(0, 500))}</code>`).catch(() => { });
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
