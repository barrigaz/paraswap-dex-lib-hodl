import { DexParams } from './types';
import { DexConfigMap } from '../../types';
import { Network } from '../../constants';

export const HodltreeFlashloanExchangeConfig: DexConfigMap<DexParams> = {
  HodltreeFlashloanExchange: {
    // TODO: complete me!
  },
};

export const Adapters: {
  [chainId: number]: {
    [side: string]: { name: string; index: number }[] | null;
  };
} = {
  // TODO: add adapters for each chain
};
