// SPDX-License-Identifier: BSD-3-Clause-Clear

pragma solidity ^0.8.27;

import "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import "@openzeppelin/confidential-contracts/token/ConfidentialFungibleToken.sol";

/**
 * @title CAMMPair
 * @dev Confidential Automated Market Maker Pair.
 *      This contract implements liquidity provision, token swapping, and batch settlement using confidential computations.
 *      Inspired by UniswapV2 : https://docs.uniswap.org/contracts/v2/overview
 */
contract CAMMPair is ConfidentialFungibleToken, SepoliaConfig {
    // Structs
    struct addLiqDecBundleStruct {
        euint64 _sentAmount0;
        euint64 _sentAmount1;
        euint128 _partialupperPart0;
        euint128 _partialupperPart1;
        address _user;
    }
    struct removeLiqDecBundleStruct {
        euint64 _lpSent;
        euint128 _upperPart0;
        euint128 _upperPart1;
        address _from;
        address _to;
    }
    struct obfuscatedReservesStruct {
        euint128 obfuscatedReserve0;
        euint128 obfuscatedReserve1;
    }
    struct swapDecBundleStruct {
        euint128 divUpperPart0;
        euint128 divUpperPart1;
        euint64 amount0In;
        euint64 amount1In;
        address from;
        address to;
    }
    struct swapOutputStruct {
        euint64 amount0Out;
        euint64 amount1Out;
    }
    struct pendingDecryptionStruct {
        uint256 currentRequestID;
        bool isPendingDecryption;
        uint256 decryptionTimestamp;
    }
    struct standardRefundStruct {
        euint64 amount0;
        euint64 amount1;
    }
    struct liquidityRemovalRefundStruct {
        euint64 lpAmount;
    }

    // Mappings
    mapping(uint256 requestID => addLiqDecBundleStruct) private addLiqDecBundle;
    mapping(uint256 requestID => removeLiqDecBundleStruct) private removeLiqDecBundle;
    mapping(uint256 requestID => swapDecBundleStruct) private swapDecBundle;
    mapping(uint256 requestID => swapOutputStruct) private swapOutput;
    mapping(address from => mapping(uint256 requestID => standardRefundStruct)) public standardRefund;
    mapping(address from => mapping(uint256 requestID => liquidityRemovalRefundStruct)) public liquidityRemovalRefund;

    // Events
    event liquidityMinted(uint256 blockNumber, address user);
    event liquidityBurnt(uint256 blockNumber, address user);
    event decryptionRequested(address from, uint256 blockNumber, uint256 requestID);
    event Swap(address from, euint64 amount0In, euint64 amount1In, euint64 amount0Out, euint64 amount1Out, address to);
    event Refund(address from, uint256 blockNumber, uint256 requestID);
    event discloseReservesInfo(
        uint256 blockNumber,
        address user,
        euint128 obfuscatedReserve0,
        euint128 obfuscatedReserve1
    );

    // Errors
    error Expired();
    error PendingDecryption(uint256 until);
    error Forbidden();
    error WrongRequestID();
    error DecryptionBlocked();
    error NoRefund();

    // Variables
    // Predefined constants and initial values
    euint64 private immutable ZERO;
    uint64 public immutable scalingFactor;
    uint64 public immutable MINIMIMUM_LIQUIDITY;
    uint256 private constant MAX_DECRYPTION_TIME = 5 minutes;
    bool private min_liq_locked = false;

    // Addresses of the factory and associated tokens
    address public factory;
    address public cammPriceScanner;
    address public token0Address;
    address public token1Address;
    IConfidentialFungibleToken private token0;
    IConfidentialFungibleToken private token1;

    // Reserve values for token0 and token1
    euint64 private reserve0;
    euint64 private reserve1;

    obfuscatedReservesStruct public obfuscatedReserves;
    pendingDecryptionStruct private pendingDecryption;

    /**
     * @dev Constructor for the pair contract.
     * Sets the factory address and initializes the token.
     */
    constructor(address _cammPriceScanner) ConfidentialFungibleToken("Liquidity Token", "PAIR", "") {
        factory = msg.sender;
        cammPriceScanner = _cammPriceScanner;

        ZERO = FHE.asEuint64(0);

        scalingFactor = uint64(10) ** uint64(decimals());
        MINIMIMUM_LIQUIDITY = 100 * scalingFactor;

        reserve0 = ZERO;
        reserve1 = ZERO;

        FHE.allowThis(reserve0);
        FHE.allowThis(reserve1);
    }

    /**
     * @dev Modifier to ensure that the action occurs before the deadline epoch.
     * @param deadlineTimestamp The deadline timestamp.
     */
    modifier ensure(uint256 deadlineTimestamp) {
        if (block.timestamp >= deadlineTimestamp) revert Expired();
        _;
    }

    /**
     * @dev Modifier to ensure that pool is not in the middle of a decryption process.
     */
    modifier decryptionAvailable() {
        // Here we make sure there are no pending decryption.
        // In some cases the decryption request is sent but is never fulfilled.
        // In such cases we make sure the last decryption request was more than 5 minutes ago, to not block indefinitly the pair.
        if (
            pendingDecryption.isPendingDecryption &&
            block.timestamp < pendingDecryption.decryptionTimestamp + MAX_DECRYPTION_TIME
        ) {
            revert PendingDecryption(pendingDecryption.decryptionTimestamp + MAX_DECRYPTION_TIME);
        }
        _;
    }

    /**
     * @dev Initializes the pair contract with the addresses of the two tokens.
     *      This function can only be called once by the factory contract.
     * @param _token0 Address of the first token in the pair.
     * @param _token1 Address of the second token in the pair.
     */
    function initialize(address _token0, address _token1) external {
        if (msg.sender != factory) revert Forbidden();
        token0 = IConfidentialFungibleToken(_token0);
        token1 = IConfidentialFungibleToken(_token1);
        token0Address = _token0;
        token1Address = _token1;
    }

    /**
     * @dev Generates a random number non zero number used during decryption process.
     */
    function _RNG() internal returns (euint16) {
        euint16 randomSeed = FHE.randEuint16();
        ebool tooSmall = FHE.lt(randomSeed, 3);
        euint16 toAdd = FHE.select(tooSmall, FHE.asEuint16(3), FHE.asEuint16(0));
        euint16 rngNumber = FHE.add(randomSeed, toAdd);
        return rngNumber;
    }

    /**
     * @dev Generates a random number non zero bounded number used price range computation.
     */
    function _RNG_Bounded(uint16 max, uint16 toAdd) internal returns (euint16) {
        euint16 randomSeed = FHE.randEuint16(max);
        euint16 rngNumber = FHE.add(randomSeed, toAdd);
        return rngNumber;
    }

    /**
     * @dev Updates the reserve amounts for token0 and token1.
     * @param newReserve0 The new reserve amount for token0.
     * @param newReserve1 The new reserve amount for token1.
     */
    function _updateReserves(euint64 newReserve0, euint64 newReserve1) internal {
        reserve0 = newReserve0;
        reserve1 = newReserve1;

        FHE.allowThis(reserve0);
        FHE.allowThis(reserve1);
        _updateObfuscatedReserves();
    }

    /**
     * @dev Recomputes and stores obfuscated reserves using randomized multipliers,
     *      then updates ACL so this contract and the price scanner can read them.
     *      This helps publish reserve-like values without revealing exact reserves.
     *      Computed price from obfuscated reserve is +- 7% close to the real price.
     */
    function _updateObfuscatedReserves() internal {
        euint16 percentage = _RNG_Bounded(256, 70);

        //Never overflows because max rng bounded is 326 and max euint16 is 65535
        euint16 scaledPercentage = FHE.mul(percentage, 100);
        euint32 upperBound = FHE.add(FHE.asEuint32(scaledPercentage), uint32(scalingFactor));
        euint32 lowerBound = FHE.sub(uint32(scalingFactor), FHE.asEuint32(scaledPercentage));

        ebool randomBool0 = FHE.randEbool();
        ebool randomBool1 = FHE.randEbool();

        euint32 reserve0Multiplier = FHE.select(randomBool0, upperBound, lowerBound);
        euint32 reserve1Multiplier = FHE.select(randomBool1, lowerBound, upperBound);

        euint16 rngMultiplier = _RNG();

        //need euint64 here because max value for upperBound * max value for rngmultiplier > max euint32
        euint64 reserve0Factor = FHE.mul(FHE.asEuint64(reserve0Multiplier), rngMultiplier);
        euint64 reserve1Factor = FHE.mul(FHE.asEuint64(reserve1Multiplier), rngMultiplier);

        euint128 _obfuscatedReserve0 = FHE.mul(FHE.asEuint128(reserve0), reserve0Factor);
        euint128 _obfuscatedReserve1 = FHE.mul(FHE.asEuint128(reserve1), reserve1Factor);

        obfuscatedReserves.obfuscatedReserve0 = _obfuscatedReserve0;
        obfuscatedReserves.obfuscatedReserve1 = _obfuscatedReserve1;

        FHE.allowThis(obfuscatedReserves.obfuscatedReserve0);
        FHE.allowThis(obfuscatedReserves.obfuscatedReserve1);

        //Allow CAMM price scanner address
        FHE.allow(obfuscatedReserves.obfuscatedReserve0, cammPriceScanner);
        FHE.allow(obfuscatedReserves.obfuscatedReserve1, cammPriceScanner);
    }

    /**
     * @dev Grants temporary read access to the caller for the obfuscated reserves
     *      and emits an event carrying those encrypted values.
     *      Useful for off-chain consumers to pick up fresh obfuscated data.
     */
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

    /**
     * @dev Transfers tokens from a user to the pool and updates reserves.
     * @param from The address from which tokens are transferred.
     * @param amount0In The amount of token0 to transfer.
     * @param amount1In The amount of token1 to transfer.
     * @param updateReserves Bool flag to incorporate or not the transfered amount in the pool.
     * @return sentAmount0 The actual amount of token0 received by the pool.
     * @return sentAmount1 The actual amount of token1 received by the pool.
     */
    function _transferTokensToPool(
        address from,
        euint64 amount0In,
        euint64 amount1In,
        bool updateReserves
    ) internal returns (euint64 sentAmount0, euint64 sentAmount1) {
        euint64 balance0Before = token0.confidentialBalanceOf(address(this));
        euint64 balance1Before = token1.confidentialBalanceOf(address(this));

        token0.confidentialTransferFrom(from, address(this), amount0In); // 293_000 HCU
        token1.confidentialTransferFrom(from, address(this), amount1In); // 293_000 HCU

        euint64 balance0After = token0.confidentialBalanceOf(address(this));
        euint64 balance1After = token1.confidentialBalanceOf(address(this));

        sentAmount0 = FHE.sub(balance0After, balance0Before); // 129_000 HCU
        sentAmount1 = FHE.sub(balance1After, balance1Before); // 129_000 HCU

        if (updateReserves) {
            _updateReserves(FHE.add(reserve0, sentAmount0), FHE.add(reserve1, sentAmount1));
        }
    }

    /**
     * @dev Transfers tokens from the pool to a user.
     * @param to The recipient address.
     * @param amount0Out The amount of token0 to send.
     * @param amount1Out The amount of token1 to send.
     * @param updateReserves Flag indicating whether to update the reserves after transfer.
     */
    function _transferTokensFromPool(address to, euint64 amount0Out, euint64 amount1Out, bool updateReserves) internal {
        euint64 balance0Before = token0.confidentialBalanceOf(address(this));
        euint64 balance1Before = token1.confidentialBalanceOf(address(this));

        FHE.allowTransient(amount0Out, address(token0));
        FHE.allowTransient(amount1Out, address(token1));

        token0.confidentialTransfer(to, amount0Out);
        token1.confidentialTransfer(to, amount1Out);

        euint64 balance0After = token0.confidentialBalanceOf(address(this));
        euint64 balance1After = token1.confidentialBalanceOf(address(this));

        euint64 sentAmount0 = FHE.sub(balance0Before, balance0After);
        euint64 sentAmount1 = FHE.sub(balance1Before, balance1After);

        if (updateReserves) {
            _updateReserves(FHE.sub(reserve0, sentAmount0), FHE.sub(reserve1, sentAmount1));
        }
    }

    /**
     * @dev Transfers liquidity tokens from a user to the pool.
     * @param from The address from which liquidity tokens are transferred.
     * @param LPAmount The amount of liquidity tokens to transfer.
     * @return sentAmount The actual amount of liquidity tokens transferred.
     */
    function _transferLPToPool(address from, euint64 LPAmount) internal returns (euint64 sentAmount) {
        euint64 balanceBefore = confidentialBalanceOf(address(this));
        confidentialTransferFrom(from, address(this), LPAmount);
        euint64 balanceAfter = confidentialBalanceOf(address(this));

        sentAmount = FHE.sub(balanceAfter, balanceBefore);
    }

    /**
     * @dev Mints liquidity tokens for the user.
     *      If this is the first liquidity addition, enforces the minimum liquidity constraint.
     * @param liquidityAmount The amount of liquidity tokens to mint.
     * @param user The address to receive the minted liquidity tokens.
     */
    function _mintLP(euint64 liquidityAmount, address user) internal {
        if (!min_liq_locked) {
            euint64 mintAmount = FHE.sub(liquidityAmount, MINIMIMUM_LIQUIDITY);
            _mint(user, mintAmount);
            min_liq_locked = true;
        } else {
            _mint(user, liquidityAmount);
        }

        emit liquidityMinted(block.number, user);
    }

    /**
     * @dev Handles the initial liquidity mint ensuring minimum liquidity constraints.
     *      Refunds tokens to the user if the provided amounts are below the minimum liquidity.
     * @param to The address to receive liquidity tokens.
     * @param amount0 The amount of token0 provided.
     * @param amount1 The amount of token1 provided.
     */
    function _firstMint(address to, euint64 amount0, euint64 amount1) internal {
        euint64 liquidityAmount;
        liquidityAmount = FHE.add(FHE.shr(amount0, 1), FHE.shr(amount1, 1));

        ebool isBelowMinimum = FHE.lt(liquidityAmount, MINIMIMUM_LIQUIDITY);
        liquidityAmount = FHE.select(isBelowMinimum, ZERO, liquidityAmount);
        euint64 amount0Back = FHE.select(isBelowMinimum, amount0, ZERO);
        euint64 amount1Back = FHE.select(isBelowMinimum, amount1, ZERO);

        FHE.allowTransient(amount0Back, address(token0));
        FHE.allowTransient(amount1Back, address(token1));

        token0.confidentialTransfer(msg.sender, amount0Back); // refund first liquidity if it is below the minimal amount
        token1.confidentialTransfer(msg.sender, amount1Back); // refund first liquidity if it is below the minimal amount

        _mintLP(liquidityAmount, to);
        _updateObfuscatedReserves();
    }

    /**
     * @dev External function that manage liquidity adding.
     *      This function is called by another smart contract.
     *      The important logic is in _addLiquidity().
     * @param amount0 The amount of token0 added to the liquidity.
     * @param amount1 The amount of token1 added to the liquidity.
     * @param deadline Timestamp by which the liquidity adding must be completed.
     */
    function addLiquidity(euint64 amount0, euint64 amount1, uint256 deadline) external {
        //Allow tokens to use the related amount variable
        FHE.allowTransient(amount0, address(token0));
        FHE.allowTransient(amount1, address(token1));

        _addLiquidity(amount0, amount1, msg.sender, deadline);
    }

    /**
     * @dev External function that manage liquidity adding.
     *      This function is called by a user (using a dApp).
     *      The important logic is in _addLiquidity().
     * @param encryptedAmount0 The encrypted amount of token0 added to the liquidity.
     * @param encryptedAmount1 The encrypted amount of token1 added to the liquidity.
     * @param deadline Timestamp by which the liquidity adding must be completed.
     * @param inputProof Proof used to verify the validity of encrypted inputs.
     */
    function addLiquidity(
        externalEuint64 encryptedAmount0,
        externalEuint64 encryptedAmount1,
        uint256 deadline,
        bytes calldata inputProof
    ) external {
        euint64 amount0 = FHE.fromExternal(encryptedAmount0, inputProof);
        euint64 amount1 = FHE.fromExternal(encryptedAmount1, inputProof);

        //Allow tokens to use the related amount variable
        FHE.allowTransient(amount0, address(token0));
        FHE.allowTransient(amount1, address(token1));

        _addLiquidity(amount0, amount1, msg.sender, deadline);
    }

    /**
     * @dev Internal function that manage the computing of necessary variables for adding liquidity.
     * @param amount0 The amount of token0 added to the liquidity.
     * @param amount1 The amount of token1 added to the liquidity.
     * @param from The address that adds liquidity.
     * @param deadline Timestamp by which the liquidity computinh must be completed.
     */
    function _addLiquidity(
        euint64 amount0,
        euint64 amount1,
        address from,
        uint256 deadline
    ) internal ensure(deadline) decryptionAvailable {
        if (!min_liq_locked) {
            //sending the tokens and adding them to pool
            (euint64 sentAmount0, euint64 sentAmount1) = _transferTokensToPool(from, amount0, amount1, true);
            _firstMint(from, sentAmount0, sentAmount1);
        } else {
            //sending the tokens without adding them to pool
            (euint64 sentAmount0, euint64 sentAmount1) = _transferTokensToPool(from, amount0, amount1, false); // 844_000 HCU

            euint16 rng0 = _RNG(); // 184_000 HCU
            euint16 rng1 = _RNG(); // 184_000 HCU

            euint128 divLowerPart0 = FHE.mul(FHE.asEuint128(reserve0), FHE.asEuint128(rng0)); // 646_000 HCU
            euint128 divLowerPart1 = FHE.mul(FHE.asEuint128(reserve1), FHE.asEuint128(rng1)); // 646_000 HCU

            euint64 currentLPSupply = confidentialTotalSupply();
            euint128 partialUpperPart0 = FHE.mul(FHE.asEuint128(currentLPSupply), FHE.asEuint128(rng0)); // 646_000 HCU
            euint128 partialUpperPart1 = FHE.mul(FHE.asEuint128(currentLPSupply), FHE.asEuint128(rng1)); // 646_000 HCU

            bytes32[] memory cts = new bytes32[](4);
            cts[0] = FHE.toBytes32(divLowerPart0);
            cts[1] = FHE.toBytes32(divLowerPart1);
            cts[2] = FHE.toBytes32(obfuscatedReserves.obfuscatedReserve0);
            cts[3] = FHE.toBytes32(obfuscatedReserves.obfuscatedReserve1);

            uint256 requestID = FHE.requestDecryption(cts, this.addLiquidityCallback.selector);

            addLiqDecBundle[requestID]._sentAmount0 = sentAmount0;
            addLiqDecBundle[requestID]._sentAmount1 = sentAmount1;
            addLiqDecBundle[requestID]._partialupperPart0 = partialUpperPart0;
            addLiqDecBundle[requestID]._partialupperPart1 = partialUpperPart1;
            addLiqDecBundle[requestID]._user = from;

            FHE.allowThis(addLiqDecBundle[requestID]._sentAmount0);
            FHE.allowThis(addLiqDecBundle[requestID]._sentAmount1);
            FHE.allowThis(addLiqDecBundle[requestID]._partialupperPart0);
            FHE.allowThis(addLiqDecBundle[requestID]._partialupperPart1);

            pendingDecryption.currentRequestID = requestID;
            pendingDecryption.decryptionTimestamp = block.timestamp;
            pendingDecryption.isPendingDecryption = true;

            standardRefund[from][requestID].amount0 = sentAmount0;
            standardRefund[from][requestID].amount1 = sentAmount1;

            FHE.allowThis(standardRefund[from][requestID].amount0);
            FHE.allowThis(standardRefund[from][requestID].amount1);
            FHE.allow(standardRefund[from][requestID].amount0, from);
            FHE.allow(standardRefund[from][requestID].amount1, from);

            emit decryptionRequested(from, block.number, requestID);
        }
    }

    /**
     * @dev Callback for an add-liquidity decryption request.
     *      Verifies the request, reconstructs pricing targets from obfuscated reserves,
     *      computes the LP mint amount, refunds any excess tokens, mints LP, and updates reserves.
     * @param requestID Gateway request identifier expected to match the pending one.
     * @param divLowerPart0 Decrypted divisor component for token0 side.
     * @param divLowerPart1 Decrypted divisor component for token1 side.
     * @param _obfuscatedReserve0 Decrypted obfuscated reserve for token0 (for price).
     * @param _obfuscatedReserve1 Decrypted obfuscated reserve for token1 (for price).
     * @param signatures Gateway signatures attesting the decryption result.
     */
    function addLiquidityCallback(
        uint256 requestID,
        uint128 divLowerPart0,
        uint128 divLowerPart1,
        uint128 _obfuscatedReserve0,
        uint128 _obfuscatedReserve1,
        bytes[] memory signatures
    ) external {
        if (pendingDecryption.currentRequestID != requestID) revert WrongRequestID();
        FHE.checkSignatures(requestID, signatures);

        uint128 priceToken0 = _obfuscatedReserve0 / (_obfuscatedReserve1 / scalingFactor);
        uint128 priceToken1 = _obfuscatedReserve1 / (_obfuscatedReserve0 / scalingFactor);

        euint64 sentAmount0 = addLiqDecBundle[requestID]._sentAmount0;
        euint64 sentAmount1 = addLiqDecBundle[requestID]._sentAmount1;
        euint128 partialUpperPart0 = addLiqDecBundle[requestID]._partialupperPart0;
        euint128 partialUpperPart1 = addLiqDecBundle[requestID]._partialupperPart1;
        address user = addLiqDecBundle[requestID]._user;

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

        _transferTokensFromPool(user, refundAmount0, refundAmount1, false);
        _mintLP(mintAmount, user);
        _updateReserves(FHE.add(reserve0, amount0), FHE.add(reserve1, amount1));

        delete pendingDecryption;
        delete standardRefund[user][requestID];
    }

    /**
     * @dev Internal function that manages the liquidity removal process.
     * @param lpAmount Amount of lp token to remove.
     * @param from The address that removes liquidity.
     * @param to The address that will receive the tokens after lp burn.
     * @param deadline Timestamp by which the liquidity removal must be completed.
     */
    function _removeLiquidity(
        euint64 lpAmount,
        address from,
        address to,
        uint256 deadline
    ) internal ensure(deadline) decryptionAvailable {
        euint64 sentLP = _transferLPToPool(from, lpAmount);

        euint16 rng0 = _RNG(); // 184_000 HCU
        euint16 rng1 = _RNG(); // 184_000 HCU

        euint64 currentLPSupply = confidentialTotalSupply();

        euint128 divUpperPart0 = FHE.mul(
            FHE.mul(FHE.asEuint128(sentLP), FHE.asEuint128(reserve0)),
            FHE.asEuint128(rng0)
        );
        euint128 divUpperPart1 = FHE.mul(
            FHE.mul(FHE.asEuint128(sentLP), FHE.asEuint128(reserve1)),
            FHE.asEuint128(rng1)
        );

        euint128 divLowerPart0 = FHE.mul(FHE.asEuint128(currentLPSupply), FHE.asEuint128(rng0));
        euint128 divLowerPart1 = FHE.mul(FHE.asEuint128(currentLPSupply), FHE.asEuint128(rng1));

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(divLowerPart0);
        cts[1] = FHE.toBytes32(divLowerPart1);

        uint256 requestID = FHE.requestDecryption(cts, this.removeLiquidityCallback.selector);

        removeLiqDecBundle[requestID]._lpSent = sentLP;
        removeLiqDecBundle[requestID]._upperPart0 = divUpperPart0;
        removeLiqDecBundle[requestID]._upperPart1 = divUpperPart1;
        removeLiqDecBundle[requestID]._from = from;
        removeLiqDecBundle[requestID]._to = to;

        FHE.allowThis(removeLiqDecBundle[requestID]._lpSent);
        FHE.allowThis(removeLiqDecBundle[requestID]._upperPart0);
        FHE.allowThis(removeLiqDecBundle[requestID]._upperPart1);

        pendingDecryption.currentRequestID = requestID;
        pendingDecryption.decryptionTimestamp = block.timestamp;
        pendingDecryption.isPendingDecryption = true;

        liquidityRemovalRefund[from][requestID].lpAmount = sentLP;

        FHE.allowThis(liquidityRemovalRefund[from][requestID].lpAmount);
        FHE.allow(liquidityRemovalRefund[from][requestID].lpAmount, from);

        emit decryptionRequested(from, block.number, requestID);
    }

    function removeLiquidityCallback(
        uint256 requestID,
        uint128 divLowerPart0,
        uint128 divLowerPart1,
        bytes[] memory signatures
    ) external {
        if (pendingDecryption.currentRequestID != requestID) revert WrongRequestID();
        FHE.checkSignatures(requestID, signatures);

        euint64 burnAmount = removeLiqDecBundle[requestID]._lpSent;
        euint128 divUpperPart0 = removeLiqDecBundle[requestID]._upperPart0;
        euint128 divUpperPart1 = removeLiqDecBundle[requestID]._upperPart1;
        address from = removeLiqDecBundle[requestID]._from;
        address to = removeLiqDecBundle[requestID]._to;

        euint64 amount0Out = FHE.asEuint64(FHE.div(divUpperPart0, divLowerPart0));
        euint64 amount1Out = FHE.asEuint64(FHE.div(divUpperPart1, divLowerPart1));

        _transferTokensFromPool(to, amount0Out, amount1Out, true);
        _burn(address(this), burnAmount);
        emit liquidityBurnt(block.number, from);

        delete pendingDecryption;
        delete liquidityRemovalRefund[from][requestID];
    }

    /**
     * @dev Removes liquidity from the pool.
     *      Allows a liquidity provider to change its liquidity tokens to token0 and token1.
     *      This function is called by another contract.
     * @param lpAmount Amount of lp token to remove.
     * @param to Address to receive the tokens.
     * @param deadline timestamp by which the liquidity removal must be completed.
     */
    function removeLiquidity(euint64 lpAmount, address to, uint256 deadline) external {
        _removeLiquidity(lpAmount, msg.sender, to, deadline);
    }

    /**
     * @dev Removes liquidity from the pool.
     *      Allows a liquidity provider to change its liquidity tokens to token0 and token1.
     *      This function is called off-chain (from a dApp for example).
     * @param encryptedLPAmount Amount of lp token to remove.
     * @param to Address to receive the tokens.
     * @param deadline timestamp by which the liquidity removal must be completed.
     * * @param inputProof Proof used to verify the validity of encrypted inputs.
     */
    function removeLiquidity(
        externalEuint64 encryptedLPAmount,
        address to,
        uint256 deadline,
        bytes calldata inputProof
    ) external {
        euint64 lpAmount = FHE.fromExternal(encryptedLPAmount, inputProof);

        _removeLiquidity(lpAmount, msg.sender, to, deadline);
    }

    /**
     * @dev Executes a swap operation within the pool.
     *      Allows users to exchange `token0` for `token1` or vice versa.
     *      Updates pending swaps for the current trading epoch and adjusts reserves.
     *      Either amount0In or amount1In is null for a classic swap.
     *      This function is called by another contract.
     * @param amount0In Amount of `token0` being swapped into the pool.
     * @param amount1In Amount of `token1` being swapped into the pool.
     * @param to Address to receive the swapped tokens.
     * @param deadline timestamp by which the swap must be completed.
     */
    function swapTokens(euint64 amount0In, euint64 amount1In, address to, uint256 deadline) external {
        //Allow tokens to use the amounts
        FHE.allowTransient(amount0In, address(token0));
        FHE.allowTransient(amount1In, address(token1));

        _swapTokens(amount0In, amount1In, msg.sender, to, deadline);
    }

    /**
     * @dev Executes a swap operation using encrypted token inputs.
     *      Similar to the standard `swapTokens`, but uses encrypted inputs for the tokens being swapped.
     *      Decrypts the inputs using the provided proof.
     *      This function is called off-chain (from a dApp for example).
     * @param encryptedAmount0In Encrypted amount of `token0` being swapped into the pool.
     * @param encryptedAmount1In Encrypted amount of `token1` being swapped into the pool.
     * @param to Address to receive the swapped tokens.
     * @param deadline timestamp by which the swap must be completed.
     * @param inputProof Proof used to verify the validity of encrypted inputs.
     */
    function swapTokens(
        externalEuint64 encryptedAmount0In,
        externalEuint64 encryptedAmount1In,
        address to,
        uint256 deadline,
        bytes calldata inputProof
    ) external {
        euint64 amount0In = FHE.fromExternal(encryptedAmount0In, inputProof);
        euint64 amount1In = FHE.fromExternal(encryptedAmount1In, inputProof);

        //Allow tokens to use the amounts
        FHE.allowTransient(amount0In, address(token0));
        FHE.allowTransient(amount1In, address(token1));

        _swapTokens(amount0In, amount1In, msg.sender, to, deadline);
    }

    /**
     * @dev Executes a swap operation within the pool.
     *      Internal function
     *      Allows users to exchange `token0` for `token1` or vice versa.
     *      Updates pending swaps for the current trading epoch and adjusts reserves.
     *      Either amount0In or amount1In is null for a classic swap.
     *      This function is only called by this contract.
     * @param amount0In Amount of `token0` being swapped into the pool.
     * @param amount1In Amount of `token1` being swapped into the pool.
     * @param to Address to receive the swapped tokens.
     * @param from Address from which tokens are taken to be swapped.
     * @param deadline timestamp by which the swap must be completed.
     */
    function _swapTokens(
        euint64 amount0In,
        euint64 amount1In,
        address from,
        address to,
        uint256 deadline
    ) internal ensure(deadline) decryptionAvailable {
        (euint64 sent0, euint64 sent1) = _transferTokensToPool(from, amount0In, amount1In, true);
        //uint16 max                        65,535
        //uint64 max                        18,446,744,073,709,551,615
        //uint64 max^2                      10,973,678,151,985,686,339,682,919,724,057,600
        //uint64 max^2 * 16384 + 3          179,792,742,842,133,484,989,364,956,758,959,718,403
        //uint128 max                       340,282,366,920,938,463,463,374,607,431,768,211,455

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

        swapDecBundle[requestID].divUpperPart0 = divUpperPart0;
        swapDecBundle[requestID].divUpperPart1 = divUpperPart1;
        swapDecBundle[requestID].amount0In = amount0In;
        swapDecBundle[requestID].amount1In = amount1In;
        swapDecBundle[requestID].from = from;
        swapDecBundle[requestID].to = to;

        FHE.allowThis(swapDecBundle[requestID].divUpperPart0);
        FHE.allowThis(swapDecBundle[requestID].divUpperPart1);
        FHE.allowThis(swapDecBundle[requestID].amount0In);
        FHE.allowThis(swapDecBundle[requestID].amount1In);

        pendingDecryption.currentRequestID = requestID;
        pendingDecryption.decryptionTimestamp = block.timestamp;
        pendingDecryption.isPendingDecryption = true;

        standardRefund[from][requestID].amount0 = sent0;
        standardRefund[from][requestID].amount1 = sent1;

        FHE.allowThis(standardRefund[from][requestID].amount0);
        FHE.allowThis(standardRefund[from][requestID].amount1);
        FHE.allow(standardRefund[from][requestID].amount0, from);
        FHE.allow(standardRefund[from][requestID].amount1, from);

        emit decryptionRequested(from, block.number, requestID);
    }

    /**
     * @dev Callback for a swap decryption request.
     *      Verifies the request, computes swap outputs from decrypted divisors,
     *      transfers tokens to the recipient, exposes I/O to the sender via ACL,
     *      emits the Swap event, and clears pending state/refund.
     * @param requestID Gateway request identifier expected to match the pending one.
     * @param _divLowerPart0 Decrypted divisor for token0 output calculation.
     * @param _divLowerPart1 Decrypted divisor for token1 output calculation.
     * @param signatures Gateway signatures attesting the decryption result.
     */
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

        // always fits, check overflow computation in _swapTokens() comments.
        euint64 amount0Out = FHE.asEuint64(FHE.div(_divUpperPart0, _divLowerPart0));
        euint64 amount1Out = FHE.asEuint64(FHE.div(_divUpperPart1, _divLowerPart1));

        FHE.allowThis(amount0Out);
        FHE.allowThis(amount1Out);
        _transferTokensFromPool(to, amount0Out, amount1Out, true);

        swapOutput[requestID].amount0Out = amount0Out;
        swapOutput[requestID].amount1Out = amount1Out;

        FHE.allow(swapDecBundle[requestID].amount0In, from);
        FHE.allow(swapDecBundle[requestID].amount1In, from);
        FHE.allow(swapOutput[requestID].amount0Out, from);
        FHE.allow(swapOutput[requestID].amount1Out, from);

        FHE.allowThis(swapDecBundle[requestID].amount0In);
        FHE.allowThis(swapDecBundle[requestID].amount1In);
        FHE.allowThis(swapOutput[requestID].amount0Out);
        FHE.allowThis(swapOutput[requestID].amount1Out);

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

    /**
     * @dev Requests a refund for a pending add-liquidity operation.
     *      Sends back the original token inputs (without altering reserves),
     *      cancels the pending decryption if it corresponds to this request,
     *      and clears stored refund data.
     * @param requestID Gateway request ID associated with the pending add-liquidity.
     */
    function requestLiquidityAddingRefund(uint256 requestID) public {
        if (
            !FHE.isInitialized(standardRefund[msg.sender][requestID].amount0) ||
            !FHE.isInitialized(standardRefund[msg.sender][requestID].amount1)
        ) revert NoRefund();

        euint64 refundAmount0 = standardRefund[msg.sender][requestID].amount0;
        euint64 refundAmount1 = standardRefund[msg.sender][requestID].amount1;

        // No need to update reserves as they are not updated when liquidity is sent
        _transferTokensFromPool(msg.sender, refundAmount0, refundAmount1, false);

        // If refund is sent prior to decryption we need to block the decryption
        if (requestID == pendingDecryption.currentRequestID) {
            delete pendingDecryption;
        }

        delete standardRefund[msg.sender][requestID];
        emit Refund(msg.sender, block.number, requestID);
    }

    /**
     * @dev Requests a refund for a pending swap operation.
     *      Returns the input tokens to the caller (reserves are restored),
     *      cancels the pending decryption if it corresponds to this request,
     *      and clears stored refund data.
     * @param requestID Gateway request ID associated with the pending swap.
     */
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

    /**
     * @dev Requests a refund for a pending remove-liquidity operation.
     *      Transfers the LP tokens (held by the pair) back to the caller,
     *      cancels the pending decryption if it corresponds to this request,
     *      and clears stored refund data.
     * @param requestID Gateway request ID associated with the pending liquidity removal.
     */
    function requestLiquidityRemovalRefund(uint256 requestID) public {
        if (!FHE.isInitialized(liquidityRemovalRefund[msg.sender][requestID].lpAmount)) revert NoRefund();

        _transfer(address(this), msg.sender, liquidityRemovalRefund[msg.sender][requestID].lpAmount);

        // If refund is sent prior to decryption we need to block the decryption
        if (requestID == pendingDecryption.currentRequestID) {
            delete pendingDecryption;
        }

        delete liquidityRemovalRefund[msg.sender][requestID];
        emit Refund(msg.sender, block.number, requestID);
    }
}
