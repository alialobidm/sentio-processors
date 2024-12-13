import { Counter, EthFetchConfig, Gauge, BigDecimal } from "@sentio/sdk";
import { BorContext, getBorContractOnContext } from "./types/eth/bor.js";

import {
  EthChainId,
  GlobalContext,
  GlobalProcessor,
  RichBlock,
  Trace,
  BindOptions,
} from "@sentio/sdk/eth";

import { getDataByTxn, buildGraph, dataByTxn } from "./eth_util.js";
import {
  findBalanceChanges,
  getAddressProperty,
  AddressProperty,
  getRolesCount,
  winnerRewards,
  getProperty,
  printBalances,
  txnResult,
  sandwichTxnResult,
  isSandwich,
} from "./classifier.js";

import { getPriceByType, token } from "@sentio/sdk/utils";

import { chainConfigs, ChainConstants } from "./common.js";
import { TokenFlowGraph } from "./graph.js";

type spamInfo = {
  minIndex: number;
  maxIndex: number;
  count: number;
  distinctInput: Set<string>;
};

interface mevBlockResult {
  arbTxns: Array<txnResult>;
  sandwichTxns: Array<sandwichTxnResult>;
  spamInfo: Map<bigint, Map<string, spamInfo>>;
}

export function findSandwich(
  data: Map<string, dataByTxn>,
  arbResults: Map<string, txnResult>
): Array<sandwichTxnResult> {
  let ret = new Array<sandwichTxnResult>();
  let txnMap = new Map<string, Array<dataByTxn>>();
  let txnByIndex = new Map<number, dataByTxn>();
  for (const [_, txnData] of data) {
    if (!arbResults.has(txnData.tx.hash)) {
      continue;
    }
    if (txnData.trueReceiver === undefined) {
      continue;
    }
    const to = txnData.trueReceiver.toLowerCase();
    if (!txnMap.has(to)) {
      txnMap.set(to, new Array<dataByTxn>());
    }

    txnMap.get(to)!.push(txnData);
    txnByIndex.set(txnData.tx.index, txnData);
  }
  // sort array
  for (const [key, txnList] of txnMap) {
    if (txnList.length < 2) {
      continue;
    }
    txnList.sort((a, b) => a.tx.index - b.tx.index);
    let targetStart = 0;

    for (let i = 1; i < txnList.length; i++) {
      if (txnList[i].tx.index - txnList[targetStart].tx.index > 1) {
        const sandwichStart = txnList[targetStart].tx;
        const sandwichEnd = txnList[i].tx;
        var arr = new Array<txnResult>();
        arr.push(arbResults.get(sandwichStart.hash)!);
        for (let j = sandwichStart.index + 1; j < sandwichEnd.index; j++) {
          if (!txnByIndex.has(j)) {
            continue;
          }
          arr.push(arbResults.get(txnByIndex.get(j)!.tx.hash)!);
        }
        arr.push(arbResults.get(sandwichEnd.hash)!);

        const [is, sandwichResult] = isSandwich(arr);
        if (is) {
          ret.push(sandwichResult);
          targetStart = i + 1;
        }
      }
      targetStart = i;
    }
  }
  return ret;
}

