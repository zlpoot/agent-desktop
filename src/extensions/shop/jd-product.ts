/**
 * 京东商品页解析（扩展侧）：仅由 shop.jd facet provider 在当次页面通过核心托管的只读 readDom 调用。
 * 本文件位于扩展层，不进入核心 import 图；核心运行时不再认识任何站点。
 */

export interface JdProductData {
  title: string;
  capacityGb?: number;
  priceYuan?: number;
  priceSource?: string;
}

export function memoryCapacityGb(title: string): number | undefined {
  const pair = title.match(/(?:16\s*(?:G|GB)\s*[×xX*]\s*2|2\s*[×xX*]\s*16\s*(?:G|GB))/i);
  if (pair) return 32;
  const single = title.match(/(?:^|[^\d])(\d{1,3})\s*(?:GB|G)(?![\w])/i);
  return single ? Number(single[1]) : undefined;
}

interface DomReader {
  (request: { selector: string; attribute?: string }):
    Promise<Array<{ text?: string; attr?: string }>>;
}

const PRICE_READS: Array<{ selector: string; attribute?: string }> = [
  { selector: ".summary-price .p-price .price" },
  { selector: "#jd-price .price" },
  { selector: "[itemprop='price']" },
  { selector: "meta[property='product:price:amount']", attribute: "content" },
];

/** 只在 item.jd.com 商品详情页返回数据；其余页面返回 undefined（无 facet）。 */
export async function readJdProduct(
  url: string,
  readDom: DomReader,
): Promise<JdProductData | undefined> {
  let host: string;
  try { host = new URL(url).hostname; } catch { return undefined; }
  if (host !== "item.jd.com") return undefined;

  const titleNodes = await readDom({ selector: ".sku-name" }).catch(() => []);
  const title = (titleNodes.find((node) => node.text?.trim())?.text ?? "").trim()
    || ((await readDom({ selector: "title" }).catch(() => [])).find((node) => node.text?.trim())?.text ?? "").trim();
  if (!title) return undefined;

  for (const read of PRICE_READS) {
    const nodes = await readDom(read).catch(() => []);
    const raw = nodes.map((node) => (read.attribute ? node.attr : node.text) ?? "").find(Boolean);
    const match = raw?.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
    const priceYuan = match ? Number(match[0]) : undefined;
    if (priceYuan && priceYuan > 0) {
      return { title, capacityGb: memoryCapacityGb(title), priceYuan,
        priceSource: read.attribute ? `${read.selector}@${read.attribute}` : read.selector };
    }
  }
  return { title, capacityGb: memoryCapacityGb(title) };
}
