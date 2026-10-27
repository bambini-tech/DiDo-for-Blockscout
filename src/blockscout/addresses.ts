/**
 * Address reads: who deployed a contract, how busy an address is, and where a
 * wallet's money came from.
 *
 * Casing: REST v2 answers in EIP-55 mixed case, the Etherscan-compat routes in
 * lowercase. Everything leaving this file is lowercase, so callers can compare
 * addresses as plain strings.
 */
import type { BlockscoutClient, Status } from './client.js';

/** The contract's deployer and creation transaction, from its address row. */
export async function getCreator(
  client: BlockscoutClient,
  chainId: number,
  contract: string,
): Promise<{ creator: string | null; creationTx: string | null; status: Status }> {
  const { data, status } = await client.rest<{ creator_address_hash?: string | null; creation_transaction_hash?: string | null; creation_tx_hash?: string | null }>(
    chainId, `addresses/${contract}`);
  if (status !== 'ok' || !data) return { creator: null, creationTx: null, status: status === 'ok' ? 'error' : status };
  const tx = data.creation_transaction_hash ?? data.creation_tx_hash ?? null;
  return {
    creator: data.creator_address_hash ? data.creator_address_hash.toLowerCase() : null,
    creationTx: tx ? tx.toLowerCase() : null,
    status: 'ok',
  };
}

/** A transaction's block and time (REST v2 `/transactions/{hash}`). */
export async function getTxBlock(
  client: BlockscoutClient,
  chainId: number,
  hash: string,
): Promise<{ block: number | null; ts: number | null; status: Status }> {
  const { data, status } = await client.rest<{ block_number?: number | string; block?: number | string; timestamp?: string }>(
    chainId, `transactions/${hash}`);
  if (status !== 'ok' || !data) return { block: null, ts: null, status: status === 'ok' ? 'error' : status };
  const block = toNum(data.block_number ?? data.block);
  const ms = data.timestamp ? Date.parse(data.timestamp) : NaN;
  return { block, ts: Number.isFinite(ms) ? Math.floor(ms / 1000) : null, status: 'ok' };
}

/** Lifetime transaction count, from `/addresses/{a}/counters`. */
export async function getTxCount(
  client: BlockscoutClient,
  chainId: number,
  address: string,
): Promise<{ count: number | null; status: Status }> {
  // A count that does not come back quickly is "unknown" (no shared-funder
  // link is claimed on it), never a reason to hold the whole map.
  const { data, status } = await client.rest<{ transactions_count?: string | number }>(chainId, `addresses/${address}/counters`, {}, { timeoutMs: 8_000, attempts: 2 });
  if (status !== 'ok' || !data) return { count: null, status: status === 'ok' ? 'error' : status };
  const n = Number(data.transactions_count);
  return Number.isFinite(n) ? { count: n, status: 'ok' } : { count: null, status: 'error' };
}

/** A movement of native coin (or, in `tokenFlows`, of the mapped token) between the traced wallet and one counterparty. */
export interface Flow {
  peer: string;
  dir: 'in' | 'out';
  /** Wei (or the token's raw units), as a decimal string. */
  value: string;
  block: number | null;
  ts: number | null;
  internal: boolean;
  /** The transaction it happened in: the evidence a reader opens on Blockscout. */
  hash: string | null;
}

export type FundingKind = 'transfer' | 'internal' | 'token' | 'first-tx';

export interface FundingTrace {
  wallet: string;
  status: Status;
  /** First wallet that sent this one native coin. */
  funder: string | null;
  /**
   * transfer  first inbound plain transfer (strong)
   * internal  first inbound internal transfer, e.g. through a bridge or a contract (strong)
   * token     no native inflow; the first sender of the mapped token itself (strong)
   * first-tx  no inflow in the window; the counterparty of the wallet's first transaction (weak, shown but never linked on)
   */
  kind: FundingKind | null;
  firstTs: number | null;
  /** Plain transactions read (at most the window). */
  txCount: number;
  /** True when the window was full: the wallet has at least that many transactions. */
  windowFull: boolean;
  /** Every native in/outflow in the window: the wallet's counterparties. */
  flows: Flow[];
  /** When status is 'error': what Blockscout said. */
  error?: string;
  /**
   * Blockscout has not finished indexing this chain's internal transactions
   * ("Some internal transactions within this block range have not yet been
   * processed"): the trace stands on the plain transactions alone.
   */
  internalsPending?: boolean;
  /**
   * Movements of the mapped token itself, oldest first (`tokentx` filtered to
   * the token). Wallets funded with the token rather than native coin -- a
   * treasury handing supply to multisigs -- link on these. Absent when they
   * were not read.
   */
  tokenFlows?: Flow[];
  /** When the token flows could not be read: what Blockscout said. */
  tokenError?: string;
}

