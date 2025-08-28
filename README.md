# CAMM - Confidential Automated Market Maker (FHEVM)

**A UniswapV2-style AMM where amounts, balances, and reserves are encrypted end-to-end** using **Zama’s Fully Homomorphic Encryption (FHEVM)**.  
Liquidity, swaps, and even obfuscated reserves are computed on encrypted ciphertexts; only authorized parties can decrypt specific outputs.

> ⚠️ **Proof-of-concept only** - not production-ready.

## What’s inside

- **CAMMFactory**: creates confidential token pairs deterministically.
- **CAMMPair**: the core AMM logic (add/remove liquidity, swaps, refunds), all with encrypted math.
- **ConfidentialToken** (example): OpenZeppelin ConfidentialFungibleToken with an initial encrypted mint for testing.
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
