/** ВРЕМЕННО: проверка списания по notional-ордеру. */
import { Alpaca, type Order } from "./alpaca.ts";

const base = process.env.ALPACA_BASE ?? "";
if (!base.includes("paper-api")) throw new Error("smoke только на paper");
const ex = new Alpaca(base, process.env.ALPACA_API_KEY ?? "", process.env.ALPACA_SECRET_KEY ?? "");
console.log("account", await ex.req("GET", `${base}/v2/account`));
const orders = await ex.req<Order[]>("GET", `${base}/v2/orders`, { status: "all", limit: 10 });
for (const o of orders) console.log(JSON.stringify(o));
console.log("activities", JSON.stringify(await ex.req("GET", `${base}/v2/account/activities`, { page_size: 20 })));
