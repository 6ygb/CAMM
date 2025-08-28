# CAMM - Confidential Automated Market Maker (FHEVM)

**A UniswapV2-style AMM where amounts, balances, and reserves are encrypted end-to-end** using **Zama’s Fully Homomorphic Encryption (FHEVM)**.  
Liquidity, swaps, and even obfuscated reserves are computed on encrypted ciphertexts; only authorized parties can decrypt specific outputs.

> ⚠️ **Proof-of-concept only** - not production-ready.

## What’s inside

- **CAMMFactory**: creates confidential token pairs deterministically.
- **CAMMPair**: the core AMM logic (add/remove liquidity, swaps, refunds), all with encrypted math.
- **testToken** (example): OpenZeppelin ConfidentialFungibleToken with an initial encrypted mint for testing.
- **Hardhat tasks** to deploy, add liquidity, swap, remove, and trigger refunds.
- **Tests** that cover “common paths” and refund flows.

---

## High-level design

- **Encrypted types**: the pair operates on mainly `euint64` (FHE types) for amounts (obfuscated reserves are relying on `euint128`).  
  Reserves, LP amounts, amounts in/out, and computed prices stay encrypted on-chain.

- **Two-step operations**: add-liquidity (post-bootstrap), remove-liquidity, and swap prepare **encrypted** expressions and request **decryption** via the FHEVM gateway, then settle in a callback. While a request is “live”, the pool is temporarily locked. The decrypted amounts will never break the AMM confidentiality, see later sections for further explainations.

- **Timeout guard**: if a decryption is never fulfilled, the pool auto-unlocks after `MAX_DECRYPTION_TIME` (**5 minutes**) to avoid permanent locking in case of gateway outage.

