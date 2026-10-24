// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ArenaTestBase, Vm, TestToken, WrongDecimalsToken, ContractReferee} from "./helpers/TestBase.sol";
import {IShootyArena} from "../src/IShootyArena.sol";
import {ShootyArena} from "../src/ShootyArena.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ShootyArenaTest is ArenaTestBase {
    function testMatchCreatedIndexesMatchAndMode() public {
        vm.recordLogs();
        _create(ID, IShootyArena.Mode.TEAM_DUEL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assert(logs.length == 1);
        assert(logs[0].emitter == address(arena));
        assert(logs[0].topics.length == 3);
        assert(logs[0].topics[0] == keccak256("MatchCreated(bytes32,uint8,bytes32,bytes32)"));
        assert(logs[0].topics[1] == ID);
        assert(logs[0].topics[2] == bytes32(uint256(IShootyArena.Mode.TEAM_DUEL)));
        (bytes32 terms, bytes32 roster) = abi.decode(logs[0].data, (bytes32, bytes32));
        IShootyArena.MatchView memory data = arena.getMatch(ID);
        assert(terms == data.termsHash && roster == data.rosterHash);
    }

    function testTypedDataDigestsMatchBackendVectors() public {
        // Contract code at a known verifyingContract address; EIP712 rebuilds its cached domain.
        address verifyingContract = address(0x1234);
        vm.etch(verifyingContract, address(arena).code);
        ShootyArena fixedArena = ShootyArena(verifyingContract);
        bytes32 matchId = 0x1111111111111111111111111111111111111111111111111111111111111111;
        bytes32 terms = 0x2222222222222222222222222222222222222222222222222222222222222222;
        bytes32 results = 0x3333333333333333333333333333333333333333333333333333333333333333;
        IShootyArena.StartAuthorization memory start = IShootyArena.StartAuthorization(matchId, terms, 1_800_000_240);
        IShootyArena.ResultAuthorization memory result =
            IShootyArena.ResultAuthorization(matchId, terms, IShootyArena.Outcome.WIN, 1, results, 1_800_000_240);
        assert(
            fixedArena.hashStartAuthorization(start)
                == 0x8039e7e74b5dfe3f1147ea365cd814bded3638a31a879722b542d4da64a894d3
        );
        assert(
            fixedArena.hashResultAuthorization(result)
                == 0xf67396174f247ef3caabda5560f973fb1d50363e322d1a792d270740966378e5
        );
    }

    function testConstructorRejectsWrongChain() public {
        vm.chainId(143);
        vm.expectRevert(IShootyArena.WrongChain.selector);
        _deploy(address(token), referee, TREASURY);
    }

    function testConstructorRejectsEOATokenAndWrongDecimals() public {
        vm.expectRevert(ShootyArena.InvalidToken.selector);
        _deploy(OUTSIDER, referee, TREASURY);
        WrongDecimalsToken wrong = new WrongDecimalsToken();
        vm.expectRevert(ShootyArena.InvalidToken.selector);
        _deploy(address(wrong), referee, TREASURY);
    }

    function testConstructorRejectsZeroOfficialsAndRoles() public {
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        _deploy(address(token), address(0), TREASURY);
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        _deploy(address(token), referee, address(0));
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        new ShootyArena(address(token), address(0), CREATOR, PAUSER, referee, TREASURY);
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        new ShootyArena(address(token), address(this), address(0), PAUSER, referee, TREASURY);
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        new ShootyArena(address(token), address(this), CREATOR, address(0), referee, TREASURY);
    }

    function testRolesAreSeparated() public {
        assert(arena.hasRole(arena.DEFAULT_ADMIN_ROLE(), address(this)));
        assert(!arena.hasRole(arena.ROOM_CREATOR_ROLE(), address(this)));
        IShootyArena.CreateMatch memory input = _input(ID, IShootyArena.Mode.DUEL);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        arena.createMatch(input);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        arena.pause();
        vm.prank(CREATOR);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        arena.setDefaultOfficials(OUTSIDER, OUTSIDER);
    }

    function testCreateFreezesRosterAndTerms() public {
        _create(ID, IShootyArena.Mode.DUEL);
        IShootyArena.MatchView memory data = arena.getMatch(ID);
        assert(data.state == IShootyArena.State.OPEN);
        assert(data.referee == referee && data.feeRecipient == TREASURY);
        assert(data.depositMask == 0 && data.locked == 0);
        assert(data.rosterHash == keccak256(abi.encode(_roster(IShootyArena.Mode.DUEL))));
        assert(arena.getRoster(ID)[1] == _player(1));
        _assertAccounting(ID);
    }

    function testCreateRejectsBadRoster() public {
        IShootyArena.CreateMatch memory input = _input(ID, IShootyArena.Mode.DUEL);
        input.roster[1] = input.roster[0];
        vm.prank(CREATOR);
        vm.expectRevert(IShootyArena.InvalidRoster.selector);
        arena.createMatch(input);
        input.roster[1] = address(0);
        vm.prank(CREATOR);
        vm.expectRevert(IShootyArena.InvalidRoster.selector);
        arena.createMatch(input);
        input.roster[1] = address(arena);
        vm.prank(CREATOR);
        vm.expectRevert(IShootyArena.InvalidRoster.selector);
        arena.createMatch(input);
        input.roster = new address[](3);
        vm.prank(CREATOR);
        vm.expectRevert(IShootyArena.InvalidRoster.selector);
        arena.createMatch(input);
    }

    function testCreateRejectsInvalidIdsRulesAndDeadlines() public {
        IShootyArena.CreateMatch memory input = _input(bytes32(0), IShootyArena.Mode.DUEL);
        vm.prank(CREATOR);
        vm.expectRevert(ShootyArena.InvalidMatchId.selector);
        arena.createMatch(input);
        input.matchId = ID;
        input.rulesHash = 0;
        vm.prank(CREATOR);
        vm.expectRevert(ShootyArena.InvalidRulesHash.selector);
        arena.createMatch(input);
        input.rulesHash = RULES;
        input.joinDeadline = uint64(block.timestamp);
        vm.prank(CREATOR);
        vm.expectRevert(ShootyArena.InvalidDeadlines.selector);
        arena.createMatch(input);
        input.joinDeadline = uint64(block.timestamp + 180);
        input.startDeadline = input.joinDeadline;
        vm.prank(CREATOR);
        vm.expectRevert(ShootyArena.InvalidDeadlines.selector);
        arena.createMatch(input);
        input.startDeadline = type(uint64).max;
        vm.prank(CREATOR);
        vm.expectRevert(ShootyArena.InvalidDeadlines.selector);
        arena.createMatch(input);
    }

    function testMatchIdCannotBeReusedEvenAfterCancellation() public {
        _create(ID, IShootyArena.Mode.DUEL);
        vm.warp(arena.getMatch(ID).joinDeadline + 1);
        arena.expireMatch(ID);
        IShootyArena.CreateMatch memory input = _input(ID, IShootyArena.Mode.DUEL);
        vm.prank(CREATOR);
        vm.expectRevert(ShootyArena.MatchAlreadyExists.selector);
        arena.createMatch(input);
    }

    function testUnknownMatchRejected() public {
        vm.expectRevert(IShootyArena.UnknownMatch.selector);
        arena.getMatch(ID);
        vm.expectRevert(IShootyArena.UnknownMatch.selector);
        arena.getRoster(ID);
        vm.expectRevert(IShootyArena.UnknownMatch.selector);
        arena.joinMatch(ID, 0);
        vm.expectRevert(IShootyArena.UnknownMatch.selector);
        arena.expireMatch(ID);
        vm.expectRevert(IShootyArena.UnknownMatch.selector);
        arena.claimFor(ID, _player(0));
    }

    function testJoinRequiresParticipantTermsAndOwnTransaction() public {
        _create(ID, IShootyArena.Mode.DUEL);
        bytes32 terms = arena.getMatch(ID).termsHash;
        // An existing allowance does not let the creator debit a participant.
        vm.prank(CREATOR);
        vm.expectRevert(IShootyArena.NotParticipant.selector);
        arena.joinMatch(ID, terms);
        vm.prank(_player(0));
        vm.expectRevert(IShootyArena.TermsMismatch.selector);
        arena.joinMatch(ID, bytes32(uint256(1)));
        assert(arena.totalLiability() == 0);
        _join(ID, 0);
        assert(token.balanceOf(_player(0)) == 99 * ENTRY);
        assert(arena.getMatch(ID).locked == ENTRY);
        assert(arena.totalLiability() == ENTRY);
        vm.prank(_player(0));
        vm.expectRevert(IShootyArena.AlreadyDeposited.selector);
        arena.joinMatch(ID, terms);
        _join(ID, 1);
        _assertState(ID, IShootyArena.State.FUNDED);
        _assertAccounting(ID);
    }

    function testJoinRequiresAllowanceAndRollsBack() public {
        _create(ID, IShootyArena.Mode.DUEL);
        vm.prank(_player(0));
        token.approve(address(arena), 0);
        bytes32 terms = arena.getMatch(ID).termsHash;
        vm.prank(_player(0));
        vm.expectRevert();
        arena.joinMatch(ID, terms);
        assert(arena.getMatch(ID).depositMask == 0 && arena.totalLiability() == 0);
    }

    function testFeeOnTransferDepositRejectedAtomically() public {
        _create(ID, IShootyArena.Mode.DUEL);
        token.setSkim(true);
        bytes32 terms = arena.getMatch(ID).termsHash;
        vm.prank(_player(0));
        vm.expectRevert(IShootyArena.InvalidTokenTransfer.selector);
        arena.joinMatch(ID, terms);
        assert(arena.getMatch(ID).depositMask == 0 && arena.totalLiability() == 0);
        assert(token.balanceOf(_player(0)) == 100 * ENTRY);
        assert(token.balanceOf(address(arena)) == 0);
    }

    function testFalseReturningTokenRejectedOnDeposit() public {
        _create(ID, IShootyArena.Mode.DUEL);
        token.setFail(true);
        bytes32 terms = arena.getMatch(ID).termsHash;
        vm.prank(_player(0));
        vm.expectRevert();
        arena.joinMatch(ID, terms);
        assert(arena.totalLiability() == 0);
    }

    function testStartRequiresFullFunding() public {
        _create(ID, IShootyArena.Mode.DUEL);
        _join(ID, 0);
        IShootyArena.StartAuthorization memory input = _startInput(ID);
        bytes memory signature = _sign(arena.hashStartAuthorization(input), REFEREE_KEY);
        vm.expectRevert(IShootyArena.InvalidState.selector);
        arena.startMatch(input, signature);
    }

    function testStartRejectsWrongSignerMalformedSignatureAndTerms() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory input = _startInput(ID);
        bytes memory signature = _sign(arena.hashStartAuthorization(input), OTHER_KEY);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.startMatch(input, signature);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.startMatch(input, hex"010203");
        input.termsHash = 0;
        vm.expectRevert(IShootyArena.TermsMismatch.selector);
        arena.startMatch(input, signature);
    }

    function testStartReplayAndCrossMatchReplayRejected() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        bytes32 second = keccak256("second");
        _fund(second, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory input = _startInput(ID);
        bytes memory signature = _sign(arena.hashStartAuthorization(input), REFEREE_KEY);
        arena.startMatch(input, signature);
        vm.expectRevert(IShootyArena.InvalidState.selector);
        arena.startMatch(input, signature);
        input = _startInput(second);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.startMatch(input, signature);
    }

    function testStartCannotUseSignatureFromOtherChainOrArena() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory input = _startInput(ID);
        vm.chainId(143);
        bytes memory signature = _sign(arena.hashStartAuthorization(input), REFEREE_KEY);
        vm.chainId(10143);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.startMatch(input, signature);
        ShootyArena otherArena = _deploy(address(token), referee, TREASURY);
        signature = _sign(otherArena.hashStartAuthorization(input), REFEREE_KEY);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.startMatch(input, signature);
    }

    function testStartRejectsExpiredAuthorization() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory input = _startInput(ID);
        input.validUntil = uint64(block.timestamp - 1);
        bytes memory signature = _sign(arena.hashStartAuthorization(input), REFEREE_KEY);
        vm.expectRevert(IShootyArena.DeadlinePassed.selector);
        arena.startMatch(input, signature);
    }

    function testDuelWinAllocatesCreditsBeforeAnyTransfer() public {
        _live(ID, IShootyArena.Mode.DUEL);
        _resolve(ID, IShootyArena.Outcome.WIN, 1);
        _assertState(ID, IShootyArena.State.RESOLVED);
        assert(arena.getMatch(ID).locked == 0);
        assert(arena.creditOf(ID, _player(1)) == 1_800_000);
        assert(arena.creditOf(ID, _player(0)) == 0);
        assert(arena.creditOf(ID, TREASURY) == 200_000);
        assert(token.balanceOf(_player(1)) == 99 * ENTRY);
        assert(arena.totalLiability() == 2 * ENTRY);
        _assertAccounting(ID);
        vm.prank(OUTSIDER);
        assert(arena.claimFor(ID, _player(1)) == 1_800_000);
        assert(token.balanceOf(_player(1)) == 100_800_000);
        assert(token.balanceOf(OUTSIDER) == 0);
        assert(arena.totalLiability() == 200_000);
        arena.claimFor(ID, TREASURY);
        assert(arena.totalLiability() == 0 && token.balanceOf(address(arena)) == 0);
        _assertAccounting(ID);
    }

    function testBothTeamsPayAllThreeRosterMembers() public {
        for (uint8 team; team < 2; ++team) {
            bytes32 id = bytes32(uint256(team) + 1);
            _live(id, IShootyArena.Mode.TEAM_DUEL);
            _resolve(id, IShootyArena.Outcome.WIN, team);
            for (uint256 i; i < 6; ++i) {
                assert(arena.creditOf(id, _player(i)) == (i / 3 == team ? 1_800_000 : 0));
            }
            assert(arena.creditOf(id, TREASURY) == 600_000);
            _assertAccounting(id);
        }
    }

    function testRumbleWinnerReceivesThreePointSix() public {
        _live(ID, IShootyArena.Mode.RUMBLE);
        _resolve(ID, IShootyArena.Outcome.WIN, 3);
        assert(arena.creditOf(ID, _player(3)) == 3_600_000);
        assert(arena.creditOf(ID, TREASURY) == 400_000);
        _assertAccounting(ID);
    }

    function testFeeRecipientPlayerCreditsAccumulate() public {
        arena.setDefaultOfficials(referee, _player(0));
        _live(ID, IShootyArena.Mode.TEAM_DUEL);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        assert(arena.creditOf(ID, _player(0)) == 2_400_000);
        _assertAccounting(ID);
        arena.claimFor(ID, _player(0));
        _assertAccounting(ID);
    }

    function testDrawRefundsAllModesWithoutFees() public {
        for (uint8 mode; mode < 3; ++mode) {
            bytes32 id = bytes32(uint256(mode) + 1);
            _live(id, IShootyArena.Mode(mode));
            _resolve(id, IShootyArena.Outcome.DRAW, 0);
            address[] memory list = arena.getRoster(id);
            for (uint256 i; i < list.length; ++i) {
                assert(arena.creditOf(id, list[i]) == ENTRY);
            }
            assert(arena.creditOf(id, TREASURY) == 0);
            _assertAccounting(id);
        }
    }

    function testResolveRejectsBadWinnerIncludingDraw() public {
        _live(ID, IShootyArena.Mode.TEAM_DUEL);
        IShootyArena.ResultAuthorization memory input = _resultInput(ID, IShootyArena.Outcome.WIN, 2);
        bytes memory signature = _sign(arena.hashResultAuthorization(input), REFEREE_KEY);
        vm.expectRevert(IShootyArena.InvalidWinner.selector);
        arena.resolveMatch(input, signature);
        input = _resultInput(ID, IShootyArena.Outcome.DRAW, 1);
        signature = _sign(arena.hashResultAuthorization(input), REFEREE_KEY);
        vm.expectRevert(IShootyArena.InvalidWinner.selector);
        arena.resolveMatch(input, signature);
    }

    function testResolveRejectsOutOfRangeDuelAndRumbleWinners() public {
        for (uint8 mode; mode < 3; mode += 2) {
            bytes32 id = bytes32(uint256(mode) + 1);
            _live(id, IShootyArena.Mode(mode));
            IShootyArena.ResultAuthorization memory input =
                _resultInput(id, IShootyArena.Outcome.WIN, uint8(arena.getRoster(id).length));
            bytes memory signature = _sign(arena.hashResultAuthorization(input), REFEREE_KEY);
            vm.expectRevert(IShootyArena.InvalidWinner.selector);
            arena.resolveMatch(input, signature);
        }
    }

    function testResolveRejectsWrongSignerTermsAndTamperedResults() public {
        _live(ID, IShootyArena.Mode.DUEL);
        IShootyArena.ResultAuthorization memory input = _resultInput(ID, IShootyArena.Outcome.WIN, 0);
        bytes memory signature = _sign(arena.hashResultAuthorization(input), OTHER_KEY);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.resolveMatch(input, signature);
        signature = _sign(arena.hashResultAuthorization(input), REFEREE_KEY);
        input.resultsHash = keccak256("tampered");
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.resolveMatch(input, signature);
        input.termsHash = 0;
        vm.expectRevert(IShootyArena.TermsMismatch.selector);
        arena.resolveMatch(input, signature);
    }

    function testStartSignatureCannotAuthorizeResult() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory start = _startInput(ID);
        bytes memory signature = _sign(arena.hashStartAuthorization(start), REFEREE_KEY);
        arena.startMatch(start, signature);
        IShootyArena.ResultAuthorization memory result = _resultInput(ID, IShootyArena.Outcome.WIN, 0);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.resolveMatch(result, signature);
    }

    function testResultCannotReplayOrOverwriteTerminalState() public {
        _live(ID, IShootyArena.Mode.DUEL);
        IShootyArena.ResultAuthorization memory result = _resultInput(ID, IShootyArena.Outcome.WIN, 0);
        bytes memory signature = _sign(arena.hashResultAuthorization(result), REFEREE_KEY);
        arena.resolveMatch(result, signature);
        vm.expectRevert(IShootyArena.InvalidState.selector);
        arena.resolveMatch(result, signature);
        vm.expectRevert(IShootyArena.InvalidState.selector);
        arena.expireMatch(ID);
        assert(arena.creditOf(ID, _player(0)) == 1_800_000);
        _assertAccounting(ID);
    }

    function testPartialTeamTimeoutRefundsOnlyActualFiveDepositors() public {
        _create(ID, IShootyArena.Mode.TEAM_DUEL);
        for (uint256 i; i < 5; ++i) {
            _join(ID, i);
        }
        vm.warp(arena.getMatch(ID).joinDeadline + 1);
        vm.prank(OUTSIDER);
        arena.expireMatch(ID);
        _assertState(ID, IShootyArena.State.CANCELED);
        for (uint256 i; i < 5; ++i) {
            assert(arena.creditOf(ID, _player(i)) == ENTRY);
        }
        assert(arena.creditOf(ID, _player(5)) == 0 && arena.creditOf(ID, TREASURY) == 0);
        _assertAccounting(ID);
    }

    function testEmptyLobbyExpiresWithoutLiability() public {
        _create(ID, IShootyArena.Mode.DUEL);
        vm.warp(arena.getMatch(ID).joinDeadline + 1);
        arena.expireMatch(ID);
        _assertState(ID, IShootyArena.State.CANCELED);
        assert(arena.totalLiability() == 0);
    }

    function testFundedStartTimeoutAndLiveResultTimeoutRefund() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        vm.warp(arena.getMatch(ID).startDeadline + 1);
        arena.expireMatch(ID);
        _assertAccounting(ID);
        bytes32 second = keccak256("second");
        _live(second, IShootyArena.Mode.DUEL);
        IShootyArena.ResultAuthorization memory input = _resultInput(second, IShootyArena.Outcome.WIN, 1);
        bytes memory signature = _sign(arena.hashResultAuthorization(input), REFEREE_KEY);
        vm.warp(arena.getMatch(second).resultDeadline + 1);
        vm.expectRevert(IShootyArena.DeadlinePassed.selector);
        arena.resolveMatch(input, signature);
        arena.expireMatch(second);
        vm.expectRevert(IShootyArena.InvalidState.selector);
        arena.resolveMatch(input, signature);
        vm.expectRevert(IShootyArena.InvalidState.selector);
        arena.expireMatch(second);
        assert(arena.creditOf(second, _player(0)) == ENTRY);
        assert(arena.creditOf(second, TREASURY) == 0);
        _assertAccounting(second);
    }

    function testDeadlineBoundariesJoinStartAndResolveAreInclusive() public {
        _create(ID, IShootyArena.Mode.DUEL);
        vm.warp(arena.getMatch(ID).joinDeadline);
        vm.expectRevert(IShootyArena.DeadlineNotReached.selector);
        arena.expireMatch(ID);
        _join(ID, 0);
        _join(ID, 1);
        vm.warp(arena.getMatch(ID).startDeadline);
        vm.expectRevert(IShootyArena.DeadlineNotReached.selector);
        arena.expireMatch(ID);
        _start(ID);
        assert(arena.getMatch(ID).resultDeadline == block.timestamp + 240);
        vm.warp(arena.getMatch(ID).resultDeadline);
        vm.expectRevert(IShootyArena.DeadlineNotReached.selector);
        arena.expireMatch(ID);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        _assertAccounting(ID);
    }

    function testJoinAndStartRejectedOneSecondAfterDeadline() public {
        _create(ID, IShootyArena.Mode.DUEL);
        vm.warp(arena.getMatch(ID).joinDeadline + 1);
        bytes32 terms = arena.getMatch(ID).termsHash;
        vm.prank(_player(0));
        vm.expectRevert(IShootyArena.DeadlinePassed.selector);
        arena.joinMatch(ID, terms);
        bytes32 second = keccak256("second");
        _fund(second, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory start = _startInput(second);
        start.validUntil += 100;
        bytes memory signature = _sign(arena.hashStartAuthorization(start), REFEREE_KEY);
        vm.warp(arena.getMatch(second).startDeadline + 1);
        vm.expectRevert(IShootyArena.DeadlinePassed.selector);
        arena.startMatch(start, signature);
    }

    function testResolveRejectsExpiredSignatureBeforeMatchDeadline() public {
        _live(ID, IShootyArena.Mode.DUEL);
        IShootyArena.ResultAuthorization memory result = _resultInput(ID, IShootyArena.Outcome.WIN, 0);
        result.validUntil = uint64(block.timestamp - 1);
        bytes memory signature = _sign(arena.hashResultAuthorization(result), REFEREE_KEY);
        vm.expectRevert(IShootyArena.DeadlinePassed.selector);
        arena.resolveMatch(result, signature);
    }

    function testPauseBlocksAdmissionAndStartButAllowsResolveExpiryAndClaim() public {
        _live(ID, IShootyArena.Mode.DUEL);
        bytes32 funded = keccak256("funded");
        bytes32 open = keccak256("open");
        _fund(funded, IShootyArena.Mode.DUEL);
        _create(open, IShootyArena.Mode.DUEL);
        IShootyArena.StartAuthorization memory start = _startInput(funded);
        bytes memory signature = _sign(arena.hashStartAuthorization(start), REFEREE_KEY);
        IShootyArena.CreateMatch memory input = _input(keccak256("new"), IShootyArena.Mode.DUEL);
        bytes32 terms = arena.getMatch(open).termsHash;
        vm.prank(PAUSER);
        arena.pause();
        vm.prank(CREATOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arena.createMatch(input);
        vm.prank(_player(0));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arena.joinMatch(open, terms);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arena.startMatch(start, signature);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        assert(arena.claimFor(ID, _player(0)) == 1_800_000);
        vm.warp(arena.getMatch(funded).startDeadline + 1);
        arena.expireMatch(funded);
        assert(arena.claimFor(funded, _player(0)) == ENTRY);
        arena.expireMatch(open);
        vm.prank(PAUSER);
        arena.unpause();
        _create(keccak256("after-unpause"), IShootyArena.Mode.DUEL);
    }

    function testOfficialsRotationAffectsOnlyFutureMatches() public {
        _fund(ID, IShootyArena.Mode.DUEL);
        bytes32 oldTerms = arena.getMatch(ID).termsHash;
        address replacement = vm.addr(OTHER_KEY);
        arena.setDefaultOfficials(replacement, OUTSIDER);
        assert(arena.getMatch(ID).referee == referee);
        assert(arena.getMatch(ID).feeRecipient == TREASURY);
        assert(arena.getMatch(ID).termsHash == oldTerms);
        _start(ID);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        bytes32 second = keccak256("second");
        _fund(second, IShootyArena.Mode.DUEL);
        assert(arena.getMatch(second).referee == replacement);
        assert(arena.getMatch(second).feeRecipient == OUTSIDER);
        IShootyArena.StartAuthorization memory start = _startInput(second);
        bytes memory oldSignature = _sign(arena.hashStartAuthorization(start), REFEREE_KEY);
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.startMatch(start, oldSignature);
        arena.startMatch(start, _sign(arena.hashStartAuthorization(start), OTHER_KEY));
    }

    function testSetOfficialsRejectsArenaTreasuryOrZero() public {
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        arena.setDefaultOfficials(referee, address(arena));
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        arena.setDefaultOfficials(address(0), TREASURY);
        vm.expectRevert(ShootyArena.InvalidAddress.selector);
        arena.setDefaultOfficials(referee, address(0));
    }

    function testContractRefereeSupportsERC1271AndRevocation() public {
        ContractReferee contractReferee = new ContractReferee(referee);
        arena.setDefaultOfficials(address(contractReferee), TREASURY);
        _live(ID, IShootyArena.Mode.DUEL);
        IShootyArena.ResultAuthorization memory result = _resultInput(ID, IShootyArena.Outcome.WIN, 1);
        bytes memory signature = _sign(arena.hashResultAuthorization(result), REFEREE_KEY);
        contractReferee.revoke();
        vm.expectRevert(IShootyArena.InvalidSignature.selector);
        arena.resolveMatch(result, signature);
        vm.warp(arena.getMatch(ID).resultDeadline + 1);
        arena.expireMatch(ID);
        _assertAccounting(ID);
    }

    function testClaimFailureDoesNotBlockOthersAndCanBeRetried() public {
        _live(ID, IShootyArena.Mode.TEAM_DUEL);
        token.setBlocked(_player(0), true);
        // No transfer during resolution, even with a blocked winner.
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        vm.expectRevert();
        arena.claimFor(ID, _player(0));
        assert(arena.creditOf(ID, _player(0)) == 1_800_000);
        assert(arena.totalPaid(ID) == 0 && arena.totalLiability() == 6 * ENTRY);
        arena.claimFor(ID, _player(1));
        arena.claimFor(ID, _player(2));
        arena.claimFor(ID, TREASURY);
        assert(arena.totalLiability() == 1_800_000);
        token.setBlocked(_player(0), false);
        arena.claimFor(ID, _player(0));
        assert(arena.totalLiability() == 0);
        _assertAccounting(ID);
    }

    function testClaimChecksExactTransferAndRestoresCreditOnFailure() public {
        _live(ID, IShootyArena.Mode.DUEL);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        token.setSkim(true);
        vm.expectRevert(IShootyArena.InvalidTokenTransfer.selector);
        arena.claimFor(ID, _player(0));
        assert(arena.creditOf(ID, _player(0)) == 1_800_000 && arena.totalLiability() == 2 * ENTRY);
        assert(token.balanceOf(_player(0)) == 99 * ENTRY);
        token.setSkim(false);
        token.setFail(true);
        vm.expectRevert();
        arena.claimFor(ID, _player(0));
        assert(arena.creditOf(ID, _player(0)) == 1_800_000);
        token.setFail(false);
        arena.claimFor(ID, _player(0));
        _assertAccounting(ID);
    }

    function testClaimZeroIsNoopAndEmitsPaymentOnlyOnce() public {
        _live(ID, IShootyArena.Mode.DUEL);
        assert(arena.claimFor(ID, OUTSIDER) == 0);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        vm.recordLogs();
        assert(arena.claimFor(ID, _player(0)) == 1_800_000);
        assert(arena.claimFor(ID, _player(0)) == 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(arena)) {
                assert(logs[i].topics[0] == keccak256("PaymentSent(bytes32,address,uint256)"));
                assert(logs[i].topics[1] == ID);
                assert(logs[i].topics[2] == bytes32(uint256(uint160(_player(0)))));
                assert(abi.decode(logs[i].data, (uint256)) == 1_800_000);
                ++count;
            }
        }
        assert(count == 1);
    }

    function testReentrantDepositAndClaimCannotDuplicatePayment() public {
        _create(ID, IShootyArena.Mode.DUEL);
        token.setAttack(address(arena), abi.encodeCall(arena.claimFor, (ID, _player(0))));
        _join(ID, 0);
        assert(!token.reentrySucceeded());
        assert(bytes4(token.reentryError()) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _join(ID, 1);
        _start(ID);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        arena.claimFor(ID, _player(0));
        assert(!token.reentrySucceeded());
        assert(arena.creditOf(ID, _player(0)) == 0);
        assert(token.balanceOf(_player(0)) == 100_800_000);
        _assertAccounting(ID);
    }

    function testDirectDonationsDoNotBecomePoolOrLiability() public {
        token.mint(address(arena), 10 * ENTRY);
        _live(ID, IShootyArena.Mode.DUEL);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        arena.claimFor(ID, _player(0));
        arena.claimFor(ID, TREASURY);
        assert(arena.totalLiability() == 0 && token.balanceOf(address(arena)) == 10 * ENTRY);
        _assertAccounting(ID);
        (bool ok,) = address(arena).call(abi.encodeWithSignature("withdraw(address,uint256)", OUTSIDER, 10 * ENTRY));
        assert(!ok);
    }

    function testMultipleMatchesDoNotSpendEachOthersLiabilities() public {
        _live(ID, IShootyArena.Mode.DUEL);
        bytes32 second = keccak256("second");
        _create(second, IShootyArena.Mode.TEAM_DUEL);
        _join(second, 4);
        _resolve(ID, IShootyArena.Outcome.WIN, 0);
        arena.claimFor(ID, _player(0));
        arena.claimFor(ID, TREASURY);
        assert(token.balanceOf(address(arena)) == ENTRY && arena.totalLiability() == ENTRY);
        vm.warp(arena.getMatch(second).joinDeadline + 1);
        arena.expireMatch(second);
        arena.claimFor(second, _player(4));
        assert(arena.totalLiability() == 0);
        _assertAccounting(ID);
        _assertAccounting(second);
    }

    function testFuzzEveryDepositSubsetRefundsExactly(uint8 rawMode, uint8 rawMask) public {
        IShootyArena.Mode mode = IShootyArena.Mode(rawMode % 3);
        _create(ID, mode);
        address[] memory list = arena.getRoster(ID);
        uint8 mask = rawMask & uint8((uint256(1) << list.length) - 1);
        uint256 paid;
        for (uint256 i; i < list.length; ++i) {
            if (mask & (uint8(1) << i) != 0) {
                _join(ID, i);
                ++paid;
            }
        }
        IShootyArena.MatchView memory data = arena.getMatch(ID);
        vm.warp((data.state == IShootyArena.State.FUNDED ? data.startDeadline : data.joinDeadline) + 1);
        arena.expireMatch(ID);
        assert(arena.totalLiability() == paid * ENTRY);
        for (uint256 i; i < list.length; ++i) {
            uint256 refund = mask & (uint8(1) << i) != 0 ? ENTRY : 0;
            assert(arena.creditOf(ID, list[i]) == refund);
            assert(arena.claimFor(ID, list[i]) == refund);
            assert(token.balanceOf(list[i]) == 100 * ENTRY);
        }
        assert(arena.totalLiability() == 0 && arena.creditOf(ID, TREASURY) == 0);
        _assertAccounting(ID);
    }

    function testFuzzWinPayoutsConserveAllModes(uint8 rawMode, uint8 rawWinner) public {
        IShootyArena.Mode mode = IShootyArena.Mode(rawMode % 3);
        _live(ID, mode);
        address[] memory list = arena.getRoster(ID);
        uint8 winner = rawWinner % uint8(mode == IShootyArena.Mode.TEAM_DUEL ? 2 : list.length);
        _resolve(ID, IShootyArena.Outcome.WIN, winner);
        uint256 total;
        for (uint256 i; i < list.length; ++i) {
            total += arena.claimFor(ID, list[i]);
        }
        total += arena.claimFor(ID, TREASURY);
        assert(total == list.length * ENTRY);
        assert(arena.totalLiability() == 0 && token.balanceOf(address(arena)) == 0);
        _assertAccounting(ID);
    }
}
