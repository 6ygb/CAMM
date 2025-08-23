// SPDX-License-Identifier: BSD-3-Clause-Clear

pragma solidity ^0.8.27;

import "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import "@openzeppelin/confidential-contracts/token/ConfidentialFungibleToken.sol";

contract ConfidentialToken is SepoliaConfig, ConfidentialFungibleToken {
    constructor(string memory name_, string memory symbol_) ConfidentialFungibleToken(name_, symbol_, "") {
        uint64 scalingFactor = uint64(10) ** decimals();
        euint64 mintAmount = FHE.asEuint64(100_000*scalingFactor);
        _mint(msg.sender, mintAmount);
    }
}
