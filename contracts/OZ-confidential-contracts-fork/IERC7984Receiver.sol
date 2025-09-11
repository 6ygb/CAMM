// SPDX-License-Identifier: MIT
// Fork of un-commited "@openzeppelin/confidential-contracts update to fhevm 0.8.0
// See : https://github.com/OpenZeppelin/openzeppelin-confidential-contracts/pull/202

pragma solidity ^0.8.27;

import {ebool, euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @dev Interface for contracts that can receive ERC7984 transfers with a callback.
interface IERC7984Receiver {
    /**
     * @dev Called upon receiving a confidential token transfer. Returns an encrypted boolean indicating success
     * of the callback. If false is returned, the transfer must be reversed.
     */
    function onConfidentialTransferReceived(
        address operator,
        address from,
        euint64 amount,
        bytes calldata data
    ) external returns (ebool);
}
