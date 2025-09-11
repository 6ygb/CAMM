// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, externalEuint64, ebool, euint16, euint32, euint64, euint128} from "@fhevm/solidity/lib/FHE.sol";

library CAMMPairLib {
    function computeRNG(uint16 max /* 0 => unbounded */, uint16 minAdd /* 0 => none */) public returns (euint16) {
        euint16 randomNumber = (max == 0) ? FHE.randEuint16() : FHE.randEuint16(max);
        if (minAdd != 0) {
            ebool tooSmall = FHE.lt(randomNumber, minAdd);
            euint16 addend = FHE.select(tooSmall, FHE.asEuint16(minAdd), FHE.asEuint16(0));
            randomNumber = FHE.add(randomNumber, addend);
        }
        return randomNumber;
    }

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

    function computeFirstMint(
        euint64 amount0,
        euint64 amount1,
        uint64 minLiq
    ) external returns (euint64, euint64, euint64) {
        euint64 zero = FHE.asEuint64(0);

        euint64 liquidityAmount = FHE.add(FHE.shr(amount0, 1), FHE.shr(amount1, 1));

        ebool isBelowMinimum = FHE.lt(liquidityAmount, minLiq);
        liquidityAmount = FHE.select(isBelowMinimum, zero, liquidityAmount);
        euint64 amount0Back = FHE.select(isBelowMinimum, amount0, zero);
        euint64 amount1Back = FHE.select(isBelowMinimum, amount1, zero);

        return (liquidityAmount, amount0Back, amount1Back);
    }

    function computeAddLiquidity(
        euint64 reserve0,
        euint64 reserve1,
        euint128 currentLPSupply
    ) external returns (euint128, euint128, euint128, euint128) {
        euint16 rng0 = computeRNG(0, 3); // 184_000 HCU
        euint16 rng1 = computeRNG(0, 3); // 184_000 HCU

        euint128 divLowerPart0 = FHE.mul(FHE.asEuint128(reserve0), FHE.asEuint128(rng0)); // 646_000 HCU
        euint128 divLowerPart1 = FHE.mul(FHE.asEuint128(reserve1), FHE.asEuint128(rng1)); // 646_000 HCU

        euint128 partialUpperPart0 = FHE.mul(currentLPSupply, FHE.asEuint128(rng0)); // 646_000 HCU
        euint128 partialUpperPart1 = FHE.mul(currentLPSupply, FHE.asEuint128(rng1)); // 646_000 HCU

        return (divLowerPart0, divLowerPart1, partialUpperPart0, partialUpperPart1);
    }

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

    function computeRemoveLiquidity(
        euint64 reserve0,
        euint64 reserve1,
        euint64 sentLP,
        euint128 currentLPSupply128
    ) external returns (euint128, euint128, euint128, euint128) {
        euint128 sentLP128 = FHE.asEuint128(sentLP);

        euint16 rng0 = computeRNG(0, 3); // 184_000 HCU
        euint16 rng1 = computeRNG(0, 3); // 184_000 HCU

        euint128 divUpperPart0 = FHE.mul(FHE.mul(sentLP128, FHE.asEuint128(reserve0)), FHE.asEuint128(rng0));
        euint128 divUpperPart1 = FHE.mul(FHE.mul(sentLP128, FHE.asEuint128(reserve1)), FHE.asEuint128(rng1));

        euint128 divLowerPart0 = FHE.mul(currentLPSupply128, FHE.asEuint128(rng0));
        euint128 divLowerPart1 = FHE.mul(currentLPSupply128, FHE.asEuint128(rng1));

        return (divUpperPart0, divUpperPart1, divLowerPart0, divLowerPart1);
    }

    function computeSwap(
        euint64 sent0,
        euint64 sent1,
        euint64 reserve0,
        euint64 reserve1
    ) external returns (euint128, euint128, euint128, euint128) {
        //uint16 max                        65,535
        //uint64 max                        18,446,744,073,709,551,615
        //uint64 max^2                      10,973,678,151,985,686,339,682,919,724,057,600
        //uint64 max^2 * 16384 + 3          179,792,742,842,133,484,989,364,956,758,959,718,403
        //uint128 max                       340,282,366,920,938,463,463,374,607,431,768,211,455

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
}