- **Refund Policy**: If the a decryption request is not fulfilled (meaning that an operation like adding/removing liquidity or swapping cannot be entirely completed) in time (or in case of outage on Zama's end), the user can request a refund of the sent funds.

- **Price privacy**: reserves are **obfuscated**, both multiplied by the same number and both are reduced or increased by 5%. An optional external **price scanner address** is whitelisted to read those obfuscated values facilitating decryption from a front end. Any user can request decryption right to the obfuscated reserves.

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
function _swapTokens(
        euint64 amount0In,
        euint64 amount1In,
        address from,
        address to,
        uint256 deadline
    ) internal ensure(deadline) decryptionAvailable {
        (euint64 sent0, euint64 sent1) = _transferTokensToPool(from, amount0In, amount1In, true);

        euint16 rng0 = _RNG_Bounded(16384, 3);
        euint16 rng1 = _RNG_Bounded(16384, 3);

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

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(divLowerPart0);
        cts[1] = FHE.toBytes32(divLowerPart1);

        uint256 requestID = FHE.requestDecryption(cts, this.swapTokensCallback.selector);
        [...]
        emit decryptionRequested(from, block.number, requestID);
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

This whole process is done in the `_updateObfuscatedReserves()` :
```solidity
function _updateObfuscatedReserves() internal {
        euint16 percentage = _RNG_Bounded(256, 70);

        euint16 scaledPercentage = FHE.mul(percentage, 100);
        euint32 upperBound = FHE.add(FHE.asEuint32(scaledPercentage), uint32(scalingFactor));
        euint32 lowerBound = FHE.sub(uint32(scalingFactor), FHE.asEuint32(scaledPercentage));

        ebool randomBool0 = FHE.randEbool();
        ebool randomBool1 = FHE.randEbool();

        euint32 reserve0Multiplier = FHE.select(randomBool0, upperBound, lowerBound);
        euint32 reserve1Multiplier = FHE.select(randomBool1, lowerBound, upperBound);

        euint16 rngMultiplier = _RNG();

        euint64 reserve0Factor = FHE.mul(FHE.asEuint64(reserve0Multiplier), rngMultiplier);
        euint64 reserve1Factor = FHE.mul(FHE.asEuint64(reserve1Multiplier), rngMultiplier);

        euint128 _obfuscatedReserve0 = FHE.mul(FHE.asEuint128(reserve0), reserve0Factor);
        euint128 _obfuscatedReserve1 = FHE.mul(FHE.asEuint128(reserve1), reserve1Factor);
        [...]
    }
```

---

## Refund policy

---

## Adding Liquidity

---

## Testnet address

Deployed on Sepolia :

```
0xab14a66F5c7c8aAb5E5677a7FD2d421F60c8D50d
```
https://sepolia.etherscan.io/address/0xab14a66F5c7c8aAb5E5677a7FD2d421F60c8D50d#code

---

## Overview

- **What it is:** A minimal **time-based OTP** generator/checker fully on-chain with **encrypted state**.
- **Privacy:** All sensitive values (secret, OTP, validity result) are **FHE-encrypted** end-to-end. Only the caller can decrypt their own outputs.
- **Delegation:** An account can **allow another address** to generate/check TOTP **on its behalf** (one-shot or unlimited).

> **TOTP math (POC):**  
> Let `secret` be a random 32-bit encrypted value. For `timestamp`, define  
> `timestampKey = timestamp % 1_000_000` and `salt = lastByte(address) + 27`.  
> The (encrypted) OTP is:
>
> ```
> OTP = (secret * timestampKey + salt) % 10000  // 4 digits
> ```

---

## 🔐 How it Works (Flow)

### 1) Secret creation (on-chain, encrypted)
- `createSecret()` picks `FHE.randEuint32()` and stores it encrypted for `msg.sender`.
- A per-address **salt** ensures the code is never all-zero due to multiplication.

### 2) Code generation
- **Caller self-code:**  
  - `generateOtp()` → uses `block.timestamp`  
  - `generateOtp(uint256 timestamp)` → uses a provided timestamp  
  - Emits `OneTimePassword(user, euint64 password, timestamp)` and stores `lastOtp`.
- **Delegated code:**  
  - `allow(address)` → single-use allowance  
  - `allow(address,uint32)` → N or `uint32.max` (infinite) uses  
  - `generateOtpFrom(address from)` / `generateOtpFrom(address from, uint256 ts)` for the **allowed** address.

### 3) Verification (encrypted input)
- **Self check:**  
  - `checkOtp(euint64 password, uint256 ts) returns (ebool)`  
  - or `checkOtp(bytes32 encryptedPassword, uint256 ts, bytes inputProof)` (via FHEVM gateway)  
  - Emits `OTPCheck(user, ebool isValid, ts)` and stores `lastCheck`.
- **Delegated check:**  
  - `checkOtpFrom(euint64 pw, address from, uint256 ts) returns (ebool)`  
  - or `checkOtpFrom(bytes32 pw, address from, uint256 ts, bytes proof)`  
  - Emits `ExternalOTPCheck(from, requestSender, ebool isValid, ts)` and stores `lastCheckFrom[from][requestSender]`.

**No individual secrets or codes are revealed in clear on-chain.**

---

## 🔹 Contract at a Glance

**File:** `contracts/timeBasedOtp.sol`  
**Contract name:** `TOTP`

### Events
- `event OneTimePassword(address user, euint64 password, uint256 timestamp);`
- `event OTPCheck(address user, ebool isValid, uint256 timestamp);`
- `event ExternalOTPCheck(address user, address requestSender, ebool isValid, uint256 timestamp);`

### User actions
- `createSecret()` — (Re)generate your encrypted secret.
- `generateOtp()` / `generateOtp(uint256 ts)` — Generate your code.
- `checkOtp(euint64 pw, uint256 ts) returns (ebool)` — Check a clear-encrypted param.
- `checkOtp(bytes32 pw, uint256 ts, bytes proof)` — Check an **externally encrypted** param.
- `allow(address target)` — 1-shot delegation.
- `allow(address target, uint32 allowance)` — N or `uint32.max` (infinite) delegation.
- `generateOtpFrom(address from)` / `generateOtpFrom(address from, uint256 ts)` — Generate on someone’s behalf (needs allowance).
- `checkOtpFrom(euint64 pw, address from, uint256 ts) returns (ebool)` — Check a delegated code.
- `checkOtpFrom(bytes32 pw, address from, uint256 ts, bytes proof)` — Same with external encryption.

### Read helpers
- `getSecret() view returns (euint32)` — Your **encrypted** secret.
- `getLastOtp() view returns (euint64)` — Your last **encrypted** code.
- `getLastOtpCheck() view returns (ebool)` — Your last encrypted validity result.
- `getLastOtpCheckFrom(address from) view returns (ebool)` — Encrypted validity of last delegated check.
- `getLastOtpFrom(address from) view returns (euint64)` — Last **encrypted** code generated on `from`’s behalf.
- `getAllowance(address target) view returns (uint32)` — Remaining generation allowance for `target`.

---

## 🧪 Tests

Covered:
- Deployment
- Secret creation & retrieval (decrypt locally)
- On-chain generation + range assertions (0–9999)
- Off-chain generation → encrypt → on-chain check (true)
- Single-use allowance flow
- Infinite allowance flow (`uint32.max`)
- Delegated generation + external encrypted check

Run:
```bash
npx hardhat test
```

---

## 🔧 Hardhat Tasks

(creates/reads `TOTP.json` in repo root)

`TOTP.json` example:
```json
{
  "TOTP_CONTRACT_ADDRESS": "0x....",
  "TOTP_SECRET": "123456789" 
}
```

### Deploy & setup
```bash
# 1) Deploy on Sepolia (configure your network in hardhat.config)
npx hardhat task:deploy_totp --network sepolia

# 2) Create encrypted secret on-chain, decrypt locally, store in TOTP.json
npx hardhat task:create_totp_secret --network sepolia
```

### Local generation (off-chain)
```bash
npx hardhat task:generate_code_locally --network sepolia
# Prints:
# Generated TOTP code : <code>
# Associated timestamp : <timestamp>
```

### Check your own code (encrypted param)
```bash
npx hardhat task:check_code --code <code> --timestamp <timestamp> --network sepolia
# Prints encrypted result then decrypted boolean
```

### Delegate usage
```bash
# Give N uses to <addr> (use 4294967295 for infinite)
npx hardhat task:allow_address --address <addr> --allowance <N> --network sepolia

# See remaining allowance
npx hardhat task:get_allowance --address <addr> --network sepolia

# From <addr>, generate on your behalf (needs allowance)
npx hardhat task:generate_code_from --address <yourAddr> --network sepolia
# -> prints encrypted OTP + decrypted OTP + timestamp

# From <addr>, check on your behalf (needs allowance)
npx hardhat task:check_code_from --address <yourAddr> --code <code> --timestamp <ts> --network sepolia
```

---


## 📜 License

- Original contributions in this repo (including `TOTP` smart contract, tests, and tasks) are under the **BSD 3-Clause Clear License**.
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
