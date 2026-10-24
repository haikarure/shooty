// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Fixed-entry escrow for referee-authorized Shooty matches on Monad Testnet.
interface IShootyArena {
    enum Mode {
        DUEL,
        TEAM_DUEL,
        RUMBLE
    }
    enum State {
        NONE,
        OPEN,
        FUNDED,
        LIVE,
        RESOLVED,
        CANCELED
    }
    enum Outcome {
        WIN,
        DRAW
    }

    struct CreateMatch {
        bytes32 matchId;
        Mode mode;
        address[] roster;
        bytes32 rulesHash;
        uint64 joinDeadline;
        uint64 startDeadline;
    }

    struct StartAuthorization {
        bytes32 matchId;
        bytes32 termsHash;
        uint64 validUntil;
    }

    struct ResultAuthorization {
        bytes32 matchId;
        bytes32 termsHash;
        Outcome outcome;
        // Team index 0/1 for TEAM_DUEL; roster index for DUEL/RUMBLE.
        // Must be zero for DRAW; it is ignored for refund allocation.
        uint8 winner;
        bytes32 resultsHash;
        uint64 validUntil;
    }

    struct MatchView {
        Mode mode;
        State state;
        bytes32 rosterHash;
        bytes32 rulesHash;
        bytes32 termsHash;
        address referee;
        address feeRecipient;
        uint64 joinDeadline;
        uint64 startDeadline;
        uint64 resultDeadline;
        uint8 depositMask;
        uint256 locked;
    }

    event MatchCreated(bytes32 indexed matchId, Mode indexed mode, bytes32 termsHash, bytes32 rosterHash);
    event PlayerDeposited(bytes32 indexed matchId, address indexed player, uint8 slot, uint256 amount);
    event MatchFunded(bytes32 indexed matchId, uint256 pool);
    event MatchStarted(bytes32 indexed matchId, uint64 resultDeadline);
    event MatchResolved(bytes32 indexed matchId, Outcome outcome, uint8 winner, bytes32 resultsHash);
    event MatchCanceled(bytes32 indexed matchId);
    event PaymentCredited(bytes32 indexed matchId, address indexed beneficiary, uint256 amount);
    event PaymentSent(bytes32 indexed matchId, address indexed beneficiary, uint256 amount);

    error WrongChain();
    error InvalidRoster();
    error UnknownMatch();
    error InvalidState();
    error TermsMismatch();
    error NotParticipant();
    error AlreadyDeposited();
    error DeadlinePassed();
    error DeadlineNotReached();
    error InvalidSignature();
    error InvalidWinner();
    error InvalidTokenTransfer();

    function createMatch(CreateMatch calldata input) external;
    // Participant sends this transaction; it consents to the frozen terms and readiness.
    function joinMatch(bytes32 matchId, bytes32 expectedTermsHash) external;
    function startMatch(StartAuthorization calldata input, bytes calldata refereeSignature) external;
    // Records liabilities; it does not claim that token transfers have already happened.
    function resolveMatch(ResultAuthorization calldata input, bytes calldata refereeSignature) external;
    // Permissionless timeout transition; deposits become refund credits.
    function expireMatch(bytes32 matchId) external;
    // Permissionless trigger; receiver is always beneficiary, never msg.sender by default.
    function claimFor(bytes32 matchId, address beneficiary) external returns (uint256 amount);
    function getMatch(bytes32 matchId) external view returns (MatchView memory);
    function getRoster(bytes32 matchId) external view returns (address[] memory);
    function creditOf(bytes32 matchId, address beneficiary) external view returns (uint256);
    function totalLiability() external view returns (uint256);
    function rewardToken() external view returns (address);
}