export function handleBlock(
  b: RichBlock,
  chainConfig: ChainConstants
): mevBlockResult {
  const dataByTxn = getDataByTxn(b, chainConfig);
  console.log(
    `block ${Number(b.number)} of ${b.hash} has ${dataByTxn.size} txns`
  );
  let txnResults = new Map<string, txnResult>();
  let txnByIndex = new Map<number, txnResult>();

  for (const [hash, data] of dataByTxn) {
    let ret = txnProfitAndCost(data, chainConfig);
    const index = data.tx.index;
    if (ret.mevContract !== "") {
      txnResults.set(hash, ret);
      txnByIndex.set(index, ret);
    }
  }
  for (const [hash, result] of txnResults) {
    const index = result.txnIndex;
    if (index > 0) {
      if (txnByIndex.has(index - 1)) {
        const prev = txnByIndex.get(index - 1)!;
        const rolesCount = getRolesCount(prev.addressProperty);
        // If prev does not make a trade, skip.
        if (
          !rolesCount.has(AddressProperty.Trader) ||
          rolesCount.get(AddressProperty.Trader)! < 2
        ) {
          continue;
        }
        result.targetTxnHash = prev.txnHash;
        result.targetTxnContract = prev.mevContract;
      }
    }
  }

  let sandwichResults = findSandwich(dataByTxn, txnResults);
  for (const result of sandwichResults) {
    if (txnResults.has(result.frontTxnHash)) {
      txnResults.delete(result.frontTxnHash);
    }
    if (txnResults.has(result.backTxnHash)) {
      txnResults.delete(result.backTxnHash);
    }
  }
  let arbTxnResults = new Array<txnResult>();
  for (const [hash, result] of txnResults) {
    const txn = dataByTxn.get(hash);
    if (
      isArbitrage(
        txn!,
        chainConfig,
        result.revenue,
        result.addressProperty,
        result.graph
      )
    ) {
      arbTxnResults.push(result);
    }
  }
  let spamInfo = new Map<bigint, Map<string, spamInfo>>();
  if (chainConfig.watchSpam.size > 0) {
    for (const [hash, data] of dataByTxn) {
      if (data.trueReceiver === undefined || data.trueReceiver === null) {
        continue;
      }
      if (!chainConfig.watchSpam.has(data.trueReceiver)) {
        continue;
      }
      const gas = data.tx.gasPrice;
      if (!spamInfo.has(gas)) {
        spamInfo.set(gas, new Map<string, spamInfo>());
      }
      const to = data.trueReceiver;
      if (!spamInfo.get(gas)!.has(to)) {
        spamInfo.get(gas)!.set(to, {
          minIndex: data.tx.index,
          maxIndex: data.tx.index,
          count: 0,
          distinctInput: new Set<string>(),
        });
      }
      const info = spamInfo.get(gas!)!.get(to)!;
      info.minIndex = Math.min(info.minIndex, data.tx.index);
      info.maxIndex = Math.max(info.maxIndex, data.tx.index);
      info.count += 1;
      info.distinctInput.add(data.tx.data);
    }
  }
  return {
    arbTxns: arbTxnResults,
    sandwichTxns: sandwichResults,
    spamInfo: spamInfo,
  };
}

export function isArbitrage(
  data: dataByTxn,
  chainConfig: ChainConstants,
  revenue: Map<string, bigint>,
  addressProperty: Map<string, AddressProperty>,
  graph: TokenFlowGraph
): boolean {
  const rolesCount = getRolesCount(addressProperty);
  for (const trace of data.traces) {
    if (
      trace.action.to !== undefined &&
      chainConfig.blackListedAddresses.has(trace.action.to!)
    ) {
      return false;
    }
  }

  const sccs = graph.findStronglyConnectedComponents();
  if (graph.numNodes() === sccs.length) {
    return false;
  }
  if (data.trueReceiver !== undefined) {
    const from = data.tx.from.toLowerCase();
    const to = data.trueReceiver.toLowerCase();
    const sccMap = graph.getSCCIndex(sccs);
    let reach: Set<string> = new Set();
    for (const [k, v] of addressProperty) {
      if (
        sccMap.get(k) !== sccMap.get(from) &&
        sccMap.get(k) !== sccMap.get(to)
      ) {
        continue;
      }
      graph.connectedTo(k, reach);
    }
    for (const [k, v] of addressProperty) {
      if (k === from || k === to) {
        continue;
      }
      if (v === AddressProperty.Winner && !reach.has(k)) {
        return false;
      }
    }
  }

  let numWinner = 0;
  let numTrader = 0;
  let minerIsWinner =
    addressProperty.has(data.feeRecipent.toLowerCase()) &&
    getProperty("group", revenue) == AddressProperty.Winner;
  if (getProperty("group", revenue) == AddressProperty.Winner) {
    if (rolesCount.has(AddressProperty.Winner)) {
      numWinner = rolesCount.get(AddressProperty.Winner)!;
    }
    if (rolesCount.has(AddressProperty.Trader)) {
      numTrader = rolesCount.get(AddressProperty.Trader)!;
    }
    return minerIsWinner || numTrader > 1;
  }
  return false;
}

