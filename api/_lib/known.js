// Known non-trader addresses and programs.
//
// The holder scan's largest silent distortion: a token's biggest "holder" is usually
// its own liquidity pool, a bonding curve, a program vault or an exchange hot wallet.
// None of those are people. They have no realized trading history, so the engine
// correctly refuses to profile them — but they still consume coverage, and coverage
// is what gates the score. A token whose top three holders are its pool, pump.fun's
// vault and a CEX can look "unreadable" when the actual retail holder base beneath
// them is perfectly legible.
//
// Naming them turns three unreadable holders into three CORRECTLY EXCLUDED holders,
// which is a different thing: excluded infrastructure comes out of the denominator
// instead of dragging it down.
//
// This is a list, not a detector. It is therefore incomplete by construction and
// says so in the payload — an unlabelled pool still degrades to "no history", which
// is the honest fallback rather than a wrong guess. Program ownership is the general
// case and would need an extra RPC read per holder; the list catches the common ones
// for free.

// Program IDs and protocol authorities. Anything owned BY these, or equal to them,
// is infrastructure rather than a participant.
export const KNOWN_PROGRAMS = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpools',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca v2',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Pools',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter Aggregator v6',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter Aggregator v4',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'SPL Token Program',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Program',
  '11111111111111111111111111111111': 'System Program',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Token Metadata',
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW': 'Perpetuals / vault authority',
}

// Custodial and infrastructure wallets that hold on behalf of many people. Balances
// here are aggregates, so a behavioral read of them would be meaningless even if
// they had swap history.
export const KNOWN_CUSTODIANS = {
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance hot wallet',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Coinbase hot wallet',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2': 'Bybit',
  'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w': 'Gate.io',
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE': 'Coinbase 2',
  '6QJzieMYfp7yr3EdrePaQoG3Ghxs2wM98xSLRu8Xh56U': 'Kraken',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': 'Kraken 2',
  '3gd3dqgtJ4jWfBfLYTX67DALFetjc5iS72sCgRhCkW2u': 'Bitfinex',
  'AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS': 'Robinhood',
  '5PAhQiYdLBd6SVdjzBQDxUAEFyDdF5ExNPQfcscnPRj5': 'MEXC',
}

// Burn and null destinations. Supply here is gone, not held.
export const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
])

const ALL = new Map([
  ...Object.entries(KNOWN_PROGRAMS).map(([k, v]) => [k, { label: v, kind: 'program' }]),
  ...Object.entries(KNOWN_CUSTODIANS).map(([k, v]) => [k, { label: v, kind: 'custodian' }]),
])

// Returns { kind, label } for infrastructure, or null for something that might be a
// person. Null is not a claim that it IS a person — only that this list does not
// know otherwise, which is why the caller still has to fall back to "no history".
export function identify(address) {
  if (!address) return null
  if (BURN_ADDRESSES.has(address)) return { kind: 'burn', label: 'Burn address' }
  return ALL.get(address) || null
}

export const KNOWN_COUNTS = {
  programs: Object.keys(KNOWN_PROGRAMS).length,
  custodians: Object.keys(KNOWN_CUSTODIANS).length,
  burns: BURN_ADDRESSES.size,
}
