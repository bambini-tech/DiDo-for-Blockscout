/**
 * Launch signals: who bought in the first moments of trading.
 *
 * Blockscout's Etherscan-compatible `getLogs` returns the token's Transfer
 * events from its creation block on (up to 1,000 per call). A transfer OUT of
 * a liquidity pool is a buy. The first buy marks the launch; then
 *
 *   bundle   a wallet that bought in that same first block
 *   sniper   a wallet that bought after it, within `sniperWindowSec`
 *
 * Pools are the ones the caller knows (the pair the page trades on, and
 * holders Blockscout names as pools). If no buy shows up in the pages read,
 * the answer is "not measured" -- never "no snipers".
 */
import type { BlockscoutClient, Status } from './client.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface Buy {
  buyer: string;
  raw: string;
  block: number;
  ts: number | null;
}

export interface Launch {
  status: Status;
  /** False when no buy from a known pool was found in the logs read. */
  measured: boolean;
  launchBlock: number | null;
  launchTs: number | null;
  bundles: Buy[];
  snipers: Buy[];
}

interface RawLog {
  topics?: Array<string | null>;
  data?: string;
  blockNumber?: string;
  timeStamp?: string;
}

export interface LaunchOptions {
  sniperWindowSec?: number;
  maxPages?: number;
}

export async function readLaunch(
  client: BlockscoutClient,
  chainId: number,
  token: string,
  fromBlock: number,
  pools: Set<string>,
  exclude: Set<string>,
  opts: LaunchOptions = {},
): Promise<Launch> {
  const windowSec = opts.sniperWindowSec ?? 60;
  const maxPages = opts.maxPages ?? 3;
  const none: Launch = { status: 'ok', measured: false, launchBlock: null, launchTs: null, bundles: [], snipers: [] };
  if (!pools.size) return none;

  let from = fromBlock;
  let launch: { block: number; ts: number | null } | null = null;
  const bundles = new Map<string, Buy>();
  const snipers = new Map<string, Buy>();
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const res = await client.etherscan<RawLog[]>(chainId, {
      module: 'logs', action: 'getLogs', address: token, topic0: TRANSFER_TOPIC, fromBlock: from, toBlock: 'latest',
    });
    if (res.status !== 'ok' || !Array.isArray(res.data)) return { ...none, status: 'error' };
    const logs = res.data;
    let done = false;
    for (const log of logs) {
      const block = toNum(log.blockNumber);
      if (block === null) continue;
      const key = `${block}:${log.topics?.[1]}:${log.topics?.[2]}:${log.data}`;
      if (seen.has(key)) continue; // the next page starts at the last block read
      seen.add(key);
      const src = topicAddress(log.topics?.[1]);
      const dst = topicAddress(log.topics?.[2]);
      if (!src || !dst || !pools.has(src) || pools.has(dst) || exclude.has(dst)) continue;
      const ts = toNum(log.timeStamp);
      if (!launch) launch = { block, ts };
      const buy: Buy = { buyer: dst, raw: rawAmount(log.data), block, ts };
      if (block === launch.block) addBuy(bundles, buy);
      else if (ts !== null && launch.ts !== null && ts - launch.ts <= windowSec && !bundles.has(dst)) addBuy(snipers, buy);
      else {
        done = true;
        break;
      }
    }
    if (done || logs.length < 1000) break;
    from = toNum(logs[logs.length - 1]?.blockNumber) ?? from;
  }
  if (!launch) return none;
  return {
    status: 'ok',
    measured: true,
    launchBlock: launch.block,
    launchTs: launch.ts,
    bundles: [...bundles.values()],
    snipers: [...snipers.values()],
  };
}

function addBuy(map: Map<string, Buy>, buy: Buy): void {
  const prev = map.get(buy.buyer);
  map.set(buy.buyer, prev ? { ...prev, raw: (BigInt(prev.raw) + BigInt(buy.raw)).toString() } : buy);
}

/** The address in an indexed topic: its last 20 bytes, lowercased. */
export function topicAddress(topic: string | null | undefined): string | null {
  if (!topic || topic.length < 42) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function rawAmount(data: string | undefined): string {
  try {
    return BigInt(data && data !== '0x' ? data : '0x0').toString();
  } catch {
    return '0';
  }
}

/** Blockscout's Etherscan-compatible routes send numbers as hex or decimal strings. */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' && /^0x/i.test(v) ? parseInt(v, 16) : Number(v);
  return Number.isFinite(n) ? n : null;
}
