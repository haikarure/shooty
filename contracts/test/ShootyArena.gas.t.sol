// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ArenaTestBase} from "./helpers/TestBase.sol";
import {IShootyArena} from "../src/IShootyArena.sol";

/// @dev Run with --isolate: each top-level call has fresh transaction storage warmth.
/// Snapshots measure the last arena call, excluding test setup/signing and intrinsic tx gas.
contract ShootyArenaGasTest is ArenaTestBase {
    function testGasDuelLifecycle() public {
        _lifecycle(IShootyArena.Mode.DUEL, "Duel");
    }

    function testGasTeamLifecycle() public {
        _lifecycle(IShootyArena.Mode.TEAM_DUEL, "Team");
    }

    function testGasRumbleLifecycle() public {
        _lifecycle(IShootyArena.Mode.RUMBLE, "Rumble");
    }

    function testGasTeamDraw() public {
        _live(ID, IShootyArena.Mode.TEAM_DUEL);
        _resolve(ID, IShootyArena.Outcome.DRAW, 0);
        vm.snapshotGasLastCall("Refund", "team_draw");
        _assertAccounting(ID);
    }

    function testGasPartialTeamExpiry() public {
        _create(ID, IShootyArena.Mode.TEAM_DUEL);
        for (uint256 i; i < 5; ++i) {
            _join(ID, i);
        }
        vm.warp(arena.getMatch(ID).joinDeadline + 1);
        arena.expireMatch(ID);
        vm.snapshotGasLastCall("Refund", "team_expire_five_deposits");
        _assertAccounting(ID);
    }

    function _lifecycle(IShootyArena.Mode mode, string memory group) private {
        _create(ID, mode);
        vm.snapshotGasLastCall(group, "create");
        uint256 count = _roster(mode).length;
        for (uint256 i; i < count; ++i) {
            _join(ID, i);
            vm.snapshotGasLastCall(group, string(abi.encodePacked("join_", bytes1(uint8(48 + i)))));
        }
        _start(ID);
        vm.snapshotGasLastCall(group, "start");
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        vm.snapshotGasLastCall(group, "resolve");
        uint256 winners = mode == IShootyArena.Mode.TEAM_DUEL ? 3 : 1;
        for (uint256 i; i < winners; ++i) {
            arena.claimFor(ID, _player(i));
            vm.snapshotGasLastCall(group, string(abi.encodePacked("claim_", bytes1(uint8(48 + i)))));
        }
        arena.claimFor(ID, TREASURY);
        vm.snapshotGasLastCall(group, "claim_fee");
        assert(arena.totalLiability() == 0);
        _assertAccounting(ID);
    }
}
