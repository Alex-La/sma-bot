/**
 * SMA-бот: сигнал по рыночным данным Binance (mainnet), исполнение на Binance Spot.
 * По умолчанию торгует на TESTNET.
 *
 * Капитал бота по графику пополнений:
 *   капитал = BOT_CAPITAL_USDT + BOT_MONTHLY_USDT × (число 1-х чисел месяца после BOT_START)
 * Каждое пополнение делится поровну между парами («корзины»).
 *
 * Логика (без хранения состояния):
 *  - позиция и денежный поток корзины восстанавливаются из истории ордеров бота
 *    (clientOrderId начинается с "smabot");
 *  - свободные деньги корзины = её доля капитала + продажи − покупки;
 *  - сигнал «держать»: всё свободное докупается (вход или довложение нового пополнения);
 *  - сигнал «вне рынка»: позиция продаётся целиком, пополнения копятся в USDT до следующего входа;
 *  - пропущенный или повторный запуск безопасен: бот просто приводит корзины к сигналу.
 *
 * ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BINANCE_API_KEY, BINANCE_API_SECRET,
 *      BINANCE_BASE (testnet по умолчанию), BOT_CAPITAL_USDT (1000), BOT_MONTHLY_USDT (0),
 *      BOT_START (YYYY-MM-DD, обязателен при BOT_MONTHLY_USDT > 0), MIN_ORDER_USDT (10),
 *      SMA_PERIOD (50), SYMBOLS (BTCUSDT,ETHUSDT — только пары к USDT), DRY_RUN ("1"), ALLOW_MAINNET ("1").
 */
import { pathToFileURL } from "node:url";
import { Binance, floorToStep, type SymbolFilters } from "./binance.ts";
import {
    SYMBOLS,
    dailyCloses,
    envNum,
    escapeHtml,
    evaluate,
    fmtPct,
    fmtPrice,
    renderSignals,
    sendTelegram,
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
    const monthly = envNum(env, "BOT_MONTHLY_USDT", 0, nonNeg, "нужно неотрицательное число");
    const start = env.BOT_START ? new Date(`${env.BOT_START}T00:00:00Z`) : null;
    if (start && Number.isNaN(start.getTime())) throw new Error(`BOT_START="${env.BOT_START}" — нужен формат YYYY-MM-DD`);
    if (monthly > 0 && !start) throw new Error("При BOT_MONTHLY_USDT > 0 нужен BOT_START (YYYY-MM-DD).");
    return {
        base: env.BINANCE_BASE ?? "https://testnet.binance.vision",
        key: env.BINANCE_API_KEY ?? "",
        secret: env.BINANCE_API_SECRET ?? "",
        initial: envNum(env, "BOT_CAPITAL_USDT", 1000, nonNeg, "нужно неотрицательное число"),
        monthly,
        start,
        minOrder: envNum(env, "MIN_ORDER_USDT", 10, (x) => x > 0, "нужно положительное число"),
        dryRun: env.DRY_RUN === "1",
    };
}

/** Сколько 1-х чисел месяца наступило после даты старта (включительно по сегодня, UTC). */
export function monthsElapsed(start: Date, now = new Date()): number {
    const m = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
    return Math.max(m, 0);
}

interface Slot {
    f: SymbolFilters;
    qty: number;
    cash: number; // продажи − покупки
    px: number;
    note: string;
    executed: boolean; // реально отправленный ордер — попадёт в отчёт даже при сбое дальше
}

const orderId = (symbol: string) => `${PREFIX}_${symbol}_${Math.floor(Date.now() / 1000)}`;