/** Blockscout's answer while a chain's internal transactions are still being indexed. */
export const INTERNALS_PENDING = /not yet been processed/i;

interface RawTx {
  hash?: string;
  transactionHash?: string;
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
  const out: FundingTrace = { wallet: me, status: 'ok', funder: null, kind: null, firstTs: null, txCount: 0, windowFull: false, flows: [] };

  const txs = await client.etherscan<RawTx[]>(chainId, {
    module: 'account', action: 'txlist', address: me, sort: 'asc', page: 1, offset: window,
  });
  if (txs.status !== 'ok' || !Array.isArray(txs.data)) return { ...out, status: 'error', error: `txlist: ${txs.detail ?? 'unreadable'}` };
  const list = txs.data;
  out.firstTs = toNum(list[0]?.timeStamp);
  out.txCount = list.length;
  out.windowFull = list.length >= window;

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
  if (itxs.status !== 'ok' || !Array.isArray(itxs.data)) {
    // An indexer that is behind is not a failed read: the plain history stands.
    if (!INTERNALS_PENDING.test(itxs.detail ?? '')) return { ...out, status: 'error', error: `txlistinternal: ${itxs.detail ?? 'unreadable'}` };
    out.internalsPending = true;
  }
  for (const tx of Array.isArray(itxs.data) ? itxs.data : []) {
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
  const hash = (tx.hash ?? tx.transactionHash ?? '').toLowerCase() || null;
  return { peer, dir, value: value.toString(), block: toNum(tx.blockNumber), ts: toNum(tx.timeStamp), internal, hash };
}

/**
 * The wallet's oldest movements of one token (`account.tokentx` with
 * `contractaddress`), in one request. How a holder came to hold the token:
 * who sent it the supply, when, and how much.
 */
export async function traceTokenFlows(
  client: BlockscoutClient,
  chainId: number,
  wallet: string,
  token: string,
  window = 100,
): Promise<{ status: Status; flows: Flow[]; error?: string }> {
  const me = wallet.toLowerCase();
  // A token-filtered history is a slow query on Blockscout (6-17 s on a busy
  // token, against ~1 s for txlist): it gets a longer timeout rather than a
  // retry, which would only start it over.
  const res = await client.etherscan<RawTx[]>(chainId, {
    module: 'account', action: 'tokentx', contractaddress: token.toLowerCase(), address: me, sort: 'asc', page: 1, offset: window,
  }, { timeoutMs: 40_000 });
  if (res.status !== 'ok' || !Array.isArray(res.data)) return { status: 'error', flows: [], error: `tokentx: ${res.detail ?? 'unreadable'}` };
  const flows: Flow[] = [];
  for (const tx of res.data) {
    const flow = toFlow(tx, me, false);
    if (flow) flows.push(flow);
  }
  return { status: 'ok', flows };
}

function toNum(v: unknown): number | null {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null;
}

/** What Blockscout says about an address: its contract name and public tags. */
export async function getAddressLabels(
  client: BlockscoutClient,
  chainId: number,
  address: string,
): Promise<{ name: string | null; tags: string[]; isContract: boolean; status: Status }> {
  const { data, status } = await client.rest<{
    name?: string | null;
    is_contract?: boolean;
    metadata?: { tags?: Array<{ name?: string; label?: string } | string> } | null;
    public_tags?: Array<{ display_name?: string; label?: string }> | null;
  }>(chainId, `addresses/${address}`, {}, { timeoutMs: 6_000, attempts: 1 });
  if (status !== 'ok' || !data) {
    // The address page can fail or hang for a busy contract (a 500 that retries do
    // not cure). Whether it is a contract at all is still one light read away.
    const made = await client.etherscan<Array<{ contractAddress?: string }>>(chainId, {
      module: 'contract', action: 'getcontractcreation', contractaddresses: address,
    }, { timeoutMs: 8_000 });
    if (made.status !== 'ok' || !Array.isArray(made.data)) return { name: null, tags: [], isContract: false, status: 'error' };
    return { name: null, tags: [], isContract: made.data.length > 0, status: 'ok' };
  }
  const tags = [
    ...(data.metadata?.tags ?? []).map((t) => (typeof t === 'string' ? t : t.name ?? t.label ?? '')),
    ...(data.public_tags ?? []).map((t) => t.display_name ?? t.label ?? ''),
  ].filter(Boolean);
  return { name: data.name ?? null, tags: [...new Set(tags)], isContract: Boolean(data.is_contract), status: 'ok' };
}
