// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PayoutMath} from "../src/PayoutMath.sol";

contract PayoutMathTest {
    function testDuelAmounts() public pure {
        PayoutMath.Quote memory q = PayoutMath.quote(0);
        assert(q.players == 2 && q.winners == 1);
        assert(q.pool == 2_000_000 && q.fee == 200_000);
        assert(q.perWinner == 1_800_000);
    }

    function testTeamAmounts() public pure {
        PayoutMath.Quote memory q = PayoutMath.quote(1);
        assert(q.players == 6 && q.winners == 3);
        assert(q.pool == 6_000_000 && q.fee == 600_000);
        assert(q.prize == 5_400_000 && q.perWinner == 1_800_000);
    }

    function testRumbleAmounts() public pure {
        PayoutMath.Quote memory q = PayoutMath.quote(2);
        assert(q.players == 4 && q.winners == 1);
        assert(q.pool == 4_000_000 && q.fee == 400_000);
        assert(q.perWinner == 3_600_000);
    }

    function testAllValidRefundMasksConserveDeposits() public pure {
        for (uint8 mode; mode < 3; ++mode) {
            PayoutMath.Quote memory q = PayoutMath.quote(mode);
            uint256 masks = uint256(1) << q.players;
            for (uint256 mask; mask < masks; ++mask) {
                uint256 paidCount;
                for (uint256 slot; slot < q.players; ++slot) {
                    if ((mask / (uint256(1) << slot)) % 2 == 1) ++paidCount;
                }
                assert(PayoutMath.refundTotal(mode, uint8(mask)) == paidCount * 1_000_000);
            }
        }
    }

    function testPartialTeamLobbyRefundsOnlyFiveDeposits() public pure {
        assert(PayoutMath.refundTotal(1, 0x1f) == 5_000_000);
    }

    function testDrawReturnsWholePool() public pure {
        assert(PayoutMath.refundTotal(0, 0x03) == 2_000_000);
        assert(PayoutMath.refundTotal(1, 0x3f) == 6_000_000);
        assert(PayoutMath.refundTotal(2, 0x0f) == 4_000_000);
    }

    function testFuzzPoolConservation(uint8 rawMode) public pure {
        PayoutMath.Quote memory q = PayoutMath.quote(rawMode % 3);
        assert(q.perWinner * q.winners + q.fee == q.pool);
        assert(q.prize + q.fee == q.pool);
        assert(q.fee * 10 == q.pool);
        assert(q.pool == q.entry * q.players);
    }

    function quoteRaw(uint8 mode) external pure {
        PayoutMath.quote(mode);
    }

    function refundRaw(uint8 mode, uint8 mask) external pure {
        PayoutMath.refundTotal(mode, mask);
    }

    function testRejectsUnknownMode() public view {
        try this.quoteRaw(3) {
            assert(false);
        }
            catch (bytes memory reason) {
            assert(bytes4(reason) == PayoutMath.InvalidMode.selector);
        }
    }

    function testRejectsDepositsOutsideRoster() public view {
        try this.refundRaw(0, 0x04) {
            assert(false);
        }
            catch (bytes memory reason) {
            assert(bytes4(reason) == PayoutMath.InvalidDepositMask.selector);
        }
    }
}
