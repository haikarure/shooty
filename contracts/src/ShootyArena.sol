// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IShootyArena} from "./IShootyArena.sol";
import {PayoutMath} from "./PayoutMath.sol";

/// @notice Non-upgradeable escrow. The snapshotted referee is trusted to report game results.
/// @dev Resolve/expire allocate credits; anyone may send each credit to its fixed beneficiary.
contract ShootyArena is IShootyArena, AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant CHAIN_ID = 10143;
    uint256 public constant ENTRY = 1_000_000;
    uint256 public constant FEE_BPS = 1_000;
    uint256 public constant BPS = 10_000;
    uint64 public constant MAX_PLAY_SECONDS = 120;
    uint64 public constant RESULT_GRACE_SECONDS = 120;
    bytes32 public constant ROOM_CREATOR_ROLE = keccak256("ROOM_CREATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TERMS_VERSION = keccak256("SHOOTY_TERMS_V1");
    bytes32 public constant START_TYPEHASH =
        keccak256("StartAuthorization(bytes32 matchId,bytes32 termsHash,uint64 validUntil)");
    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "ResultAuthorization(bytes32 matchId,bytes32 termsHash,uint8 outcome,uint8 winner,bytes32 resultsHash,uint64 validUntil)"
    );

    address public immutable override rewardToken;
    address public defaultReferee;
    address public defaultFeeRecipient;
    uint256 public override totalLiability;

    struct MatchRecord {
        MatchView data;
        address[] roster;
    }

    mapping(bytes32 => MatchRecord) private _matches;
    mapping(bytes32 => mapping(address => uint256)) private _credits;
    mapping(bytes32 => uint256) public totalDeposited;
    mapping(bytes32 => uint256) public totalPaid;

    error InvalidAddress();
    error InvalidToken();
    error InvalidMatchId();
    error MatchAlreadyExists();
    error InvalidDeadlines();
    error InvalidRulesHash();

    event DefaultOfficialsUpdated(address indexed referee, address indexed feeRecipient);

    constructor(address token, address admin, address creator, address pauser, address referee, address feeRecipient)
        EIP712("ShootyArena", "1")
    {
        if (block.chainid != CHAIN_ID) revert WrongChain();
        if (token.code.length == 0 || IERC20Metadata(token).decimals() != 6) revert InvalidToken();
        if (admin == address(0) || creator == address(0) || pauser == address(0)) revert InvalidAddress();
        rewardToken = token;
        _setDefaultOfficials(referee, feeRecipient);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROOM_CREATOR_ROLE, creator);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Affects future matches only. Active matches keep their referee and treasury.
    function setDefaultOfficials(address referee, address feeRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDefaultOfficials(referee, feeRecipient);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function createMatch(CreateMatch calldata input) external override onlyRole(ROOM_CREATOR_ROLE) whenNotPaused {
        if (input.matchId == bytes32(0)) revert InvalidMatchId();
        MatchRecord storage record = _matches[input.matchId];
        if (record.data.state != State.NONE) revert MatchAlreadyExists();
        if (input.rulesHash == bytes32(0)) revert InvalidRulesHash();
        if (
            input.joinDeadline <= block.timestamp || input.startDeadline <= input.joinDeadline
                || input.startDeadline > type(uint64).max - MAX_PLAY_SECONDS - RESULT_GRACE_SECONDS
        ) revert InvalidDeadlines();
        uint256 count = PayoutMath.quote(uint8(input.mode)).players;
        if (input.roster.length != count) revert InvalidRoster();
        for (uint256 i; i < count; ++i) {
            if (input.roster[i] == address(0) || input.roster[i] == address(this)) revert InvalidRoster();
            for (uint256 j; j < i; ++j) {
                if (input.roster[i] == input.roster[j]) revert InvalidRoster();
            }
        }

        MatchView storage data = record.data;
        data.mode = input.mode;
        data.state = State.OPEN;
        data.rosterHash = keccak256(abi.encode(input.roster));
        data.rulesHash = input.rulesHash;
        data.referee = defaultReferee;
        data.feeRecipient = defaultFeeRecipient;
        data.joinDeadline = input.joinDeadline;
        data.startDeadline = input.startDeadline;
        data.termsHash = _termsHash(input.matchId, data);
        record.roster = input.roster;
        emit MatchCreated(input.matchId, input.mode, data.termsHash, data.rosterHash);
    }

    function joinMatch(bytes32 matchId, bytes32 expectedTermsHash) external override nonReentrant whenNotPaused {
        MatchRecord storage record = _knownMatch(matchId);
        MatchView storage data = record.data;
        if (data.state != State.OPEN) revert InvalidState();
        if (block.timestamp > data.joinDeadline) revert DeadlinePassed();
        if (expectedTermsHash != data.termsHash) revert TermsMismatch();

        uint256 rosterLength = record.roster.length;
        uint8 slot = _participantSlot(record.roster, msg.sender, rosterLength);
        uint8 bit = uint8(1) << slot;
        uint8 depositMask = data.depositMask;
        if (depositMask & bit != 0) revert AlreadyDeposited();
        depositMask |= bit;
        data.depositMask = depositMask;
        uint256 locked = data.locked + ENTRY;
        data.locked = locked;
        totalDeposited[matchId] += ENTRY;
        totalLiability += ENTRY;

        IERC20 token = IERC20(rewardToken);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), ENTRY);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != ENTRY) revert InvalidTokenTransfer();
        emit PlayerDeposited(matchId, msg.sender, slot, ENTRY);
        // Roster, mask and locked amount cannot change during the guarded token call.
        if (depositMask == uint8((uint256(1) << rosterLength) - 1)) {
            data.state = State.FUNDED;
            emit MatchFunded(matchId, locked);
        }
    }

    function startMatch(StartAuthorization calldata input, bytes calldata refereeSignature)
        external
        override
        nonReentrant
        whenNotPaused
    {
        MatchView storage data = _knownMatch(input.matchId).data;
        if (data.state != State.FUNDED) revert InvalidState();
        if (block.timestamp > data.startDeadline || block.timestamp > input.validUntil) revert DeadlinePassed();
        if (data.termsHash != input.termsHash) revert TermsMismatch();
        if (!SignatureChecker.isValidSignatureNow(data.referee, hashStartAuthorization(input), refereeSignature)) {
            revert InvalidSignature();
        }
        data.state = State.LIVE;
        data.resultDeadline = uint64(block.timestamp) + MAX_PLAY_SECONDS + RESULT_GRACE_SECONDS;
        emit MatchStarted(input.matchId, data.resultDeadline);
    }

    function resolveMatch(ResultAuthorization calldata input, bytes calldata refereeSignature)
        external
        override
        nonReentrant
    {
        MatchRecord storage record = _knownMatch(input.matchId);
        MatchView storage data = record.data;
        if (data.state != State.LIVE) revert InvalidState();
        if (block.timestamp > data.resultDeadline || block.timestamp > input.validUntil) revert DeadlinePassed();
        if (data.termsHash != input.termsHash) revert TermsMismatch();
        PayoutMath.Quote memory q = PayoutMath.quote(uint8(data.mode));
        if (input.outcome == Outcome.DRAW) {
            if (input.winner != 0) revert InvalidWinner();
        } else if (input.winner >= (data.mode == Mode.TEAM_DUEL ? 2 : q.players)) {
            revert InvalidWinner();
        }
        if (!SignatureChecker.isValidSignatureNow(data.referee, hashResultAuthorization(input), refereeSignature)) {
            revert InvalidSignature();
        }

        data.state = State.RESOLVED;
        data.locked = 0;
        emit MatchResolved(input.matchId, input.outcome, input.winner, input.resultsHash);
        if (input.outcome == Outcome.DRAW) {
            _refund(input.matchId, record);
        } else {
            uint256 first = data.mode == Mode.TEAM_DUEL ? uint256(input.winner) * 3 : input.winner;
            for (uint256 i; i < q.winners; ++i) {
                _credit(input.matchId, record.roster[first + i], q.perWinner);
            }
            _credit(input.matchId, data.feeRecipient, q.fee);
        }
    }

    function expireMatch(bytes32 matchId) external override nonReentrant {
        MatchRecord storage record = _knownMatch(matchId);
        MatchView storage data = record.data;
        uint64 deadline;
        if (data.state == State.OPEN) deadline = data.joinDeadline;
        else if (data.state == State.FUNDED) deadline = data.startDeadline;
        else if (data.state == State.LIVE) deadline = data.resultDeadline;
        else revert InvalidState();
        if (block.timestamp <= deadline) revert DeadlineNotReached();
        data.state = State.CANCELED;
        data.locked = 0;
        emit MatchCanceled(matchId);
        _refund(matchId, record);
    }

    function claimFor(bytes32 matchId, address beneficiary) external override nonReentrant returns (uint256 amount) {
        _knownMatch(matchId);
        amount = _credits[matchId][beneficiary];
        if (amount == 0) return 0;
        _credits[matchId][beneficiary] = 0;
        totalLiability -= amount;
        totalPaid[matchId] += amount;

        // Check both sides: fee-on-transfer/rebasing tokens are deliberately unsupported.
        IERC20 token = IERC20(rewardToken);
        uint256 arenaBefore = token.balanceOf(address(this));
        uint256 receiverBefore = token.balanceOf(beneficiary);
        token.safeTransfer(beneficiary, amount);
        uint256 arenaAfter = token.balanceOf(address(this));
        uint256 receiverAfter = token.balanceOf(beneficiary);
        if (
            arenaAfter > arenaBefore || arenaBefore - arenaAfter != amount || receiverAfter < receiverBefore
                || receiverAfter - receiverBefore != amount
        ) revert InvalidTokenTransfer();
        emit PaymentSent(matchId, beneficiary, amount);
    }

    function getMatch(bytes32 matchId) external view override returns (MatchView memory) {
        return _knownMatch(matchId).data;
    }

    function getRoster(bytes32 matchId) external view override returns (address[] memory) {
        return _knownMatch(matchId).roster;
    }

    function creditOf(bytes32 matchId, address beneficiary) external view override returns (uint256) {
        return _credits[matchId][beneficiary];
    }

    function hashStartAuthorization(StartAuthorization calldata input) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(START_TYPEHASH, input.matchId, input.termsHash, input.validUntil)));
    }

    function hashResultAuthorization(ResultAuthorization calldata input) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESULT_TYPEHASH,
                    input.matchId,
                    input.termsHash,
                    input.outcome,
                    input.winner,
                    input.resultsHash,
                    input.validUntil
                )
            )
        );
    }

    function _termsHash(bytes32 matchId, MatchView storage data) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_VERSION,
                block.chainid,
                address(this),
                matchId,
                data.mode,
                data.rosterHash,
                rewardToken,
                ENTRY,
                FEE_BPS,
                data.feeRecipient,
                data.referee,
                data.rulesHash,
                data.joinDeadline,
                data.startDeadline,
                MAX_PLAY_SECONDS,
                RESULT_GRACE_SECONDS
            )
        );
    }

    function _knownMatch(bytes32 matchId) private view returns (MatchRecord storage record) {
        record = _matches[matchId];
        if (record.data.state == State.NONE) revert UnknownMatch();
    }

    function _participantSlot(address[] storage roster, address participant, uint256 count)
        private
        view
        returns (uint8)
    {
        for (uint8 i; i < count;) {
            if (roster[i] == participant) return i;
            // Roster creation limits this loop to at most six participants.
            unchecked {
                ++i;
            }
        }
        revert NotParticipant();
    }

    function _credit(bytes32 matchId, address beneficiary, uint256 amount) private {
        _credits[matchId][beneficiary] += amount;
        emit PaymentCredited(matchId, beneficiary, amount);
    }

    function _refund(bytes32 matchId, MatchRecord storage record) private {
        uint256 count = record.roster.length;
        uint8 depositMask = record.data.depositMask;
        for (uint8 i; i < count;) {
            if (depositMask & (uint8(1) << i) != 0) _credit(matchId, record.roster[i], ENTRY);
            // Only the bounded counter is unchecked; credit arithmetic stays checked.
            unchecked {
                ++i;
            }
        }
    }

    function _setDefaultOfficials(address referee, address feeRecipient) private {
        if (referee == address(0) || feeRecipient == address(0) || feeRecipient == address(this)) {
            revert InvalidAddress();
        }
        defaultReferee = referee;
        defaultFeeRecipient = feeRecipient;
        emit DefaultOfficialsUpdated(referee, feeRecipient);
    }
}
