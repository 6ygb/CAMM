# CAMM - Confidential Automated Market Maker

**A UniswapV2-style AMM where amounts, balances, and reserves are encrypted end-to-end** using **Zama’s Fully Homomorphic Encryption (FHEVM)**.  
Liquidity, swaps, and even obfuscated reserves are computed on encrypted ciphertexts; only authorized parties can decrypt specific outputs.
> ⚠️ **Proof-of-concept only** - not production-ready.

</br></br></br>

<p align=center> 
  Built using Zama's <a href="https://github.com/zama-ai/fhevm">fhEVM</a>, Inspired by <a href="https://github.com/Uniswap/v2-core">UniswapV2</a> 
</p>

## Test it !
> ⚠️ **Please read the docs first** ⚠️

<br> 
Front-end POC with test contracts at : https://camm.6ygb.dev <br> <br>
Deployed on Sepolia :

- Factory (https://sepolia.etherscan.io/address/0x15F98C153493b12D85c0F493e9E7c971203a4809#code) :
  
  ```
  0x15F98C153493b12D85c0F493e9E7c971203a4809
  ``` 

- Pair (https://sepolia.etherscan.io/address/0x2ab55edf81f6c17fa1A22aF23ed38cE8cF276414#code) :
  ```
  0x2ab55edf81f6c17fa1A22aF23ed38cE8cF276414
  ```

- Token 0 - EUR (https://sepolia.etherscan.io/address/0x20E217aD102f18d20faE1B4C7edCD041EF041fE9#code) :
  ```
  0x20E217aD102f18d20faE1B4C7edCD041EF041fE9
  ```

- Token 1 - USD (https://sepolia.etherscan.io/address/0xDa5C50A7b88F1D9F59465f21488db38885aF1d7B#code) :
  ```
  0xDa5C50A7b88F1D9F59465f21488db38885aF1d7B
  ```
- Pair Library (https://sepolia.etherscan.io/address/0xDE6f4202A2ca25Fd329EcD11f2c62F90248Ad0fd#code) :
  ```
  0xDE6f4202A2ca25Fd329EcD11f2c62F90248Ad0fd
  ```

<br>
Front end repo available at https://github.com/6ygb/CAMM-FRONT

---
## What’s inside

- **CAMMFactory**: creates confidential token pairs deterministically.
- **CAMMPair**: the core AMM logic (add/remove liquidity, swaps, refunds), all with encrypted math.
- **CAMMPairLib** : helper library which lightens the pair from heavy computation.
- **testToken** (example): OpenZeppelin ConfidentialFungibleToken with an initial encrypted mint for testing.
- **Hardhat tasks** to deploy, add liquidity, swap, remove, and trigger refunds.
- **Tests** that cover “common paths” and refund flows.

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [High-level design](#high-level-design)
- [On-chain decryption without breaking confidentiality](#on-chain-decryption-without-breaking-confidentiality)
- [Obfuscated reserves](#obfuscated-reserves)
- [Refund policy](#refund-policy)
- [Adding Liquidity](#adding-liquidity)
- [Contract APIs & Events](#contract-apis--events)
- [Hardhat Tasks](#hardhat-tasks)
- [Config file (`CAMM.json`)](#config-file-cammjson)
- [Testing](#testing)
- [Limitations](#limitations)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## High-level design

- **Encrypted types**: the pair operates on mainly `euint64` (FHE types) for amounts (obfuscated reserves are relying on `euint128`).  
  Reserves, LP amounts, amounts in/out, and computed prices stay encrypted on-chain.
  
- **ERC-7984 implementation**: CAMM implements Open Zeppelin's Confidential Token standard **ERC-7984** for both the pair tokens and the pair itself, providing ERC-compatible interfaces while preserving confidentiality.

- **Two-step operations**: add-liquidity (post-bootstrap), remove-liquidity, and swap prepare **encrypted** expressions and request **decryption** via the FHEVM gateway, then settle in a callback. While a request is “live”, the pool is temporarily locked. The decrypted amounts will never break the AMM confidentiality, see later sections for further explainations.

- **Timeout guard**: if a decryption is never fulfilled, the pool auto-unlocks after `MAX_DECRYPTION_TIME` (**5 minutes**) to avoid permanent locking in case of gateway outage.

- **Refund Policy**: If the a decryption request is not fulfilled (meaning that an operation like adding/removing liquidity or swapping cannot be entirely completed) in time (or in case of outage on Zama's end), the user can request a refund of the sent funds.

- **Price privacy**: reserves are **obfuscated**, both multiplied by the same number and both are reduced or increased by a % in the range [0.7 - 3.26]. An optional external **price scanner address** is whitelisted to read those obfuscated values facilitating decryption from a front end. Any user can request decryption right to the obfuscated reserves.

- **Fees**: a **1% fee** is applied to every swap in order to pay liquidity providers.

- **LP token**: LP supply is an encrypted `euint64`. A **minimum liquidity** of `100 * 10^6` (since decimals = 6) is enforced on the first mint.


---


## On-chain decryption without breaking confidentiality

AMMs highly rely on division for computing swap output amounts and all liquidity operations. As for now (**FHEVM 0.7**), division between two encrypted numbers is not supported. However division between a ciphertext and a clear number is possible. This imply that all the denominators must be decrypted. </br> </br>
Reserves are encrypted for confidentiality, decrypting them at each swap would leak the actual amounts being swaped. That's why, to operate, CAMM must find a way to decrypt reserves or other confidential amounts without leaking their real value. </br> </br>
To achieve this, CAMM rely on a very simple mathematical concept : **division invariance**.
This concept states that if you multiply your base numerator and denominator by the same number, the result (ratio) **will stay the same**. </br> </br>
As written before, only our denominator needs to be decrypted. So if we multiply our numerator and denominator by an **encrypted random number**, only the **denomintaor times a random number** is decrypted, without leaking information on our base denominator value. </br> </br>
Let's see with a simple example involving a simple swap. </br>
**Recall**, here is the formula for the output amount of a swap (without fees) : </br>

$\text{amountOut } =\frac{\text{amountIn } \times \text{ reserveOut}}{\text{reserveIn } + \text{ amountIn}}$
</br></br>
Let's consider the following setup :
- **reserves** : `110_000 token0` & `100_000 token1` (ignore decimals)
- **amountIn** : let's say we want to swap 500 token0 for x token1. </br>

The result would be : </br>

$\text{amount1Out} = \frac{500 \times 100000}{110000 + 500} = 452.42$

Now let's imagine our reserves are encrypted and we do not want to leak their real value. The setup is the same, we only add a random number, let's say **2727**. <br/>
The base formula become : </br>

$\text{amountOut } =\frac{(\text{amountIn } \times \text{ reserveOut }) \times \text{ randomNumber}}{(\text{reserveIn } + \text{ amountIn})  \times \text{ randomNumber}} $ 
</br>

And the swap output : </br>

$\text{amount1Out} = \frac{(500 \times 100000) \times 2727}{(110000 + 500) \times 2727} = 452.42$
</br>

The result stays the same. But after decrypting the denominator, it changes a lot. 
- $(\text{amountIn } \times \text{ reserveOut }) \times \text{ randomNumber}$ stays encrypted.
- $(\text{amountIn } + \text{ reserveOut }) \times \text{ randomNumber}$ is decrypted.

Instead of having 110000 + 500 as a clear value, which is very close to the real reserve value, we have $(110000 + 500) \times 2727$. </br>
As the number is random (thanks to FHEVM API `FHE.randEuint()`), decrypted outputs are random and more resistant to information leak. An observer wanting to find the reserves value will see unrelated increasing and decreasing numbers. </br></br>

The same principle is applied everytime a division is needed :
- `function addLiquidity()`
- `function removeLiquidity()`
- `function swapTokens()`

For example, with the swapTokens function (divUpperPart = numerator, divLowerPart = denominator):
```solidity
function computeSwap(
        euint64 sent0,
        euint64 sent1,
        euint64 reserve0,
        euint64 reserve1
    ) external returns (euint128, euint128, euint128, euint128) {
        euint16 rng0 = computeRNG(16384, 3);
        euint16 rng1 = computeRNG(16384, 3);

        // 1% fee integration in the rng multiplier to optimize HCU consuption
        euint32 rng0Upper = FHE.div(FHE.mul(FHE.asEuint32(rng0), uint32(99)), uint32(100));
        euint32 rng1Upper = FHE.div(FHE.mul(FHE.asEuint32(rng1), uint32(99)), uint32(100));

        euint128 divUpperPart0 = FHE.mul(
            FHE.mul(FHE.asEuint128(sent1), FHE.asEuint128(reserve0)),
            FHE.asEuint128(rng0Upper)
        );
        euint128 divLowerPart0 = FHE.mul(FHE.asEuint128(reserve1), FHE.asEuint128(rng0));

        euint128 divUpperPart1 = FHE.mul(
            FHE.mul(FHE.asEuint128(sent0), FHE.asEuint128(reserve1)),
            FHE.asEuint128(rng1Upper)
        );
        euint128 divLowerPart1 = FHE.mul(FHE.asEuint128(reserve0), FHE.asEuint128(rng1));

        return (divUpperPart0, divUpperPart1, divLowerPart0, divLowerPart1);
    }

function swapTokensCallback(
        uint256 requestID,
        uint128 _divLowerPart0,
        uint128 _divLowerPart1,
        bytes[] memory signatures
    ) external {
        if (pendingDecryption.currentRequestID != requestID) revert WrongRequestID();
        FHE.checkSignatures(requestID, signatures);

        euint128 _divUpperPart0 = swapDecBundle[requestID].divUpperPart0;
        euint128 _divUpperPart1 = swapDecBundle[requestID].divUpperPart1;
        address from = swapDecBundle[requestID].from;
        address to = swapDecBundle[requestID].to;

        euint64 amount0Out = FHE.asEuint64(FHE.div(_divUpperPart0, _divLowerPart0));
        euint64 amount1Out = FHE.asEuint64(FHE.div(_divUpperPart1, _divLowerPart1));

        FHE.allowThis(amount0Out);
        FHE.allowThis(amount1Out);
        _transferTokensFromPool(to, amount0Out, amount1Out, true);
        [...]
        emit Swap(
            from,
            swapDecBundle[requestID].amount0In,
            swapDecBundle[requestID].amount1In,
            swapOutput[requestID].amount0Out,
            swapOutput[requestID].amount1Out,
            to
        );

        delete pendingDecryption;
        delete standardRefund[from][requestID];
    }

```

---

## Obfuscated reserves

In CAMM, reserves are encrypted. Broadcasting the exact price of a token to the other (by decrypting the price) could potentialy leak :
- The proportion of a reserve to another (which is not that sensitive)
- The price impact of a swap, potentialy giving an approximative idea of its size

To avoid information leak and to preserve confidentiality, CAMM broadcasts **obfuscated reserves**. It does it by having a public struct containing those **obfuscated reserves** and giving decryption right to whoever asks for it.

```solidity
struct obfuscatedReservesStruct {
        euint128 obfuscatedReserve0;
        euint128 obfuscatedReserve1;
}

obfuscatedReservesStruct public obfuscatedReserves;
[...]
function requestReserveInfo() public {
        FHE.allow(obfuscatedReserves.obfuscatedReserve0, msg.sender);
        FHE.allow(obfuscatedReserves.obfuscatedReserve1, msg.sender);
        emit discloseReservesInfo(
            block.number,
            msg.sender,
            obfuscatedReserves.obfuscatedReserve0,
            obfuscatedReserves.obfuscatedReserve1
        );
    }
```
As this process of having to request decryption right everytime to get the approximative price can be repetitive and expensive, an address named **price scanner** can be provided when creating the pair.
This **price scanner** address is granted permanent decryption right on **obfuscated reserve** and can be used by the front-end of a dApp to decrypt and display price without having to call `requestReserveInfo()`. </br>
### What are obfuscated reserves
As their name suggest, these "reserves" are mathematicaly modified to avoid leaking the exact value of the pair reserves. As seen in the previous section, multiplying both numerator and denominator of a division by the same number does not alter the result. </br></br>
As computing the price of a token to another is just divising a reserve by another (`reserve0/reserve1` = price of token0 in token1), we can multiply reserves by a random number everytime they change to hide their real value. </br></br>
But this would not be sufficient, in fact, the price would still be exact and could leak the price impact of the last swap if observed before and after it. That's why they're also multiplied by a random number modifying their value by max ±3.26% each (the % is between 0.7% and 3.26%). The final decrypted price is innacurate by max ~ ±7%. This innacuracy changes everytime reserves are updated and its role is to hide swap price impact. </br></br>
In order to compute **obfuscated reserves**, CAMM uses the following formula : </br>
$\text{obfuscatedReserve }= \text{reserve }\times \text{ randomPercentageMultiplier }\times \text{ randomEuint16}$ </br>
$\text{randomPercentageMultiplier } =  1 ± [0.007 - 0.0326]$ </br></br>

This whole process takes place in the `_updateObfuscatedReserves()` and delegated to `CAMMPairLib.computeObfuscatedReserves()` :
```solidity
function computeObfuscatedReserves(
        euint64 reserve0,
        euint64 reserve1,
        uint64 scalingFactor
    ) external returns (euint128, euint128) {
        euint16 percentage = computeRNG(256, 70);

        //Never overflows because max rng bounded is 326 and max euint16 is 65535
        euint16 scaledPercentage = FHE.mul(percentage, 100);
        euint32 upperBound = FHE.add(FHE.asEuint32(scaledPercentage), uint32(scalingFactor));
        euint32 lowerBound = FHE.sub(uint32(scalingFactor), FHE.asEuint32(scaledPercentage));

        ebool randomBool0 = FHE.randEbool();
        ebool randomBool1 = FHE.randEbool();

        euint32 reserve0Multiplier = FHE.select(randomBool0, upperBound, lowerBound);
        euint32 reserve1Multiplier = FHE.select(randomBool1, lowerBound, upperBound);

        euint16 rngMultiplier = computeRNG(0, 3);

        //need euint64 here because max value for upperBound * max value for rngmultiplier > max euint32
        euint64 reserve0Factor = FHE.mul(FHE.asEuint64(reserve0Multiplier), rngMultiplier);
        euint64 reserve1Factor = FHE.mul(FHE.asEuint64(reserve1Multiplier), rngMultiplier);

        euint128 _obfuscatedReserve0 = FHE.mul(FHE.asEuint128(reserve0), reserve0Factor);
        euint128 _obfuscatedReserve1 = FHE.mul(FHE.asEuint128(reserve1), reserve1Factor);

        return (_obfuscatedReserve0, _obfuscatedReserve1);
    }
```

---

## Refund policy
CAMM heavily relies on Zama's on-chain decryption process. This process is asynchronous and complex. It happens sometimes that the decryption request is sent but never answered. In this case the user action on the pair is frozen in the middle of its completion. In these cases, the users tokens are already sent to the pair but they never get what they was due. </br> </br>
To mitigate this issue, every (encrypted) amount sent by users are stored inside **refund strcut**. If ever needed any user can get a refund if the decryption request associated to their action has not been carried out. </br></br>
The following function create refund bundles :
- `addLiquidity()`
- `removeLiquidity()`
- `swapTokens()`

```solidity
struct standardRefundStruct {
        euint64 amount0;
        euint64 amount1;
}
struct liquidityRemovalRefundStruct {
    euint64 lpAmount;
}
mapping(address from => mapping(uint256 requestID => standardRefundStruct)) public standardRefund;
mapping(address from => mapping(uint256 requestID => liquidityRemovalRefundStruct)) public liquidityRemovalRefund;
[...]
//Refund bundle creation example
function _addLiquidity(
        euint64 amount0,
        euint64 amount1,
        address from,
        uint256 deadline
) internal ensure(deadline) decryptionAvailable {
    [...]
    //sending the tokens without adding them to pool
    (euint64 sentAmount0, euint64 sentAmount1) = _transferTokensToPool(from, amount0, amount1, false);
    [...]
    standardRefund[from][requestID].amount0 = sentAmount0;
    standardRefund[from][requestID].amount1 = sentAmount1;
    [...]
}
```

3 public functions are available for any user to get their refund :
- `requestLiquidityAddingRefund()`
- `requestSwapRefund()`
- `requestLiquidityRemovalRefund()`

These function work as the following
```solidity
function requestSwapRefund(uint256 requestID) public {
    if (
        !FHE.isInitialized(standardRefund[msg.sender][requestID].amount0) ||
        !FHE.isInitialized(standardRefund[msg.sender][requestID].amount1)
    ) revert NoRefund();

    euint64 refundAmount0 = standardRefund[msg.sender][requestID].amount0;
    euint64 refundAmount1 = standardRefund[msg.sender][requestID].amount1;

    _transferTokensFromPool(msg.sender, refundAmount0, refundAmount1, true);

    // If refund is sent prior to decryption we need to block the decryption
    if (requestID == pendingDecryption.currentRequestID) {
        delete pendingDecryption;
    }

    delete standardRefund[msg.sender][requestID];
    emit Refund(msg.sender, block.number, requestID);
}

```

---

## Adding Liquidity

On UniswapV2 adding liquidity require the amounts to comply with the **constant product formula** : "This formula, most simply expressed as x * y = k, states that trades must not change the product (k) of a pair’s reserve balances (x and y)". </br> </br>
In practice, this means liquidity providers must deposit tokens in the same proportion as the current reserves, so that while the pool size (and thus k) increases, the price ratio x/y remains unchanged. </br></br>
As CAMM reserves values are encrypted and not directly available (only through **Obfuscated Reserves**) it's hard for a user to compute the good token proportion to add as liquidity. CAMM automaticaly computes the right token amounts to add and refunds the rest to the user, directly in the liquidity adding process. </br> </br>
Those right amounts are computed using prices derived from **Obfuscated Reserves** :
```solidity
function computeAddLiquidityCallback(
        euint64 sentAmount0,
        euint64 sentAmount1,
        euint128 partialUpperPart0,
        euint128 partialUpperPart1,
        uint128 divLowerPart0,
        uint128 divLowerPart1,
        uint128 priceToken0,
        uint128 priceToken1,
        uint64 scalingFactor
    ) external returns (euint64, euint64, euint64, euint64, euint64) {
        euint64 targetAmount0 = FHE.mul(FHE.div(sentAmount1, uint64(priceToken0)), scalingFactor); // 997_000 HCU
        euint64 targetAmount1 = FHE.mul(FHE.div(sentAmount0, uint64(priceToken1)), scalingFactor); // 997_000 HCU

        ebool isGoodTarget0 = FHE.ge(targetAmount0, sentAmount0);
        ebool isGoodTarget1 = FHE.ge(targetAmount1, sentAmount1);

        euint64 amount0 = FHE.select(isGoodTarget0, sentAmount0, targetAmount0);
        euint64 amount1 = FHE.select(isGoodTarget1, sentAmount1, targetAmount1);

        euint128 divUpperPart0 = FHE.mul(FHE.asEuint128(amount0), partialUpperPart0); // 646_000 HCU
        euint128 divUpperPart1 = FHE.mul(FHE.asEuint128(amount1), partialUpperPart1); // 646_000 HCU

        euint64 computedLPAmount0 = FHE.asEuint64(FHE.div(divUpperPart0, divLowerPart0)); // 651_000 HCU
        euint64 computedLPAmount1 = FHE.asEuint64(FHE.div(divUpperPart1, divLowerPart1)); // 651_000 HCU

        euint64 mintAmount = FHE.min(computedLPAmount0, computedLPAmount1);

        euint64 refundAmount0 = FHE.sub(sentAmount0, amount0);
        euint64 refundAmount1 = FHE.sub(sentAmount1, amount1);

        return (refundAmount0, refundAmount1, mintAmount, amount0, amount1);
    }
```
---

## Contract APIs & Events

This section summarizes the most used entry points of `CAMMPair`.

### Constructor & Init

```solidity
constructor(address _cammPriceScanner) ConfidentialFungibleToken("Liquidity Token", "PAIR", "")
function initialize(address _token0, address _token1) external
```

- `cammPriceScanner` is permanently allowed to decrypt **obfuscated reserves** for UI price display.
- `initialize` must be called by the factory to set `token0` and `token1` (confidential tokens).

### Liquidity

```solidity
// Contract‑called variant (amounts already encrypted & allowed)
function addLiquidity(euint64 amount0, euint64 amount1, uint256 deadline) external

// dApp‑called variant (external encryption + proof)
function addLiquidity(externalEuint64 encryptedAmount0, externalEuint64 encryptedAmount1, uint256 deadline, bytes calldata inputProof) external

// Removal
function removeLiquidity(euint64 lpAmount, address to, uint256 deadline) external
function removeLiquidity(externalEuint64 encryptedLPAmount, address to, uint256 deadline, bytes calldata inputProof) external
```

**Callbacks** (called by the gateway when denominators are decrypted):
```solidity
function addLiquidityCallback(
  uint256 requestID,
  uint128 divLowerPart0,
  uint128 divLowerPart1,
  uint128 _obfuscatedReserve0,
  uint128 _obfuscatedReserve1,
  bytes[] memory signatures
) external

function removeLiquidityCallback(
  uint256 requestID,
  uint128 divLowerPart0,
  uint128 divLowerPart1,
  bytes[] memory signatures
) external
```

### Swaps

```solidity
function swapTokens(euint64 amount0In, euint64 amount1In, address to, uint256 deadline) external
function swapTokens(externalEuint64 encryptedAmount0In, externalEuint64 encryptedAmount1In, address to, uint256 deadline, bytes calldata inputProof) external

function swapTokensCallback(
  uint256 requestID,
  uint128 _divLowerPart0,
  uint128 _divLowerPart1,
  bytes[] memory signatures
) external
```

### Refunds

```solidity
function requestLiquidityAddingRefund(uint256 requestID) public
function requestSwapRefund(uint256 requestID) public
function requestLiquidityRemovalRefund(uint256 requestID) public
```

### Reserves (obfuscated)

```solidity
function requestReserveInfo() public
// emits discloseReservesInfo(blockNumber, user, euint128 obfuscatedReserve0, euint128 obfuscatedReserve1)
```

### Events

- `event decryptionRequested(address from, uint256 blockNumber, uint256 requestID);`
- `event liquidityMinted(uint256 blockNumber, address user);`
- `event liquidityBurnt(uint256 blockNumber, address user);`
- `event Swap(address from, euint64 amount0In, euint64 amount1In, euint64 amount0Out, euint64 amount1Out, address to);`
- `event Refund(address from, uint256 blockNumber, uint256 requestID);`
- `event discloseReservesInfo(uint256 blockNumber, address user, euint128 obfuscatedReserve0, euint128 obfuscatedReserve1);`

### Errors

- `error Expired();` — deadline passed.  
- `error PendingDecryption(uint256 until);` — operation blocked until timeout.  
- `error Forbidden();` — caller not authorized (e.g., non‑factory initialize).  
- `error WrongRequestID();` — unexpected callback request ID.  
- `error DecryptionBlocked();` — (if used) a decryption was invalidated.  
- `error NoRefund();` — no staged refund for `(msg.sender, requestID)`.

---

## Hardhat Tasks

> The repo ships several tasks to **deploy** and exercise the pair.

### Deploy

```bash
npx hardhat deploy --network sepolia
npx hardhat task:deploy_camm --network sepolia --scanner 0x...
```

Writes addresses to `CAMM.json` for reuse by other tasks.

### Add Liquidity

```bash
# Direct (amounts are encrypted on-chain)
npx hardhat task:add_liquidity --amount0 12000 --amount1 10000 --network sepolia

```

### Swap

```bash
npx hardhat task:swap_tokens --amount0 500 --network sepolia
# or
npx hardhat task:swap_tokens --amount1 200 --network sepolia
```

### Remove Liquidity

```bash
npx hardhat task:remove_liquidity --amount 20000 --network sepolia
```

### Refunds

```bash
# After seeing `decryptionRequested(..., requestID)` but no callback
npx hardhat task:refund_add --request <id> --network sepolia
npx hardhat task:refund_swap --request <id> --network sepolia
npx hardhat task:refund_remove --request <id> --network sepolia
```

### Balances
```bash
npx hardhat task:claim_airdrop --network sepolia
npx hardhat task:get_balances --network sepolia
npx hardhat task:get_LPBalance --network sepolia
```

---

## Config file (`CAMM.json`)

The tasks persist runtime data under `CAMM.json` at the repo root.

```jsonc
{
  "FACTORY_ADDRESS": "0x...",
  "PAIR_ADDRESS": "0x...",
  "TOKEN0_ADDRESS": "0x...",
  "TOKEN1_ADDRESS": "0x...",
  "SCANNER_ADDRESS": "0x...",
  "LIQ_ADDED": true
}
```

---

## Testing

- Unit tests cover:
  - Deployment / initialization
  - First mint & minimum liquidity
  - Add liquidity (target amounts + refunds)
  - Remove liquidity (burn, payouts)
  - Swaps (in/out, 1% fee)
  - **Refund flows** for each operation (including event polling and timeouts)

---

## Limitations

- Division of ciphertext by ciphertext is not supported; the design depends on gateway callbacks.
- Obfuscated prices are **approximate** (~±7%) and change frequently.
- Gas/HCU costs for encrypted operations are **significant**.

---

## License

- Original contributions in this repo (including all `CAMM` smart contracts, tests, and tasks) are under the **BSD 3-Clause Clear License**.
- Template/dependencies (e.g., FHEVM tooling) follow their respective licenses (e.g., **MIT**). Check each package for details.

---

## Acknowledgments

- Built on **Zama’s FHEVM** for encrypted smart-contract computation.  
  Docs: https://docs.zama.ai/fhevm


<br />
<br />
<br />
<br />




# FHEVM Hardhat Template

A FHEVM Hardhat-based template for developing Solidity smart contracts.

# Quick Start

- [FHEVM Hardhat Quick Start Tutorial](https://docs.zama.ai/protocol/solidity-guides/getting-started/quick-start-tutorial)

# Documentation

- [The FHEVM documentation](https://docs.zama.ai/fhevm)
- [How to set up a FHEVM Hardhat development environment](https://docs.zama.ai/protocol/solidity-guides/getting-started/setup)
- [Run the FHEVM Hardhat Template Tests](https://docs.zama.ai/protocol/solidity-guides/development-guide/hardhat/run_test)
- [Write FHEVM Tests using Hardhat](https://docs.zama.ai/protocol/solidity-guides/development-guide/hardhat/write_test)
- [FHEVM Hardhart Plugin](https://docs.zama.ai/protocol/solidity-guides/development-guide/hardhat)