export function txnProfitAndCost(
  data: dataByTxn,
  chainConfig: ChainConstants
): txnResult {
  let minerPayment = "";
  const graph = buildGraph(data, chainConfig);
  let rewards = new Map<string, bigint>();
  let costs = new Map<string, bigint>();
  let ret: txnResult = {
    txnHash: data.tx.hash,
    txFrom: data.tx.from,
    revenue: rewards,
    mevContract: "",
    txnIndex: -1,
    costs: costs,
    addressProperty: new Map<string, AddressProperty>(),
    graph: graph,
    usedTokens: new Set<string>(),
    minerPayment: minerPayment,
    targetTxnContract: "",
    targetTxnHash: "",
  };
  if (data.trueReceiver === undefined || data.trueReceiver === null) {
    return ret;
  }
  ret.mevContract = data.trueReceiver;
  // This is a hack to handle ethers bug.
  // @ts-ignore
  data.tx.index = parseInt(data.tx.transactionIndex);
  if (data.transactionReceipts.length === 0) {
    console.log("no transaction receipt");
  } else if (data.transactionReceipts[0].gasUsed === undefined) {
    console.log("gas used is undefined");
  }
  if (data.transactionReceipts[0].status === 0) {
    return ret;
  }
  const sccs = graph.findStronglyConnectedComponents();
  //graph.print();
  const balances = findBalanceChanges(sccs, graph);
  //printBalances(balances);
  const addressProperty = getAddressProperty(balances);
  const sender = data.tx.from.toLowerCase();

  const receiver = data.trueReceiver;
  const gasPrice = data.tx.gasPrice;
  const gasTotal = data.transactionReceipts[0].gasUsed * BigInt(gasPrice);
  [rewards, costs] = winnerRewards(
    sender,
    receiver,
    sccs,
    balances,
    graph,
    chainConfig.mintBurnAddr,
    chainConfig.nativeTokenWrappedAddress,
    data.feeRecipent
  );

  costs.set("gas", gasTotal);
  if (
    addressProperty.has(data.feeRecipent.toLowerCase()) &&
    addressProperty.get(data.feeRecipent.toLowerCase()) ===
      AddressProperty.Winner
  ) {
    minerPayment = data.feeRecipent.toLowerCase();
  }
  let tokens = new Set<string>();
  for (const [_, individualBalances] of balances) {
    for (const [token, _] of individualBalances) {
      tokens.add(token);
    }
  }
  ret = {
    txnHash: data.tx.hash,
    txFrom: data.tx.from,
    mevContract: data.trueReceiver,
    revenue: rewards,
    txnIndex: data.tx.index,
    costs: costs,
    addressProperty: addressProperty,
    graph: graph,
    usedTokens: tokens,
    minerPayment: minerPayment,
    targetTxnContract: "",
    targetTxnHash: "",
  };
  return ret;
}

type TokenWithPrice = {
  token: token.TokenInfo;
  price: BigDecimal;
  scaledAmount: BigDecimal;
};

async function getTokenWithPrice(
  tokenAddr: string,
  chainID: EthChainId,
  timestamp: Date,
  amount: bigint
): Promise<TokenWithPrice | undefined> {
  let tokenInfo: token.TokenInfo;
  try {
    tokenInfo = await token.getERC20TokenInfo(chainID, tokenAddr);
  } catch (e) {
    console.log("get token failed", e, tokenAddr, chainID);
    return undefined;
  }
  let price: any;
  let ret: TokenWithPrice = {
    token: tokenInfo,
    price: BigDecimal(0),
    scaledAmount: BigDecimal(0),
  };
  try {
    price = await getPriceByType(chainID, tokenAddr, timestamp);
    if (isNaN(price)) {
      console.log("price is NaN", tokenAddr, chainID, timestamp);
      return ret;
    }
    ret.price = BigDecimal(price);
    ret.scaledAmount = amount.scaleDown(tokenInfo.decimal);
    return ret;
  } catch (e) {
    return ret;
  }
}