export async function run(): Promise<string> {
    const cfg = readConfig();
    const isTestnet = cfg.base.includes("testnet");
    if (!isTestnet && process.env.ALLOW_MAINNET !== "1") {
        throw new Error(`BINANCE_BASE=${cfg.base} не testnet. Для реальной торговли нужен ALLOW_MAINNET=1.`);
    }
    const hasKeys = Boolean(cfg.key && cfg.secret);
    if (!cfg.dryRun && !hasKeys) throw new Error("Нет BINANCE_API_KEY / BINANCE_API_SECRET.");

    const months = cfg.start ? monthsElapsed(cfg.start) : 0;
    const capital = cfg.initial + cfg.monthly * months;
    const per = capital / SYMBOLS.length;

    const signals = new Map<string, Signal>();
    for (const s of SYMBOLS) signals.set(s, evaluate(await dailyCloses(s)));

    const ex = new Binance(cfg.base, cfg.key, cfg.secret);
    await ex.syncTime();
    const free = hasKeys ? await ex.freeBalances() : new Map<string, number>();

    const slots = new Map<string, Slot>();
    for (const s of SYMBOLS) {
        const f = await ex.filters(s);
        // Капитал, MIN_ORDER_USDT и округление суммы покупки до 0.01 — всё в USDT.
        if (f.quote !== "USDT") throw new Error(`${s}: котировка в ${f.quote}, поддерживаются только пары к USDT.`);
        const { qty, cash } = hasKeys ? await ex.book(s, PREFIX) : { qty: 0, cash: 0 };
        slots.set(s, { f, qty, cash, px: await ex.price(s), note: "без изменений", executed: false });
    }
    // Порог входа. Для выхода берём только minNotional биржи: MIN_ORDER_USDT не должен запирать позицию.
    const minTrade = (st: Slot) => Math.max(cfg.minOrder, st.f.minNotional);

    try {
        // 1) Продажи: сигнал «вне рынка» — закрываем позицию целиком.
        for (const [s, st] of slots) {
            if (signals.get(s)!.inMarket || st.qty <= 0) continue;
            const q = floorToStep(Math.min(st.qty, free.get(st.f.base) ?? st.qty), st.f.step);
            if (Number(q) * st.px < st.f.minNotional) {
                st.note = `продать нечего (остаток ${q} ${st.f.base})`;
            } else if (cfg.dryRun) {
                st.note = `DRY_RUN: продал бы ${q} ${st.f.base}`;
            } else {
                const o = await ex.market(s, "SELL", { quantity: q }, orderId(s));
                const got = Number(o.cummulativeQuoteQty);
                free.set(st.f.quote, (free.get(st.f.quote) ?? 0) + got);
                st.qty -= Number(o.executedQty);
                st.cash += got;
                st.executed = true;
                st.note = `🔴 ПРОДАНО ${o.executedQty} ${st.f.base} → ${fmtPrice(got)} ${st.f.quote}`;
            }
        }

        // 2) Покупки: сигнал «держать» — вкладываем всё свободное в корзине (вход или новое пополнение).
        for (const [s, st] of slots) {
            if (!signals.get(s)!.inMarket) continue;
            const idle = per + st.cash;
            if (!Number.isFinite(idle) || idle < minTrade(st)) continue;
            const wasHolding = st.qty * st.px >= st.f.minNotional;
            const freeQuote = free.get(st.f.quote) ?? idle;
            const amt = floorToStep(Math.min(idle, freeQuote), "0.01");
            const what = wasHolding ? "довложение" : "вход";
            if (!(Number(amt) >= minTrade(st))) {
                st.note = `${what}: не хватает ${st.f.quote} на счёте (нужно ${fmtPrice(idle)}, доступно ${fmtPrice(freeQuote)})`;
            } else if (cfg.dryRun) {
                st.note = `DRY_RUN: ${what}, купил бы на ${fmtPrice(Number(amt))} ${st.f.quote}`;
            } else {
                const o = await ex.market(s, "BUY", { quoteOrderQty: amt }, orderId(s));
                const q = Number(o.executedQty);
                const spent = Number(o.cummulativeQuoteQty);
                free.set(st.f.quote, (free.get(st.f.quote) ?? 0) - spent);
                st.qty += q;
                st.cash -= spent;
                st.executed = true;
                st.note = `🟢 ${wasHolding ? "ДОКУПЛЕНО" : "КУПЛЕНО"} ${o.executedQty} ${st.f.base} на ${fmtPrice(spent)} ${st.f.quote} (~${fmtPrice(q ? spent / q : 0)})`;
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
        `<b>Исполнение</b> (${isTestnet ? "testnet" : "⚠️ MAINNET"}${cfg.dryRun ? ", DRY_RUN" : ""})`,
    ];
    let total = 0;
    let idleTotal = 0;
    for (const [s, st] of slots) {
        const idle = Math.max(per + st.cash, 0);
        const value = idle + st.qty * st.px;
        total += value;
        idleTotal += idle;
        lines.push(`<b>${s.replace(/USDT$/, "")}</b>: ${st.note}`);
        lines.push(`   корзина ${fmtPrice(value)} USDT, из них в USDT ${fmtPrice(idle)}`);
    }
    lines.push("");
    lines.push(`Вложено: ${fmtPrice(capital)} USDT` + (cfg.monthly > 0 ? ` (${fmtPrice(cfg.initial)} + ${months}×${fmtPrice(cfg.monthly)})` : ""));
    lines.push(`Стоимость: ${fmtPrice(total)} USDT (${fmtPct(total / capital - 1)}), в USDT ${fmtPrice(idleTotal)}`);
    const freeQuote = free.get("USDT");
    if (hasKeys && freeQuote !== undefined && freeQuote + 1 < idleTotal) {
        lines.push(`⚠️ На счёте ${fmtPrice(freeQuote)} USDT — меньше, чем ждут корзины. Пополнение не пришло?`);
    }
    return lines.join("\n");
}

async function main(): Promise<void> {
    try {
        const text = await run();
        console.log(text);
        await sendTelegram(text);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`ERROR: ${msg}`);
        // Без escape любая HTML-страница от апстрима (451/502) ломает parse_mode=HTML и алерт не доходит.
        await sendTelegram(`❗️ SMA-бот: ошибка\n<code>${escapeHtml(msg.slice(0, 500))}</code>`).catch(() => { });
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
