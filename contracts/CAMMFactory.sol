// SPDX-License-Identifier: BSD-3-Clause-Clear

pragma solidity ^0.8.27;

import "./CAMMPair.sol";

/**
 * @title CAMMFactory
 * @dev Factory contract used to create pairs on CAMM.
 * User can interact with this factory to create a confidential token pair.
 * This contract keeps track of every pair created.
 * Inspired by UniswapV2 : https://docs.uniswap.org/contracts/v2/overview
 */

contract CAMMFactory {
    // This mapping keeps track of created pairs: token address A => token address B => pair address
    mapping(address => mapping(address => address)) public getPair;

    // Keeps track of every pair address.
    address[] public allPairs;

    /**
     * @dev Used to broadcast a pair creation event.
     * @param token0         token0 address.
     * @param token1         token1 address.
     * @param pair           created pair address.
     * @param allPairsLength number of pair created created so far (length of the allPairs array).
     */
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength);

    /**
     * @dev Returns the total number of pairs created by the factory.
     * @return The number of pairs created.
     */
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /**
     * @dev Creates a new CAMMPair for the given token addresses.
     * Both tokenA and tokenB should be Confidential Token contracts.
     * @param tokenA The address of the first token in the pair.
     * @param tokenB The address of the second token in the pair.
     * @return pair The address of the newly created pair.
     */
    function createPair(address tokenA, address tokenB, address priceScanner) external returns (address pair) {
        // Ensure that the tokens are not the same
        require(tokenA != tokenB);

        // Determine the order of the tokens based on their address values
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

        // Ensure that neither token address is zero
        require(token0 != address(0));

        // Ensure that the pair does not already exist
        require(getPair[token0][token1] == address(0));

        // Create a unique salt for deterministic deployment of the pair contract
        bytes32 _salt = keccak256(abi.encodePacked(token0, token1));

        // Deploy the new CAMMPair contract
        pair = address(new CAMMPair{salt: _salt}(priceScanner));

        // Ensure that the pair was successfully created
        require(pair != address(0));

        // Initialize the pair contract with the token addresses
        CAMMPair(pair).initialize(token0, token1);

        // Store the pair address in the getPair mapping for both directions
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;

        // Add the pair address to the list of all pairs
        allPairs.push(pair);

        // Emit the PairCreated event with the details of the newly created pair
        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
