import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

describe("CAMM Tests", function () {
  before(async function () {
    this.signers = await ethers.getSigners();
    this.provider = ethers.provider;
    this.decimals = BigInt(10) ** BigInt(6);
    await fhevm.initializeCLIApi();
  });

  let log_str = "";

  it("Should deploy 2 Tokens.", async function () {
    const TokenFactory = await ethers.getContractFactory("ConfidentialToken", this.signers[0]);
    const tokenContract1 = await TokenFactory.deploy("Us Dollar", "USD");
    await tokenContract1.waitForDeployment();
    const tokenContract2 = await TokenFactory.deploy("EURO", "EUR");
    await tokenContract2.waitForDeployment();
    this.token1 = tokenContract1;
    this.token2 = tokenContract2;

    log_str = "Token 1 contract address : " + (await tokenContract1.getAddress());
    log(log_str, "deploy test tokens");

    log_str = "Token 2 contract address : " + (await tokenContract2.getAddress());
    log(log_str, "deploy test tokens");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await tokenContract1.getAddress()).to.be.properAddress;
    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await tokenContract2.getAddress()).to.be.properAddress;
  });

  it("Should deploy the CAMM Factory", async function () {
    const CAMMFactory = await ethers.getContractFactory("CAMMFactory", this.signers[0]);
    const CAMMFactoryContract = await CAMMFactory.deploy();
    await CAMMFactoryContract.waitForDeployment();

    this.factory = CAMMFactoryContract;
    log_str = "Factory address : " + this.factory.target.toString();
    log(log_str, "deploy factory");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(this.factory.target.toString()).to.properAddress;
  });

  it("Should create a pair with the 2 Tokens.", async function () {
    const factory = this.factory;
    const token1 = this.token1;
    const token2 = this.token2;

    const createPairTx = await factory.createPair(
      await token1.getAddress(),
      await token2.getAddress(),
      this.signers[0].address,
    );
    const createPairReceipt = await createPairTx.wait();
    expect(createPairReceipt.status).to.equal(1);

    const pairAddress = await factory.getPair(await token1.getAddress(), await token2.getAddress());
    const pairContract = await ethers.getContractAt("CAMMPair", pairAddress, this.signers[0]);
    this.pair = pairContract;

    log_str = "Pair address : " + pairAddress;
    log(log_str, "create pair");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(pairAddress).to.properAddress;
  });

  it("Should add CAMM as an operator on both tokens (allow).", async function () {
    const pair = this.pair;
    const token1 = this.token1; // USD
    const token2 = this.token2; // EUR

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const setOperatorTx1 = await token1.setOperator(await pair.getAddress(), targetTimestamp);
    const setOperatorReceipt1 = await setOperatorTx1.wait();
    expect(setOperatorReceipt1.status).to.equal(1);

    const setOperatorTx2 = await token2.setOperator(await pair.getAddress(), targetTimestamp);
    const setOperatorReceipt2 = await setOperatorTx2.wait();
    expect(setOperatorReceipt2.status).to.equal(1);

    const isOperator1 = await token1.isOperator(this.signers[0].address, await pair.getAddress());
    const isOperator2 = await token2.isOperator(this.signers[0].address, await pair.getAddress());

    log_str = `Is pair an operator for signer 0 on token 1 : ${isOperator1}`;
    log(log_str, "set operator");

    log_str = `Is pair an operator for signer 0 on token 2 : ${isOperator2}`;
    log(log_str, "set operator");
  });

  it("Should add liquidity on pair (first LP mint)", async function () {
    const pair = this.pair;
    const token1 = this.token1; // EUR
    const token2 = this.token2; // USD
    //Mocked mode : token1 on pair is USD and token2 is EUR

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 before : ${clearBalance1Before / this.decimals}`;
    log(log_str, "add liquidity (first mint)");

    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 before : ${clearBalance2Before / this.decimals}`;
    log(log_str, "add liquidity (first mint)");

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const deadlineTimestamp = blockTimestamp + 1000;

    const addLiqInput = fhevm.createEncryptedInput(await pair.getAddress(), this.signers[0].address);
    const encryptedAddLiqInput = await addLiqInput
      .add64(BigInt(10_000) * this.decimals)
      .add64(BigInt(12_000) * this.decimals)
      .encrypt();

    //Here amount0 = amount of token0 (EUR on pair)
    const addLiqTx = await pair["addLiquidity(bytes32,bytes32,uint256,bytes)"](
      encryptedAddLiqInput.handles[0],
      encryptedAddLiqInput.handles[1],
      deadlineTimestamp,
      encryptedAddLiqInput.inputProof,
    );

    const addLiqReceipt = await addLiqTx.wait();
    expect(addLiqReceipt.status).to.equal(1);

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 after : ${clearBalance1After / this.decimals}`;
    log(log_str, "add liquidity (first mint)");
    expect(clearBalance1After / this.decimals).to.equal(88_000);

    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 after : ${clearBalance2After / this.decimals}`;
    log(log_str, "add liquidity (first mint)");
    expect(clearBalance2After / this.decimals).to.equal(90_000);

    const encryptedLPBalance = await pair.confidentialBalanceOf(this.signers[0].address);
    const clearLPBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedLPBalance,
      await pair.getAddress(),
      this.signers[0],
    );
    log_str = `LP balance after adding liquidity : ${clearLPBalance / this.decimals}`;
    log(log_str, "add liquidity (first mint)");
    expect(clearLPBalance / this.decimals).to.equal(10900);
  });

  it("Should retrieve first approx price", async function () {
    const pair = this.pair;

    const getPermissionTx = await pair.requestReserveInfo();
    const getPermissionReceipt = await getPermissionTx.wait();
    expect(getPermissionReceipt.status).to.equal(1);

    const { obfuscatedReserve0, obfuscatedReserve1 } = await pair.obfuscatedReserves();
    const clearObfuscatedReserve0 = await fhevm.userDecryptEuint(
      FhevmType.euint128,
      obfuscatedReserve0,
      await pair.getAddress(),
      this.signers[0],
    );

    const clearObfuscatedReserve1 = await fhevm.userDecryptEuint(
      FhevmType.euint128,
      obfuscatedReserve1,
      await pair.getAddress(),
      this.signers[0],
    );

    const price = (clearObfuscatedReserve0 * this.decimals) / clearObfuscatedReserve1;
    log_str = `Current approximated price : ${price}, without decimals : ${ethers.formatUnits(price.toString(), 6)}`;
    log(log_str, "retrieve price");
  });

  it("Should add liquidity on pair (second LP mint)", async function () {
    const pair = this.pair;
    const token1 = this.token1; // USD
    const token2 = this.token2; // EUR

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 before : ${clearBalance1Before / this.decimals}`;
    log(log_str, "add liquidity (second mint)");

    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 before : ${clearBalance2Before / this.decimals}`;
    log(log_str, "add liquidity (second mint)");

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const deadlineTimestamp = blockTimestamp + 1000;

    const addLiqInput = fhevm.createEncryptedInput(await pair.getAddress(), this.signers[0].address);
    const encryptedAddLiqInput = await addLiqInput
      .add64(BigInt(20_000) * this.decimals)
      .add64(BigInt(20_000) * this.decimals)
      .encrypt();

    const eventPromise = pollSpecificEvent(pair, "liquidityMinted", "add liquidity (second mint)");

    const addLiqTx = await pair["addLiquidity(bytes32,bytes32,uint256,bytes)"](
      encryptedAddLiqInput.handles[0],
      encryptedAddLiqInput.handles[1],
      deadlineTimestamp,
      encryptedAddLiqInput.inputProof,
    );
    const addLiqReceipt = await addLiqTx.wait();
    expect(addLiqReceipt.status).to.equal(1);

    //comment the following line when doing untit tests on sepolia
    await fhevm.awaitDecryptionOracle();

    await eventPromise;

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 after : ${clearBalance1After / this.decimals}`;
    log(log_str, "add liquidity (second mint)");
    expect(clearBalance1After / this.decimals).to.lessThan(80000);

    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 after : ${clearBalance2After / this.decimals}`;
    log(log_str, "add liquidity (second mint)");
    expect(clearBalance2After / this.decimals).to.lessThan(80000);

    const encryptedLPBalance = await pair.confidentialBalanceOf(this.signers[0].address);
    const clearLPBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedLPBalance,
      await pair.getAddress(),
      this.signers[0],
    );
    log_str = `LP balance after adding liquidity : ${clearLPBalance / this.decimals}`;
    log(log_str, "add liquidity (second mint)");
    //expect(clearLPBalance / this.decimals).to.equal(29_700);
  });

  it("Should swap tokens", async function () {
    const pair = this.pair;
    const token1 = this.token1; // USD
    const token2 = this.token2; // EUR

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 before : ${clearBalance1Before / this.decimals}`;
    log(log_str, "swap tokens");

    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 before : ${clearBalance2Before / this.decimals}`;
    log(log_str, "swap tokens");

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const deadlineTimestamp = blockTimestamp + 1000;

    const eventPromise = pollSpecificEvent(pair, "Swap", "swap tokens");

    const swapInput = fhevm.createEncryptedInput(await pair.getAddress(), this.signers[0].address);
    const encryptedSwapInput = await swapInput
      .add64(BigInt(250) * this.decimals)
      .add64(BigInt(0) * this.decimals)
      .encrypt();

    const swapTx = await pair["swapTokens(bytes32,bytes32,address,uint256,bytes)"](
      encryptedSwapInput.handles[0],
      encryptedSwapInput.handles[1],
      this.signers[0].address,
      deadlineTimestamp,
      encryptedSwapInput.inputProof,
    );
    const swapReceipt = await swapTx.wait();
    expect(swapReceipt.status).to.equal(1);

    //comment the following line when doing untit tests on sepolia
    await fhevm.awaitDecryptionOracle();

    const eventParams = await eventPromise;
    const encryptedAmount0In = eventParams[1];
    const encryptedAmount1In = eventParams[2];
    const encryptedAmount0Out = eventParams[3];
    const encryptedAmount1Out = eventParams[4];

    const clearAmount0In = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedAmount0In,
      await pair.getAddress(),
      this.signers[0],
    );

    const clearAmount1In = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedAmount1In,
      await pair.getAddress(),
      this.signers[0],
    );

    const clearAmount0Out = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedAmount0Out,
      await pair.getAddress(),
      this.signers[0],
    );

    const clearAmount1Out = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedAmount1Out,
      await pair.getAddress(),
      this.signers[0],
    );

    log_str = `amount0In : ${ethers.formatUnits(clearAmount0In.toString(), 6)}, amount1In : ${ethers.formatUnits(clearAmount1In.toString(), 6)} || amount0Out : ${ethers.formatUnits(clearAmount0Out.toString(), 6)}, amount1Out : ${ethers.formatUnits(clearAmount1Out.toString(), 6)}`;
    log(log_str, "swap tokens");
  });

  it("Should retrieve new balances and new approx price.", async function () {
    const pair = this.pair;
    const token1 = this.token1; // USD
    const token2 = this.token2; // EUR

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `New balance 1 : ${clearBalance1After / this.decimals}`;
    log(log_str, "retrieve price & balances");

    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `New balance 2 after : ${clearBalance2After / this.decimals}`;
    log(log_str, "retrieve price & balances");

    const getPermissionTx = await pair.requestReserveInfo();
    const getPermissionReceipt = await getPermissionTx.wait();
    expect(getPermissionReceipt.status).to.equal(1);

    const { obfuscatedReserve0, obfuscatedReserve1 } = await pair.obfuscatedReserves();
    const clearObfuscatedReserve0 = await fhevm.userDecryptEuint(
      FhevmType.euint128,
      obfuscatedReserve0,
      await pair.getAddress(),
      this.signers[0],
    );

    const clearObfuscatedReserve1 = await fhevm.userDecryptEuint(
      FhevmType.euint128,
      obfuscatedReserve1,
      await pair.getAddress(),
      this.signers[0],
    );

    const price = (clearObfuscatedReserve0 * this.decimals) / clearObfuscatedReserve1;
    log_str = `New approximated price : ${price}, without decimals : ${ethers.formatUnits(price.toString(), 6)}`;
    log(log_str, "retrieve price & balances");
  });

  it("Should remove 20k liquidity.", async function () {
    const pair = this.pair;
    const token1 = this.token1; // USD
    const token2 = this.token2; // EUR

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 before : ${clearBalance1Before / this.decimals}`;
    log(log_str, "remove liquidity");

    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 before : ${clearBalance2Before / this.decimals}`;
    log(log_str, "remove liquidity");

    const encryptedLPBalanceBefore = await pair.confidentialBalanceOf(this.signers[0].address);
    const clearLPBalanceBefore = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedLPBalanceBefore,
      await pair.getAddress(),
      this.signers[0],
    );
    log_str = `LP balance before removing liquidity : ${clearLPBalanceBefore / this.decimals}`;
    log(log_str, "remove liquidity");

    const setOperatorTx = await pair.setOperator(await pair.getAddress(), targetTimestamp);
    const setOperatorReceipt = await setOperatorTx.wait();
    expect(setOperatorReceipt.status).to.equal(1);

    const eventPromise = pollSpecificEvent(pair, "liquidityBurnt", "remove liquidity");

    const removeLiqInput = fhevm.createEncryptedInput(await pair.getAddress(), this.signers[0].address);
    const encryptedRemoveLiqInput = await removeLiqInput.add64(BigInt(20000) * this.decimals).encrypt();

    const removeLiqTx = await pair["removeLiquidity(bytes32,address,uint256,bytes)"](
      encryptedRemoveLiqInput.handles[0],
      this.signers[0].address,
      blockTimestamp + 10000,
      encryptedRemoveLiqInput.inputProof,
    );
    const removeLiqReceipt = await removeLiqTx.wait();
    expect(removeLiqReceipt.status).to.equal(1);

    //comment the following line when doing untit tests on sepolia
    await fhevm.awaitDecryptionOracle();

    await eventPromise;

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 1 after : ${clearBalance1After / this.decimals}`;
    log(log_str, "remove liquidity");

    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);
    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );
    log_str = `Balance 2 after : ${clearBalance2After / this.decimals}`;
    log(log_str, "remove liquidity");

    const encryptedLPBalanceAfter = await pair.confidentialBalanceOf(this.signers[0].address);
    const clearLPBalanceAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedLPBalanceAfter,
      await pair.getAddress(),
      this.signers[0],
    );
    log_str = `LP balance after removing liquidity : ${clearLPBalanceAfter / this.decimals}`;
    log(log_str, "remove liquidity");
  });
});

const log = (message: string, scope: string) => {
  const log_str = `\t[DEBUG] (${scope}) : ${message}`;
  console.log(log_str);
};

/**
 * Polls for a specific event emitted by the contract, returning true if the event is emitted, otherwise false.
 * @param contract The ethers.js Contract instance.
 * @param eventName The name of the event to listen for.
 * @param pollInterval The interval in milliseconds to poll for new events.
 * @returns A Promise that resolves to true if the event was emitted, otherwise false.
 */
async function pollSpecificEvent(
  contract: ethers.Contract,
  eventName: string,
  scope: string,
  pollInterval: number = 5000,
): Promise<any> {
  let lastBlockNumber = await ethers.provider.getBlockNumber(); // Start from the latest block
  let log_str = "";

  return new Promise<any[]>((resolve) => {
    // Set a timeout to stop the polling after 40 seconds
    const timeout = setTimeout(() => {
      log_str = `Timeout: Event '${eventName}' was not emitted within 180 seconds`;
      log(log_str, scope);
      clearInterval(pollingInterval); // Stop polling
      resolve(null); // Resolve with null since the event was not emitted in the given time
    }, 40000);

    // Set an interval to poll for the specific event
    const pollingInterval = setInterval(async () => {
      try {
        const currentBlockNumber = await ethers.provider.getBlockNumber();

        if (currentBlockNumber > lastBlockNumber) {
          // Fetch all events emitted since the last polled block
          const logs = await ethers.provider.getLogs({
            address: contract.target,
            fromBlock: lastBlockNumber + 1, // Start from the block after the last checked one
            toBlock: currentBlockNumber,
          });

          const param_names = [];
          const param_values = [];

          // Iterate over logs and filter for the specified event
          for (const log_entry of logs) {
            const parsedLog = contract.interface.parseLog(log_entry);
            if (parsedLog && parsedLog.name === eventName) {
              parsedLog.fragment.inputs.forEach((value, index) => {
                param_names.push(value.name);
              });

              parsedLog.args.forEach((value, index) => {
                param_values.push(value);
              });

              let display_str = `Event triggered: ${parsedLog.name} \n`;

              for (let i = 0; i < param_names.length; i++) {
                if (param_names[i] != "") {
                  display_str += "\t\t" + param_names[i] + " = " + param_values[i] + "\n";
                }
              }

              log(display_str, scope);

              // Resolve the promise with the parameter values
              clearTimeout(timeout); // Clear the timeout
              clearInterval(pollingInterval); // Stop polling
              resolve(param_values); // Resolve with the parameter values
              return;
            }
          }

          // Update the last block number
          lastBlockNumber = currentBlockNumber;
        }
      } catch (error) {
        console.error("Error polling events:", error);
        clearTimeout(timeout); // Clear the timeout in case of error
        clearInterval(pollingInterval); // Stop polling in case of error
        resolve(null); // Resolve with null in case of an error
      }
    }, pollInterval);
  });
}
