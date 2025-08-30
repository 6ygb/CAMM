import { task, types } from "hardhat/config";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ConfidentialToken, CAMMPair } from "../types";
import { FhevmType, HardhatFhevmRuntimeEnvironment } from "@fhevm/hardhat-plugin";
import type { AddressLike } from "ethers";
import type { TaskArguments } from "hardhat/types";
import fs from "fs";
import path from "path";

type CAMMConfig = {
  PAIR_ADDRESS?: string;
  TOKEN0_ADDRESS?: string;
  TOKEN1_ADDRESS?: string;
  LIQ_ADDED?: boolean;
};

const CAMM_JSON_PATH = path.resolve(__dirname, "..", "CAMM.json");
const scalingFactor = BigInt(10) ** BigInt(6);

function readConfig(): CAMMConfig {
  if (!fs.existsSync(CAMM_JSON_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CAMM_JSON_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${CAMM_JSON_PATH}: ${(e as Error).message}`);
  }
}

function writeConfig(patch: Partial<CAMMConfig>) {
  const current = readConfig();
  const merged = { ...current, ...patch };
  fs.writeFileSync(CAMM_JSON_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

function requireConfig(): CAMMConfig {
  if (!fs.existsSync(CAMM_JSON_PATH)) {
    console.warn(`Could not find CAMM.json, please run 'npx hardhat task:deploy_camm' to deploy and create it.`);
    process.exit(1);
  }
  return readConfig();
}

async function getTokenBalances(
  fhevm: HardhatFhevmRuntimeEnvironment,
  token0: ConfidentialToken,
  token1: ConfidentialToken,
  signer: HardhatEthersSigner,
) {
  const encryptedBalance0 = await token0.confidentialBalanceOf(signer.address);
  const encryptedBalance1 = await token1.confidentialBalanceOf(signer.address);

  const clearBalance0 = await fhevm.userDecryptEuint(
    FhevmType.euint64,
    encryptedBalance0,
    await token0.getAddress(),
    signer,
  );
  const clearBalance1 = await fhevm.userDecryptEuint(
    FhevmType.euint64,
    encryptedBalance1,
    await token1.getAddress(),
    signer,
  );

  return [clearBalance0, clearBalance1];
}
async function decryptPairEuint64(
  handle: string,
  fhevm: HardhatFhevmRuntimeEnvironment,
  pair: CAMMPair,
  signer: HardhatEthersSigner,
) {
  const clearVar = await fhevm.userDecryptEuint(FhevmType.euint64, handle, await pair.getAddress(), signer);
  return clearVar;
}
async function decryptPairEuint128(
  handle: string,
  fhevm: HardhatFhevmRuntimeEnvironment,
  pair: CAMMPair,
  signer: HardhatEthersSigner,
) {
  const clearVar = await fhevm.userDecryptEuint(FhevmType.euint128, handle, await pair.getAddress(), signer);
  return clearVar;
}
async function getLPBalance(fhevm: HardhatFhevmRuntimeEnvironment, pair: CAMMPair, signer: HardhatEthersSigner) {
  const encryptedLPBalance = await pair.confidentialBalanceOf(signer.address);
  return await decryptPairEuint64(encryptedLPBalance, fhevm, pair, signer);
}

async function setOperator(token: ConfidentialToken, operatorAddress: AddressLike, targetTimestamp: number) {
  const setOperatorTx = await token.setOperator(operatorAddress, targetTimestamp);
  const setOperatorReceipt = await setOperatorTx.wait();
  if (!setOperatorReceipt?.status) {
    throw new Error("Set Operator Tx failed.");
  }
}

async function getCurrentPrice(fhevm: HardhatFhevmRuntimeEnvironment, pair: CAMMPair, signer: HardhatEthersSigner) {
  // const requestTx = await pair.requestReserveInfo();
  // const requestReceipt = await requestTx.wait();
  // if (!requestReceipt?.status) {
  //   throw new Error("Request reserve info Tx failed.");
  // }

  const { obfuscatedReserve0, obfuscatedReserve1 } = await pair.obfuscatedReserves();
  const clearObfuscatedReserve0 = await decryptPairEuint128(obfuscatedReserve0, fhevm, pair, signer);
  const clearObfuscatedReserve1 = await decryptPairEuint128(obfuscatedReserve1, fhevm, pair, signer);

  const priceToken0Token1 = (clearObfuscatedReserve0 * scalingFactor) / clearObfuscatedReserve1;
  const priceToken1Token0 = (clearObfuscatedReserve1 * scalingFactor) / clearObfuscatedReserve0;
  return { priceToken0Token1, priceToken1Token0 };
}

async function waitForDecryptionRequested(
  pair: CAMMPair,
  timeoutMs = 180_000,
): Promise<{ from: string; blockNumber: bigint; requestID: bigint; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = pair.getEvent("decryptionRequested"); // TypedContractEvent
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (from: string, blockNumber: bigint, requestID: bigint, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] decryptionRequested from=${from} block=${blockNumber.toString()} reqID=${requestID.toString()} \ntx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ from, blockNumber, requestID, txHash: event?.log?.transactionHash });
    };

    void pair.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for decryptionRequested after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

async function waitForRefund(
  pair: CAMMPair,
  timeoutMs = 180_000,
): Promise<{ from: string; blockNumber: bigint; requestID: bigint; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = pair.getEvent("Refund"); // TypedContractEvent
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Let TS infer param types from the typed event; annotate if you prefer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRefund = (from: string, blockNumber: bigint, requestID: bigint, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] Refund from=${from} block=${blockNumber.toString()} reqID=${requestID.toString()}` +
          `\ntx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ from, blockNumber, requestID, txHash: event?.log?.transactionHash });
    };

    void pair.once(ev, onRefund).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Refund after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

task("task:deploy_camm", "Deploys the CAMM contracts").setAction(async function (_taskArguments: TaskArguments, hre) {
  console.log("Deploying CAMM contracts.");
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const CAMMFactory = await ethers.getContractFactory("CAMMFactory");
  const CAMMFactoryContract = await CAMMFactory.connect(deployer).deploy();
  await CAMMFactoryContract.deploymentTransaction()?.wait();
  const CAMMFactoryAddress = await CAMMFactoryContract.getAddress();
  console.log(`Factory deployed at : ${CAMMFactoryAddress}`);

  const tokenFactory = await ethers.getContractFactory("ConfidentialToken");
  const token0Contract = await tokenFactory.connect(deployer).deploy("Us Dollar", "USD");
  await token0Contract.deploymentTransaction()?.wait();
  const token0Address = await token0Contract.getAddress();
  console.log(`Token0 deployed at : ${token0Address}`);

  const token1Contract = await tokenFactory.connect(deployer).deploy("Euro", "EUR");
  await token1Contract.deploymentTransaction()?.wait();
  const token1Address = await token1Contract.getAddress();
  console.log(`Token1 deployed at : ${token1Address}`);

  const createPairTx = await CAMMFactoryContract.createPair(token0Address, token1Address, deployer.address);
  await createPairTx.wait();
  const pairAddress = await CAMMFactoryContract.getPair(token0Address, token1Address);
  console.log(`Pair deployed at : ${pairAddress}`);

  //No need to mint tokens here, the testToken contract constructor mints 100k to deployer.

  writeConfig({
    PAIR_ADDRESS: pairAddress,
    TOKEN0_ADDRESS: token0Address,
    TOKEN1_ADDRESS: token1Address,
    LIQ_ADDED: false,
  });
});

task("task:get_balances", "Retrieve token balances.").setAction(async function (_taskArguments: TaskArguments, hre) {
  const cfg = requireConfig();
  const token0Address = cfg.TOKEN0_ADDRESS;
  const token1Address = cfg.TOKEN1_ADDRESS;
  if (!token0Address || !token1Address) {
    throw new Error("Token addresses not defined in CAMM.json");
  }

  const { ethers, fhevm } = hre;
  const signers = await ethers.getSigners();
  const signer = signers[0];
  const token0 = await ethers.getContractAt("ConfidentialToken", token0Address, signer);
  const token1 = await ethers.getContractAt("ConfidentialToken", token1Address, signer);
  await fhevm.initializeCLIApi();

  const [balance0, balance1] = await getTokenBalances(fhevm, token0, token1, signer);

  console.log(
    `Balance 0 : ${ethers.formatUnits(balance0.toString(), 6)}\nBalance 1 : ${ethers.formatUnits(balance1.toString(), 6)}`,
  );
});

task("task:get_LPBalance", "Retrives LP balance").setAction(async function (_taskArguments: TaskArguments, hre) {
  const cfg = requireConfig();
  const pairAddress = cfg.PAIR_ADDRESS;
  if (!pairAddress) {
    throw new Error("Pair address not defined in CAMM.json");
  }

  const { ethers, fhevm } = hre;
  const signers = await ethers.getSigners();
  const signer = signers[0];
  const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
  await fhevm.initializeCLIApi();

  const LPBalance = await getLPBalance(fhevm, pair, signer);
  console.log(`LP Balance : ${ethers.formatUnits(LPBalance.toString(), 6)}`);
});

task("task:get_trading_price", "Retrives current trading price on pair.").setAction(async function (
  _taskArguments: TaskArguments,
  hre,
) {
  const cfg = requireConfig();
  const pairAddress = cfg.PAIR_ADDRESS;
  if (!pairAddress) {
    throw new Error("Pair address not defined in CAMM.json");
  }

  const { ethers, fhevm } = hre;
  const signers = await ethers.getSigners();
  const signer = signers[0];
  const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
  await fhevm.initializeCLIApi();

  const { priceToken0Token1, priceToken1Token0 } = await getCurrentPrice(fhevm, pair, signer);
  console.log(
    `Current Trading price \nToken 0 to Token 1 : ${ethers.formatUnits(priceToken0Token1.toString(), 6)}\nToken 1 to Token 0 : ${ethers.formatUnits(priceToken1Token0.toString(), 6)}`,
  );
});

task("task:add_liquidity", "Adds liquidity to the pair.")
  .addParam("amount0", "The amount of token0 to add", 12000, types.int)
  .addParam("amount1", "The amount of token0 to add", 10000, types.int)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const token0Address = cfg.TOKEN0_ADDRESS;
    const token1Address = cfg.TOKEN1_ADDRESS;
    const pairAddress = cfg.PAIR_ADDRESS;
    const liqAdded = cfg.LIQ_ADDED;
    if (!token0Address || !token1Address) {
      throw new Error("Token addresses not defined in CAMM.json");
    }
    if (!pairAddress) {
      throw new Error("Pair address not defined in CAMM.json");
    }
    if (liqAdded === undefined) {
      throw new Error("Liq Added not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const token0 = await ethers.getContractAt("ConfidentialToken", token0Address, signer);
    const token1 = await ethers.getContractAt("ConfidentialToken", token1Address, signer);
    const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
    await fhevm.initializeCLIApi();

    const amount0 = _taskArguments.amount0;
    const amount1 = _taskArguments.amount1;

    console.log(`Adding ${amount0} token0 and ${amount1} token1 to liquidity on pair (${pairAddress})`);

    const currentBlock = await ethers.provider.getBlock("latest");
    if (!currentBlock) {
      throw new Error("Could not retrieve last block.");
    }
    const blockTimestamp = currentBlock.timestamp;
    const targetTimestamp = blockTimestamp + 10000;

    const isOperator0 = await token0.isOperator(signer.address, pairAddress);
    if (!isOperator0) {
      console.log("Setting pair as an Operator of signer on token 0.");
      await setOperator(token0, pairAddress, targetTimestamp);
      console.log("Pair is now an operator of the signer on token 0.");
    }
    const isOperator1 = await token1.isOperator(signer.address, pairAddress);
    if (!isOperator1) {
      console.log("Setting pair as an Operator of signer on token 1.");
      await setOperator(token1, pairAddress, targetTimestamp);
      console.log("Pair is now an operator of the signer on token 1.");
    }

    let decryptionRequestedEvent;
    if (liqAdded) {
      decryptionRequestedEvent = waitForDecryptionRequested(pair);
    }

    const eventPromise = new Promise<{ blockNumber: bigint; user: string; txHash?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for liquidityMinted after 3m")), 180_000);

      const ev = pair.getEvent("liquidityMinted");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onMint = (blockNumber: bigint, user: string, event: any) => {
        clearTimeout(timer);
        console.log(
          `[EVENT] liquidityMinted (block=${blockNumber.toString()} user=${user}) \ntx=${event?.log?.transactionHash ?? "?"}`,
        );
        resolve({ blockNumber, user, txHash: event?.log?.transactionHash });
      };

      void pair.once(ev, onMint).catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const clearParam = await fhevm.createEncryptedInput(pairAddress, signer.address);
    clearParam.add64(BigInt(amount0) * scalingFactor);
    clearParam.add64(BigInt(amount1) * scalingFactor);
    const encryptedParam = await clearParam.encrypt();

    const addLiqTx = await pair["addLiquidity(bytes32,bytes32,uint256,bytes)"](
      encryptedParam.handles[0],
      encryptedParam.handles[1],
      blockTimestamp + 12000,
      encryptedParam.inputProof,
    );
    const addLiqReceipt = await addLiqTx.wait();

    console.log(`Add liquidity TX status : ${addLiqReceipt?.status}`);

    if (!addLiqReceipt?.status) {
      throw new Error("Add liquidity Tx failed.");
    }

    if (liqAdded) {
      await decryptionRequestedEvent;
    }

    await eventPromise;

    if (!liqAdded) {
      writeConfig({
        LIQ_ADDED: true,
      });
    }
  });

task("task:swap_tokens", "Adds liquidity to the pair.")
  .addParam("amount0", "The amount of token0 to swap", 250, types.int)
  .addParam("amount1", "The amount of token0 to swap", 0, types.int)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const token0Address = cfg.TOKEN0_ADDRESS;
    const token1Address = cfg.TOKEN1_ADDRESS;
    const pairAddress = cfg.PAIR_ADDRESS;
    if (!token0Address || !token1Address) {
      throw new Error("Token addresses not defined in CAMM.json");
    }
    if (!pairAddress) {
      throw new Error("Pair address not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const token0 = await ethers.getContractAt("ConfidentialToken", token0Address, signer);
    const token1 = await ethers.getContractAt("ConfidentialToken", token1Address, signer);
    const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
    await fhevm.initializeCLIApi();

    const amount0 = _taskArguments.amount0;
    const amount1 = _taskArguments.amount1;

    console.log(`Swapping ${amount0} token0 and ${amount1} token1 on pair (${pairAddress})`);

    const currentBlock = await ethers.provider.getBlock("latest");
    if (!currentBlock) {
      throw new Error("Could not retrieve last block.");
    }
    const blockTimestamp = currentBlock.timestamp;
    const targetTimestamp = blockTimestamp + 10000;

    const isOperator0 = await token0.isOperator(signer.address, pairAddress);
    if (!isOperator0) {
      console.log("Setting pair as an Operator of signer on token 0.");
      await setOperator(token0, pairAddress, targetTimestamp);
      console.log("Pair is now an operator of the signer on token 0.");
    }
    const isOperator1 = await token1.isOperator(signer.address, pairAddress);
    if (!isOperator1) {
      console.log("Setting pair as an Operator of signer on token 1.");
      await setOperator(token1, pairAddress, targetTimestamp);
      console.log("Pair is now an operator of the signer on token 1.");
    }

    const decryptionRequestedEvent = waitForDecryptionRequested(pair);
    const eventPromise = new Promise<{
      from: string;
      amount0In: string;
      amount1In: string;
      amount0Out: string;
      amount1Out: string;
      to: string;
      txHash?: string;
    }>((resolve, reject) => {
      const ev = pair.getEvent("Swap");
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onSwap = (
        from: string,
        amount0In: string,
        amount1In: string,
        amount0Out: string,
        amount1Out: string,
        to: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event: any,
      ) => {
        if (timer) clearTimeout(timer);

        console.log(`[EVENT] Swap (from=${from} to=${to})\ntx=${event?.log?.transactionHash ?? "?"}`);

        resolve({
          from,
          to,
          amount0In,
          amount1In,
          amount0Out,
          amount1Out,
          txHash: event?.log?.transactionHash,
        });
      };
      void pair.once(ev, onSwap).catch((err: unknown) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });

    const clearParam = await fhevm.createEncryptedInput(pairAddress, signer.address);
    clearParam.add64(BigInt(amount0) * scalingFactor);
    clearParam.add64(BigInt(amount1) * scalingFactor);
    const encryptedParam = await clearParam.encrypt();

    const swapTx = await pair["swapTokens(bytes32,bytes32,address,uint256,bytes)"](
      encryptedParam.handles[0],
      encryptedParam.handles[1],
      signer.address,
      blockTimestamp + 120,
      encryptedParam.inputProof,
    );
    const swapReceipt = await swapTx.wait();

    console.log(`Swap TX status : ${swapReceipt?.status}`);

    if (!swapReceipt?.status) {
      throw new Error("Swap Tx failed.");
    }
    await decryptionRequestedEvent;
    const { amount0In, amount1In, amount0Out, amount1Out } = await eventPromise;

    const clearAmount0In = await decryptPairEuint64(amount0In, fhevm, pair, signer);
    const clearAmount1In = await decryptPairEuint64(amount1In, fhevm, pair, signer);
    const clearAmount0Out = await decryptPairEuint64(amount0Out, fhevm, pair, signer);
    const clearAmount1Out = await decryptPairEuint64(amount1Out, fhevm, pair, signer);

    console.log(
      `\nSwap decryption result \namount0In : ${clearAmount0In} \namount1In : ${clearAmount1In} \namount0Out : ${clearAmount0Out} \namount1Out : ${clearAmount1Out}`,
    );
  });

task("task:remove_liquidity", "Removes liquidity from the pair.")
  .addParam("amount", "The amount of LP token to remove", 5000, types.int)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const pairAddress = cfg.PAIR_ADDRESS;
    if (!pairAddress) {
      throw new Error("Pair address not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
    await fhevm.initializeCLIApi();

    const lpAmount = _taskArguments.amount;

    console.log(`Removing ${lpAmount} LP tokens from the pair (${pairAddress})`);

    const currentBlock = await ethers.provider.getBlock("latest");
    if (!currentBlock) {
      throw new Error("Could not retrieve last block.");
    }
    const blockTimestamp = currentBlock.timestamp;
    const targetTimestamp = blockTimestamp + 10000;

    const isOperator = await pair.isOperator(signer.address, pairAddress);
    if (!isOperator) {
      console.log("Setting pair as an Operator of signer on pair.");
      await setOperator(pair, pairAddress, targetTimestamp);
      console.log("Pair is now an operator of the signer on pair.");
    }

    const decryptionRequestedEvent = waitForDecryptionRequested(pair);
    const eventPromise = new Promise<{ blockNumber: bigint; user: string; txHash?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for liquidityBurnt after 3m")), 180_000);

      const ev = pair.getEvent("liquidityBurnt");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onBurn = (blockNumber: bigint, user: string, event: any) => {
        clearTimeout(timer);
        console.log(
          `[EVENT] liquidityBurnt (block=${blockNumber.toString()} user=${user}) \ntx=${event?.log?.transactionHash ?? "?"}`,
        );
        resolve({ blockNumber, user, txHash: event?.log?.transactionHash });
      };

      void pair.once(ev, onBurn).catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const clearParam = await fhevm.createEncryptedInput(pairAddress, signer.address);
    clearParam.add64(BigInt(lpAmount) * scalingFactor);
    const encryptedParam = await clearParam.encrypt();

    const removeLiqTx = await pair["removeLiquidity(bytes32,address,uint256,bytes)"](
      encryptedParam.handles[0],
      signer.address,
      blockTimestamp + 120,
      encryptedParam.inputProof,
    );
    const removeLiqReceipt = await removeLiqTx.wait();

    console.log(`Remove liquidity TX status : ${removeLiqReceipt?.status}`);

    if (!removeLiqReceipt?.status) {
      throw new Error("Add liquidity Tx failed.");
    }

    await decryptionRequestedEvent;
    await eventPromise;
  });

task("task:refund_addLiq", "Claims refund for an uncompleted liquidity adding")
  .addParam("requestid", "The associated decryption request id", undefined, types.int)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const pairAddress = cfg.PAIR_ADDRESS;
    if (!pairAddress) {
      throw new Error("Pair address not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
    await fhevm.initializeCLIApi();

    const requestID = _taskArguments.requestid;

    console.log(`Claiming liquidity adding refund for request ${requestID} from the pair (${pairAddress})`);

    const refundEvent = waitForRefund(pair);
    const refundTx = await pair.requestLiquidityAddingRefund(requestID);
    const refundReceipt = await refundTx.wait();

    if (!refundReceipt?.status) {
      throw new Error("Refund Tx failed.");
    }

    await refundEvent;
  });

task("task:refund_swap", "Claims refund for an uncompleted swap")
  .addParam("requestid", "The associated decryption request id", undefined, types.int)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const pairAddress = cfg.PAIR_ADDRESS;
    if (!pairAddress) {
      throw new Error("Pair address not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
    await fhevm.initializeCLIApi();

    const requestID = _taskArguments.requestid;

    console.log(`Claiming swap refund for request ${requestID} from the pair (${pairAddress})`);

    const refundEvent = waitForRefund(pair);
    const refundTx = await pair.requestSwapRefund(requestID);
    const refundReceipt = await refundTx.wait();

    if (!refundReceipt?.status) {
      throw new Error("Refund Tx failed.");
    }

    await refundEvent;
  });

task("task:refund_liqRem", "Claims refund for an uncompleted liquidity removal")
  .addParam("requestid", "The associated decryption request id", undefined, types.int)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const pairAddress = cfg.PAIR_ADDRESS;
    if (!pairAddress) {
      throw new Error("Pair address not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pair = await ethers.getContractAt("CAMMPair", pairAddress, signer);
    await fhevm.initializeCLIApi();

    const requestID = _taskArguments.requestid;

    console.log(`Claiming liquidity removal refund for request ${requestID} from the pair (${pairAddress})`);

    const refundEvent = waitForRefund(pair);
    const refundTx = await pair.requestLiquidityRemovalRefund(requestID);
    const refundReceipt = await refundTx.wait();

    if (!refundReceipt?.status) {
      throw new Error("Refund Tx failed.");
    }

    await refundEvent;
  });

  task("task:claim_airdrop", "Claims a 1000 token airdrop on token0 & token1.")
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const token0Address = cfg.TOKEN0_ADDRESS;
    const token1Address = cfg.TOKEN1_ADDRESS;
    if (!token0Address || !token1Address) {
      throw new Error("Token addresses not defined in CAMM.json");
    }

    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const token0 = await ethers.getContractAt("ConfidentialToken", token0Address, signer);
    const token1 = await ethers.getContractAt("ConfidentialToken", token1Address, signer);
    await fhevm.initializeCLIApi();

    const claimTx0 = await token0.airDrop();
    const claimReceipt0 = await claimTx0.wait();
    if (!claimReceipt0?.status) {
      throw new Error("Airdrop Tx on token 0 failed.");
    }
    console.log("Claimed airdrop on token 0.");

    const claimTx1 = await token1.airDrop();
    const claimReceipt1 = await claimTx1.wait();
    if (!claimReceipt1?.status) {
      throw new Error("Airdrop Tx on token 1failed.");
    }
    console.log("Claimed airdrop on token 1.");

  });