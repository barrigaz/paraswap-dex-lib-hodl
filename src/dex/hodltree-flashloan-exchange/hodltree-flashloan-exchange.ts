import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import _, { result, zipObjectDeep } from 'lodash';
import {
  Token,
  Address,
  ExchangePrices,
  Log,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { wrapETH, getDexKeysWithNetwork } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import {
  HodltreeFlashloanExchangeData,
  PoolState,
  PoolStateMap,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { HodltreeFlashloanExchangeConfig, Adapters } from './config';

import PoolABI from '../../abi/hodltree-flashloan-exchange/LiquidityPool.json';
import ExchangeABI from '../../abi/hodltree-flashloan-exchange/Exchange.json';

function typecastReadOnlyPoolState(pool: DeepReadonly<PoolState>): PoolState {
  return _.cloneDeep(pool) as PoolState;
}

export class HodltreeFlashloanExchangeEventPool extends StatefulEventSubscriber<PoolStateMap> {
  public exchangeInterface: Interface;
  public poolInterface: Interface;

  handlers: {
    [event: string]: (event: any, pool: PoolState, log: Log) => PoolState;
  } = {};

  poolDecoder: (log: Log) => any;

  addressesSubscribed: string[];

  pools: PoolState[];

  constructor(
    protected parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    protected exchangeAddress: Address,
    protected poolAddresses: Address[],
  ) {
    super(parentName, logger);

    this.poolInterface = new Interface(PoolABI);
    this.exchangeInterface = new Interface(ExchangeABI);
    this.poolDecoder = (log: Log) => this.poolInterface.parseLog(log);
    this.addressesSubscribed = [...poolAddresses];

    // Add handlerss
    this.handlers['SetFees'] = this.handleSetFees.bind(this);
    this.handlers['Deposit'] = this.handleDeposit.bind(this);
    this.handlers['Withdraw'] = this.handleWithdraw.bind(this);
    this.handlers['Borrow'] = this.handleBorrow.bind(this);
  }

  /**
   * The function is called everytime any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected processLog(
    state: DeepReadonly<PoolStateMap>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolStateMap> | null {
    const _state: PoolStateMap = {};
    for (const [address, pool] of Object.entries(state))
      _state[address] = typecastReadOnlyPoolState(pool);

    try {
      const event = this.poolDecoder(log);
      if (event.name in this.handlers) {
        _state[log.address] = this.handlers[event.name](
          event,
          _state[log.address],
          log,
        );
      }
      return _state;
    } catch (e) {
      this.logger.error(
        `Error_${this.parentName}_processLog could not parse the log with topic ${log.topics}:`,
        e,
      );
      return null;
    }
  }

  handleSetFees(event: any, pool: PoolState, log: Log): PoolState {
    pool.borrowFee = BigInt(event.args.borrowFee.toString());
    return pool;
  }

  handleDeposit(event: any, pool: PoolState, log: Log): PoolState {
    for (let tokenId = 0; tokenId < pool.tokenInfo.length; tokenId++) {
      pool.tokenInfo[tokenId].tokenBalance += BigInt(
        event.args.tokenAmounts[tokenId],
      );
    }
    return pool;
  }

  handleWithdraw(event: any, pool: PoolState, log: Log): PoolState {
    for (let tokenId = 0; tokenId < pool.tokenInfo.length; tokenId++) {
      pool.tokenInfo[tokenId].tokenBalance -= BigInt(
        event.args.tokenAmounts[tokenId],
      );
    }
    return pool;
  }

  handleBorrow(event: any, pool: PoolState, log: Log): PoolState {
    for (let tokenId = 0; tokenId < pool.tokenInfo.length; tokenId++) {
      pool.tokenInfo[tokenId].tokenBalance = BigInt(
        event.args.balances[tokenId],
      );
    }
    return pool;
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenrate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subsriber at blocknumber
   */
  async generateState(blockNumber: number): Promise<Readonly<PoolStateMap>> {
    const requests = 5;
    const bfOffset = 0;
    const precOffset = 1;
    const tOffset = 2;
    const bOffset = 3;
    const tmOffset = 4;
    let calldata = [];
    for (let pool of this.addressesSubscribed) {
      calldata.push({
        target: pool,
        calldata: this.poolInterface.encodeFunctionData('borrowFee'),
      });
      calldata.push({
        target: pool,
        calldata: this.poolInterface.encodeFunctionData('PCT_PRECISION'),
      });
      calldata.push({
        target: pool,
        calldata: this.poolInterface.encodeFunctionData('TOKENS'),
      });
      calldata.push({
        target: pool,
        callData: this.poolInterface.encodeFunctionData('balances'),
      });
      calldata.push({
        target: pool,
        calldata: this.poolInterface.encodeFunctionData('TOKENS_MUL'),
      });
    }

    const resultData = await this.dexHelper.multiContract.methods
      .aggregate(calldata)
      .call({}, blockNumber);

    let onChainState: PoolStateMap;
    let tmpPools = [];
    for (let poolId = 0; poolId < this.addressesSubscribed.length; poolId++) {
      const tokens = resultData[poolId * requests + tOffset];
      const balances = resultData[poolId * requests + bOffset];
      const tokenMuls = resultData[poolId];

      const pool: PoolState = {
        poolAddress: this.addressesSubscribed[poolId],
        borrowFee: BigInt(resultData[poolId * requests + bfOffset]),
        PCT_PRECISION: BigInt(resultData[poolId * requests + precOffset]),
        tokenInfo: [],
        tokensToId: {},
        TOKENS_MUL: [],
      };

      for (let tokenId = 0; tokenId < tokens.length; tokenId++) {
        pool.tokenInfo.push({
          address: tokens[tokenId],
          tokenBalance: BigInt(balances[tokenId]),
        });
        pool.tokensToId[tokens[tokenId]] = tokenId;
        pool.TOKENS_MUL[tokenId] = tokenMuls[tokenId];
      }
      onChainState[this.addressesSubscribed[poolId]] = pool;
      tmpPools.push(pool);
    }
    this.pools = tmpPools;

    return onChainState;
  }
}

export class HodltreeFlashloanExchange
  extends SimpleExchange
  implements IDex<HodltreeFlashloanExchangeData>
{
  protected eventPools: HodltreeFlashloanExchangeEventPool;

  readonly hasConstantPriceLargeAmounts = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(HodltreeFlashloanExchangeConfig);

  logger: Logger;

  constructor(
    protected network: Network,
    protected dexKey: string,
    protected dexHelper: IDexHelper,
    protected exchangeAddress: Address,
    protected poolAddresses: Address[],
  ) {
    super(dexHelper.augustusAddress, dexHelper.provider);
    this.logger = dexHelper.getLogger(dexKey);
    this.eventPools = new HodltreeFlashloanExchangeEventPool(
      dexKey,
      network,
      dexHelper,
      this.logger,
      exchangeAddress,
      poolAddresses,
    );
  }

  // Initialize pricing is called once in the start of
  // pricing service. It is intended to setup the integration
  // for pricing requests. It is optional for a DEX to
  // implement this function
  async initializePricing(blockNumber: number) {
    await this.eventPools.generateState(blockNumber);
  }

  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }

  // Returns list of pool identifiers that can be used
  // for a given swap. poolIdentifers must be unique
  // across DEXes. It is recommended to use
  // ${dexKey}_${poolAddress} as a poolIdentifier
  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const pools = this.getPools(srcToken, destToken);
    return pools.map(({ poolAddress }) => `${this.dexKey}_${poolAddress}`);
  }

  getPools(from: Token, to: Token): PoolState[] {
    return this.eventPools.pools.filter(
      val =>
        val.tokensToId[from.address.toLowerCase()] !== undefined &&
        val.tokensToId[to.address.toLowerCase()] !== undefined,
    );
  }

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<HodltreeFlashloanExchangeData>> {
    if (side === SwapSide.BUY) return null;
    const poolsForTokens = this.getPools(srcToken, destToken);
    const allowedPools = limitPools
      ? poolsForTokens.filter(({ poolAddress }) =>
          limitPools.includes(`${this.dexKey}_${poolAddress.toLowerCase()}`),
        )
      : poolsForTokens;
    if (!allowedPools.length) return null;
    let tokenOut = destToken.address.toLowerCase();
    const poolPrices = poolsForTokens.map((pool: PoolState) => {
      const prices = amounts.map((value: bigint) => {
        return this.getTokenPrice(pool.tokensToId[tokenOut], value, pool);
      });
      return {
        prices,
        unit: this.getTokenPrice(pool.tokensToId[tokenOut], BigInt(1), pool),
        data: {
          poolAddress: pool.poolAddress,
        },
        poolIdentifier: `${this.dexKey}_${pool.poolAddress}`,
        exchange: this.dexKey,
        gasCost: 200 * 1000,
      };
    });
    return poolPrices as ExchangePrices<HodltreeFlashloanExchangeData>;
  }

  getTokenPrice(
    destTokenId: number,
    amountIn: bigint,
    pool: PoolState,
  ): bigint {
    let price = (pool.borrowFee + pool.PCT_PRECISION) / pool.PCT_PRECISION;
    let amountOut = amountIn * price;
    return pool.tokenInfo[destTokenId].tokenBalance >= amountOut ? price : null;
  }

  // Encode params required by the exchange adapter
  // Used for multiSwap, buy & megaSwap
  // Hint: abiCoder.encodeParameter() couls be useful
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: HodltreeFlashloanExchangeData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          liquidityPool_: 'address',
          tokenIn_: 'address',
          tokenOut_: 'address',
          inAmount_: 'uint256',
        },
      },
      {
        liquidityPool_: data.poolAddress,
        tokenIn_: srcToken,
        tokenOut_: destToken,
        inAmount_: srcAmount,
      },
    );

    return {
      targetExchange: this.exchangeAddress,
      payload,
      networkFee: '0',
    };
  }

  // Encode call data used by simpleSwap like routers
  // Used for simpleSwap & simpleBuy
  // Hint: this.buildSimpleParamWithoutWETHConversion
  // could be useful
  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: HodltreeFlashloanExchangeData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const swapData = this.eventPools.exchangeInterface.encodeFunctionData(
      'swap',
      [
        {
          liquidityPool_: data.poolAddress,
          tokenIn_: srcToken,
          tokenOut_: destToken,
          inAmount_: srcAmount,
        },
      ],
    );

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      this.exchangeAddress,
    );
  }

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const availablePools = this.eventPools.pools.filter(
      val => val.tokensToId[tokenAddress.toLowerCase()] !== undefined,
    );

    const sortedPools = availablePools.sort(
      (p1, p2) =>
        Number(p2.tokenInfo[p2.tokensToId[tokenAddress]]) -
        Number(p1.tokenInfo[p1.tokensToId[tokenAddress]]),
    );

    return sortedPools.splice(0, limit).map(val => {
      const tokens = [];
      return {
        exchange: this.exchangeAddress,
        address: val.poolAddress,
        connectorTokens: tokens,
        liquidityUSD: this.calculateLiquidity(val),
      };
    });
  }

  calculateLiquidity(pool: PoolState): number {
    let sum = 0;
    for (let tokenId = 0; tokenId < pool.tokenInfo.length; tokenId++) {
      sum += Number(
        pool.tokenInfo[tokenId].tokenBalance / pool.TOKENS_MUL[tokenId],
      );
    }
    return sum;
  }
}
