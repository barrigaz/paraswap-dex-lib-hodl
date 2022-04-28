import { DexParams } from './types';
import { DexConfigMap } from '../../types';
import { Network } from '../../constants';

export const HodltreeFlashloanExchangeConfig: DexConfigMap<DexParams> = {
  HodltreeFlashloanExchange: {
    [Network.ROPSTEN]: {
      pools: ['0x54fd1093bB4c64a5A80bb4E6c61E108C0eb994f2'],
      exchange: '0x8F1Eed3EE8B6f070205E58Ff4728521C159E93D0',
    },
  },
};

export const Adapters: {
  [chainId: number]: {
    [side: string]: { name: string; index: number }[] | null;
  };
} = {
  // TODO: add adapters for each chain
};