async function computePnL(
  revenue: Map<string, bigint>,
  costs: Map<string, bigint>,
  ctx: GlobalContext,
  config: ChainConstants
): Promise<[BigDecimal, BigDecimal, string]> {
  let pnl = BigDecimal(0);
  let gasCost = BigInt(0);
  let cost = BigDecimal(0);
  var keptTokens = new Set<string>();
  for (const [addr, amount] of revenue) {
    const tokenWithPrice = await getTokenWithPrice(
      addr,
      ctx.chainId,
      ctx.timestamp,
      amount
    );
    if (tokenWithPrice === undefined) {
      continue;
    }
    if (amount > 0) {
      keptTokens.add(addr);
    }
    pnl = pnl.plus(
      tokenWithPrice.price.multipliedBy(tokenWithPrice.scaledAmount)
    );
  }
  let tokens = "";
  for (const token of keptTokens) {
    tokens = tokens + token + ",";
  }
  for (const [addr, amount] of costs) {
    if (addr === "gas") {
      gasCost = gasCost + amount;
      continue;
    }
    const tokenWithPrice = await getTokenWithPrice(
      addr,
      ctx.chainId,
      ctx.timestamp,
      amount
    );
    if (tokenWithPrice === undefined) {
      continue;
    }
    cost = cost.plus(
      tokenWithPrice.price.multipliedBy(tokenWithPrice.scaledAmount)
    );
  }
  const gasTotal = await getTokenWithPrice(
    config.nativeTokenWrappedAddress,
    ctx.chainId,
    ctx.timestamp,
    gasCost
  );
  if (gasTotal === undefined) {
    return [pnl, cost, tokens];
  }
  cost = cost.plus(gasTotal!.price.multipliedBy(gasTotal!.scaledAmount));

  return [pnl, cost, tokens];
}

