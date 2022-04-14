import { Address } from '../../types';

export type TokenInfo = {
  address: Address;
  tokenBalance: bigint;
};

export type PoolState = {
  // TODO: poolState is the state of event
  // subsrciber. This should be the minimum
  // set of parameters required to compute
  // pool prices. Complete me!
  poolAddress: string;
  tokensToId: {
    [address: Address]: number;
  };
  tokenInfo: TokenInfo[];
  borrowFee: bigint;
  PCT_PRECISION: bigint;
  TOKENS_MUL: bigint[];
};

export type HodltreeFlashloanExchangeData = {
  // TODO: HodltreeFlashloanExchangeData is the dex data that is
  // returned by the API that can be used for
  // tx building. The data structure should be minimal.
  // Complete me!
  poolToUse: Address;
};

export type DexParams = {
  // TODO: DexParams is set of parameters the can
  // be used to initiate a DEX fork.
  // Complete me!
};

export type PoolStateMap = { [address: string]: PoolState };
