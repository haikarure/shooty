// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ArenaTestBase, TestToken, Vm} from "./helpers/TestBase.sol";
import {ShootyArena} from "../src/ShootyArena.sol";
import {IShootyArena} from "../src/IShootyArena.sol";

/// @dev Drives actual transfers and signatures, keeping independent ghost deposit/payment totals.
contract ArenaHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ShootyArena public immutable arena;
    TestToken public immutable token;
    uint256 private immutable refereeKey;
    address private immutable pauser;
    address private constant TREASURY = address(0x1003);
    bytes32[] public ids;
    uint256 public ghostDeposits;
    uint256 public ghostPaid;
    uint256 public ghostDonations;

    constructor(ShootyArena arena_, TestToken token_, uint256 key_, address pauser_) {
        arena = arena_;
        token = token_;
        refereeKey = key_;
        pauser = pauser_;
    }

    function create(uint8 rawMode) external {
        if (ids.length >= 16 || arena.paused()) return;
        IShootyArena.Mode mode = IShootyArena.Mode(rawMode % 3);
        uint256 count = mode == IShootyArena.Mode.DUEL ? 2 : mode == IShootyArena.Mode.TEAM_DUEL ? 6 : 4;
        address[] memory roster = new address[](count);
        for (uint256 i; i < count; ++i) {
            roster[i] = address(uint160(0x2000 + i));
        }
        bytes32 id = bytes32(ids.length + 1);
        arena.createMatch(
            IShootyArena.CreateMatch(
                id, mode, roster, keccak256("rules"), uint64(block.timestamp + 180), uint64(block.timestamp + 240)
            )
        );
        ids.push(id);
    }

    function join(uint256 seed, uint8 rawSlot) external {
        if (ids.length == 0 || arena.paused()) return;
        bytes32 id = ids[seed % ids.length];
        IShootyArena.MatchView memory data = arena.getMatch(id);
        if (data.state != IShootyArena.State.OPEN || block.timestamp > data.joinDeadline) return;
        address[] memory roster = arena.getRoster(id);
        uint8 slot = rawSlot % uint8(roster.length);
        if (data.depositMask & (uint8(1) << slot) != 0) return;
        vm.prank(roster[slot]);
        arena.joinMatch(id, data.termsHash);
        ghostDeposits += 1_000_000;
    }

    function start(uint256 seed) external {
        if (ids.length == 0 || arena.paused()) return;
        bytes32 id = ids[seed % ids.length];
        IShootyArena.MatchView memory data = arena.getMatch(id);
        if (data.state != IShootyArena.State.FUNDED || block.timestamp > data.startDeadline) return;
        IShootyArena.StartAuthorization memory auth =
            IShootyArena.StartAuthorization(id, data.termsHash, data.startDeadline);
        arena.startMatch(auth, _sign(arena.hashStartAuthorization(auth)));
    }

    function resolve(uint256 seed, uint8 rawWinner, bool draw) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        IShootyArena.MatchView memory data = arena.getMatch(id);
        if (data.state != IShootyArena.State.LIVE || block.timestamp > data.resultDeadline) return;
        uint8 choices = uint8(data.mode == IShootyArena.Mode.TEAM_DUEL ? 2 : arena.getRoster(id).length);
        IShootyArena.ResultAuthorization memory auth = IShootyArena.ResultAuthorization(
            id,
            data.termsHash,
            draw ? IShootyArena.Outcome.DRAW : IShootyArena.Outcome.WIN,
            draw ? 0 : rawWinner % choices,
            keccak256(abi.encode(seed)),
            data.resultDeadline
        );
        arena.resolveMatch(auth, _sign(arena.hashResultAuthorization(auth)));
    }

    function advanceAndExpire(uint256 seed, uint16 jump) external {
        vm.warp(block.timestamp + (jump % 300));
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        IShootyArena.MatchView memory data = arena.getMatch(id);
        uint64 deadline;
        if (data.state == IShootyArena.State.OPEN) deadline = data.joinDeadline;
        else if (data.state == IShootyArena.State.FUNDED) deadline = data.startDeadline;
        else if (data.state == IShootyArena.State.LIVE) deadline = data.resultDeadline;
        else return;
        if (block.timestamp > deadline) arena.expireMatch(id);
    }

    function claim(uint256 seed, uint8 rawBeneficiary) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        address[] memory roster = arena.getRoster(id);
        uint256 slot = rawBeneficiary % (roster.length + 1);
        address receiver = slot == roster.length ? TREASURY : roster[slot];
        uint256 beforeBalance = token.balanceOf(receiver);
        uint256 paid = arena.claimFor(id, receiver);
        assert(token.balanceOf(receiver) - beforeBalance == paid);
        ghostPaid += paid;
    }

    function togglePause() external {
        bool paused = arena.paused();
        vm.prank(pauser);
        if (paused) arena.unpause();
        else arena.pause();
    }

    function donate(uint32 amount) external {
        uint256 donation = amount % 1_000_000;
        token.mint(address(arena), donation);
        ghostDonations += donation;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function _sign(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(refereeKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract ShootyArenaInvariantTest is ArenaTestBase {
    ArenaHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ArenaHandler(arena, token, REFEREE_KEY, PAUSER);
        arena.grantRole(arena.ROOM_CREATOR_ROLE(), address(handler));
        // Seed every mode and phase so random runs always exercise settlement and claims.
        for (uint8 mode; mode < 3; ++mode) {
            handler.create(mode);
            for (uint8 i; i < _roster(IShootyArena.Mode(mode)).length; ++i) {
                handler.join(mode, i);
            }
            handler.start(mode);
        }
        handler.resolve(0, 0, false);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantAllDepositsRemainLockedCreditedOrPaid() public view {
        uint256 obligations;
        uint256 deposited;
        uint256 paid;
        for (uint256 i; i < handler.count(); ++i) {
            bytes32 id = handler.ids(i);
            _assertAccounting(id);
            IShootyArena.MatchView memory data = arena.getMatch(id);
            uint256 credits = arena.creditOf(id, TREASURY);
            address[] memory roster = arena.getRoster(id);
            for (uint256 j; j < roster.length; ++j) {
                credits += arena.creditOf(id, roster[j]);
            }
            obligations += data.locked + credits;
            deposited += arena.totalDeposited(id);
            paid += arena.totalPaid(id);
        }
        assert(obligations == arena.totalLiability());
        assert(deposited == handler.ghostDeposits());
        assert(paid == handler.ghostPaid());
        assert(deposited == obligations + paid);
        assert(token.balanceOf(address(arena)) == obligations + handler.ghostDonations());
    }

    function invariantTerminalMatchesHaveNoLockedFunds() public view {
        for (uint256 i; i < handler.count(); ++i) {
            IShootyArena.MatchView memory data = arena.getMatch(handler.ids(i));
            if (data.state == IShootyArena.State.RESOLVED || data.state == IShootyArena.State.CANCELED) {
                assert(data.locked == 0);
            } else {
                address[] memory roster = arena.getRoster(handler.ids(i));
                for (uint256 j; j < roster.length; ++j) {
                    assert(arena.creditOf(handler.ids(i), roster[j]) == 0);
                }
            }
        }
    }
}
