// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fixed Shooty economics. This library holds no tokens and decides no game results.
library PayoutMath {
    uint256 internal constant ENTRY = 1_000_000;
    uint256 internal constant FEE_BPS = 1_000;
    uint256 internal constant BPS = 10_000;

    error InvalidMode(uint8 mode);
    error InvalidDepositMask(uint8 mask);
    error NonDivisiblePrize();

    struct Quote {
        uint8 players;
        uint8 winners;
        uint256 entry;
        uint256 pool;
        uint256 fee;
        uint256 prize;
        uint256 perWinner;
    }

    // 0 = Duel, 1 = Team Duel, 2 = four-player Rumble.
    function quote(uint8 mode) internal pure returns (Quote memory q) {
        if (mode == 0) {
            q.players = 2;
            q.winners = 1;
        } else if (mode == 1) {
            q.players = 6;
            q.winners = 3;
        } else if (mode == 2) {
            q.players = 4;
            q.winners = 1;
        } else {
            revert InvalidMode(mode);
        }
        q.entry = ENTRY;
        q.pool = q.entry * q.players;
        q.fee = Math.mulDiv(q.pool, FEE_BPS, BPS);
        q.prize = q.pool - q.fee;
        if (q.prize % q.winners != 0) revert NonDivisiblePrize();
        q.perWinner = q.prize / q.winners;
    }

    /// @notice Draw/cancellation refund total, including partially funded rooms.
    /// @dev A set bit means that roster slot actually deposited. Fees are zero.
    function refundTotal(uint8 mode, uint8 depositMask) internal pure returns (uint256 total) {
        Quote memory q = quote(mode);
        uint8 validMask = uint8((uint256(1) << q.players) - 1);
        if (depositMask & ~validMask != 0) revert InvalidDepositMask(depositMask);
        for (uint8 slot; slot < q.players; ++slot) {
            if (depositMask & (uint8(1) << slot) != 0) total += q.entry;
        }
    }
}