export function Bind(chainConfig: ChainConstants, startBlock: number) {
  let name = "Default";
  if (chainConfig.tailMode) {
    name = "TestTailMode";
  }
  GlobalProcessor.bind({
    startBlock: startBlock,
    network: chainConfig.chainID,
    name: name,
  }).onBlockInterval(
    async (b, ctx) => {
      const mevResults = handleBlock(b, chainConfig);
      let validator = "";
      console.log(chainConfig.phalconChain);
      /*
      if (chainConfig.phalconChain === "polygon") {
        const contract = getBorContractOnContext(
          ctx,
          "0x0000000000000000000000000000000000001000"
        );
        const validatorAddr = await contract.getBorValidators(ctx.blockNumber);
        validator = validatorAddr.toString();
        ctx.eventLogger.emit("validatorSet", {
        validator: validator,
      });
      }
      */
      for (const txn of mevResults.arbTxns) {
        let link = `https://explorer.phalcon.xyz/tx/${chainConfig.phalconChain}/${txn.txnHash}`;
        if (chainConfig.phalconChain === "eth") {
          link = `https://app.sentio.xyz/tx/1/${txn.txnHash}`;
        } else if (chainConfig.phalconChain === "polygon") {
          link = `https://app.sentio.xyz/tx/137/${txn.txnHash}`;
        } else if (chainConfig.phalconChain === "moonbeam") {
          link = `https://app.sentio.xyz/tx/1284/${txn.txnHash}`;
        } else if (chainConfig.phalconChain === "bsc") {
          link = `https://app.sentio.xyz/tx/56/${txn.txnHash}`;
        }
        const [revenue, cost, profitTokens] = await computePnL(
          txn.revenue,
          txn.costs,
          ctx,
          chainConfig
        );
        if (revenue.comparedTo(0) <= 0) {
          console.log("revenue is 0, likely not a popular token", txn.txnHash);
          continue;
        }
        let traders = "";
        for (const [addr, property] of txn.addressProperty) {
          if (property === AddressProperty.Trader) {
            traders += addr + ",";
          }
        }
        let tokens = "";
        for (const token of txn.usedTokens) {
          tokens += token + ",";
        }
        // @ts-ignore
        ctx.transactionHash = txn.txnHash;
        console.log(
          "emit arbitrage event",
          txn.txnHash,
          Number(ctx.blockNumber)
        );
        ctx.eventLogger.emit("arbitrage", {
          distinctId: txn.mevContract,
          mevContract: txn.mevContract,
          link: link,
          index: txn.txnIndex,
          traders: traders,
          revenue: BigDecimal(revenue.toFixed(2)),
          cost: BigDecimal(cost.toFixed(2)),
          profit: BigDecimal(revenue.minus(cost).toFixed(2)),
          paidBuilder: txn.minerPayment,
          tokens: tokens,
          profitTokens: profitTokens,
          targetTxnHash: txn.targetTxnHash,
          targetTxnContract: txn.targetTxnContract,
        });
      }
      for (const txn of mevResults.sandwichTxns) {
        let frontLink = `https://explorer.phalcon.xyz/tx/${chainConfig.phalconChain}/${txn.frontTxnHash}`;
        let backLink = `https://explorer.phalcon.xyz/tx/${chainConfig.phalconChain}/${txn.backTxnHash}`;
        if (chainConfig.phalconChain === "eth") {
          frontLink = `https://app.sentio.xyz/tx/1/${txn.frontTxnHash}`;
          backLink = `https://app.sentio.xyz/tx/1/${txn.backTxnHash}`;
        } else if (chainConfig.phalconChain === "polygon") {
          frontLink = `https://app.sentio.xyz/tx/137/${txn.frontTxnHash}`;
          backLink = `https://app.sentio.xyz/tx/137/${txn.backTxnHash}`;
        } else if (chainConfig.phalconChain === "moonbeam") {
          frontLink = `https://app.sentio.xyz/tx/1284/${txn.frontTxnHash}`;
          backLink = `https://app.sentio.xyz/tx/1284/${txn.backTxnHash}`;
        } else if (chainConfig.phalconChain === "bsc") {
          frontLink = `https://app.sentio.xyz/tx/56/${txn.frontTxnHash}`;
          backLink = `https://app.sentio.xyz/tx/56/${txn.backTxnHash}`;
        }

        const [revenue, cost, profitTokens] = await computePnL(
          txn.revenue,
          txn.costs,
          ctx,
          chainConfig
        );
        if (revenue.comparedTo(0) <= 0) {
          console.log(
            "revenue is 0, likely not a popular token",
            txn.frontTxnHash,
            txn.backTxnHash
          );
          continue;
        }
        let tokens = "";
        for (const token of txn.usedTokens) {
          tokens += token + ",";
        }
        ctx.eventLogger.emit("sandwich", {
          distinctId: txn.mevContract,
          mevContract: txn.mevContract,
          link: backLink,
          index: txn.backTxnIndex,
          frontLink: frontLink,
          frontIndex: txn.frontTxnIndex,
          revenue: BigDecimal(revenue.toFixed(2)),
          cost: BigDecimal(cost.toFixed(2)),
          profit: BigDecimal(revenue.minus(cost).toFixed(2)),
          paidBuilder: txn.minerPayment,
          profitTokens: profitTokens,
          usedTokens: tokens,
        });
      }
      for (const [gas, perGas] of mevResults.spamInfo) {
        for (const [mevContract, info] of perGas) {
          ctx.eventLogger.emit("spamRange", {
            distinctId: mevContract,
            mevContract: mevContract,
            gas: Number(gas) / 1e9,
            count: info.count,
            minIndex: info.minIndex,
            maxIndex: info.maxIndex,
            distinctInput: info.distinctInput.size,
          });
        }
      }
    },
    1,
    1,
    {
      block: true,
      transaction: true,
      transactionReceipt: true,
      trace: true,
    }
  );
}
