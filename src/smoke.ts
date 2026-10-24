/** ВРЕМЕННО: проверка исполнения на Alpaca paper — купить на $10 BTC/USD и продать обратно. */
import { setTimeout as sleep } from "node:timers/promises";
import { Alpaca, filledQuote, floorToStep } from "./alpaca.ts";

const base = process.env.ALPACA_BASE ?? "";
if (!base.includes("paper-api")) throw new Error("smoke только на paper");
const ex = new Alpaca(base, process.env.ALPACA_API_KEY ?? "", process.env.ALPACA_SECRET_KEY ?? "");
const sym = "BTC/USD";
const a = await ex.asset(sym);
console.log("asset", a, "buying power", await ex.buyingPower());
const before = ex.heldQty(await ex.positions(), sym);

const buy = await ex.market(sym, "buy", { notional: "10.00" }, `smoketest_buy_${Date.now()}`);
console.log("BUY", buy.status, buy.filled_qty, "@", buy.filled_avg_price, "=", filledQuote(buy).toFixed(2));

let avail = 0;
for (let i = 0; i < 20 && avail <= 0; i++) {
    avail = ex.heldQty(await ex.positions(), sym) - before;
    if (avail <= 0) await sleep(500);
}
console.log("position delta (after fee)", avail);
const q = floorToStep(Math.min(Number(buy.filled_qty), avail), a.step);
const sell = await ex.market(sym, "sell", { qty: q }, `smoketest_sell_${Date.now()}`);
console.log("SELL", sell.status, sell.filled_qty, "@", sell.filled_avg_price, "=", filledQuote(sell).toFixed(2));

const book = await ex.book(sym, "smoketest");
console.log("book(smoketest)", book);
