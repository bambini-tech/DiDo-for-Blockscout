/**
 * Address reads: who deployed a contract, how busy an address is, and where a
 * wallet's money came from.
 *
 * Casing: REST v2 answers in EIP-55 mixed case, the Etherscan-compat routes in
 * lowercase. Everything leaving this file is lowercase, so callers can compare
 * addresses as plain strings.
 */
import type { BlockscoutClient, Status } from './client.js';

/** The contract's deployer, from `creator_address_hash`. */
export async function getCreator(
  client: BlockscoutClient,
  chainId: number,
  contract: string,
): Promise<{ creator: string | null; status: Status }> {
  const { data, status } = await client.rest<{ creator_address_hash?: string | null }>(chainId, `addresses/${contract}`);
  if (status !== 'ok' || !data) return { creator: null, status: status === 'ok' ? 'error' : status };
  return { creator: data.creator_address_hash ? data.creator_address_hash.toLowerCase() : null, status: 'ok' };
}

/** Lifetime transaction count, from `/addresses/{a}/counters`. */
export async function getTxCount(
  client: BlockscoutClient,
  chainId: number,
  address: string,
): Promise<{ count: number | null; status: Status }> {
  const { data, status } = await client.rest<{ transactions_count?: string | number }>(chainId, `addresses/${address}/counters`);
  if (status !== 'ok' || !data) return { count: null, status: status === 'ok' ? 'error' : status };
  const n = Number(data.transactions_count);
  return Number.isFinite(n) ? { count: n, status: 'ok' } : { count: null, status: 'error' };
}

/** A native-coin movement between the traced wallet and one counterparty. */
export interface Flow {
  peer: string;
  dir: 'in' | 'out';
  /** Wei, as a decimal string. */
  value: string;
  block: number | null;
  ts: number | null;
  internal: boolean;
}

export type FundingKind = 'transfer' | 'internal' | 'first-tx';

export interface FundingTrace {
  wallet: string;
  status: Status;
  /** First wallet that sent this one native coin. */
  funder: string | null;
  /**
   * transfer  first inbound plain transfer (strong)
   * internal  first inbound internal transfer, e.g. through a bridge or a contract (strong)
   * first-tx  no inflow in the window; the counterparty of the wallet's first transaction (weak, shown but never linked on)
   */
  kind: FundingKind | null;
  firstTs: number | null;
  /** Every native in/outflow in the window: the wallet's counterparties. */
  flows: Flow[];
}

interface RawTx {
  from?: string;
  to?: string;
  value?: string;
  timeStamp?: string;
  blockNumber?: string;
  isError?: string;
}

/**
 * Trace a wallet's oldest `window` transactions. One txlist read always; one
 * txlistinternal read only when no plain transfer funded the wallet.
 *
 * It reads the OLDEST history, so `funder` answers "where did this wallet come
 * from". `flows` keeps every counterparty in the window, which is what catches
 * an operator who tops up wallets that already existed.
 */
export async function traceFunding(
  client: BlockscoutClient,
  chainId: number,
  wallet: string,
  window = 20,
): Promise<FundingTrace> {
  const me = wallet.toLowerCase();
  const out: FundingTrace = { wallet: me, status: 'ok', funder: null, kind: null, firstTs: null, flows: [] };

  const txs = await client.etherscan<RawTx[]>(chainId, {
    module: 'account', action: 'txlist', address: me, sort: 'asc', page: 1, offset: window,
  });
  if (txs.status !== 'ok' || !Array.isArray(txs.data)) return { ...out, status: 'error' };
  const list = txs.data;
  out.firstTs = toNum(list[0]?.timeStamp);

  let funding: Flow | null = null;
  for (const tx of list) {
    if (tx.isError === '1') continue;
    const flow = toFlow(tx, me, false);
    if (!flow) continue;
    out.flows.push(flow);
    if (!funding && flow.dir === 'in') funding = flow;
  }
  if (funding) return { ...out, funder: funding.peer, kind: 'transfer' };

  const itxs = await client.etherscan<RawTx[]>(chainId, {
    module: 'account', action: 'txlistinternal', address: me, sort: 'asc', page: 1, offset: window,
  });
  if (itxs.status !== 'ok' || !Array.isArray(itxs.data)) return { ...out, status: 'error' };
  for (const tx of itxs.data) {
    if (tx.isError === '1') continue;
    const flow = toFlow(tx, me, true);
    if (!flow || flow.dir !== 'in') continue;
    out.flows.push(flow);
    if (!funding) funding = flow;
  }
  if (funding) return { ...out, funder: funding.peer, kind: 'internal' };

  const first = (list[0]?.from ?? '').toLowerCase();
  if (first && first !== me) return { ...out, funder: first, kind: 'first-tx' };
  return out;
}

function toFlow(tx: RawTx, me: string, internal: boolean): Flow | null {
  let value: bigint;
  try {
    value = BigInt(tx.value ?? '0');
  } catch {
    return null;
  }
  if (value <= 0n) return null;
  const from = (tx.from ?? '').toLowerCase();
  const to = (tx.to ?? '').toLowerCase();
  let peer: string;
  let dir: 'in' | 'out';
  if (to === me && from && from !== me) [peer, dir] = [from, 'in'];
  else if (from === me && to && to !== me) [peer, dir] = [to, 'out'];
  else return null;
  return { peer, dir, value: value.toString(), block: toNum(tx.blockNumber), ts: toNum(tx.timeStamp), internal };
}

function toNum(v: unknown): number | null {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null;
}
