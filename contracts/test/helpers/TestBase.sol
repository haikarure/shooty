// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ShootyArena} from "../../src/ShootyArena.sol";
import {IShootyArena} from "../../src/IShootyArena.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function chainId(uint256) external;
    function etch(address, bytes calldata) external;
    function warp(uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectPartialRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function snapshotGasLastCall(string calldata group, string calldata name) external returns (uint256);
}

contract TestToken is ERC20 {
    mapping(address => bool) public blocked;
    bool public skim;
    bool public fail;
    address public attackArena;
    bytes public attackData;
    bool public reentrySucceeded;
    bytes public reentryError;

    constructor() ERC20("Local test USDC", "LOCALUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setSkim(bool value) external {
        skim = value;
    }

    function setFail(bool value) external {
        fail = value;
    }

    function setAttack(address arena, bytes calldata data) external {
        attackArena = arena;
        attackData = data;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (fail) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (fail) return false;
        return super.transferFrom(from, to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(!blocked[to], "recipient blocked");
        if (skim && from != address(0) && to != address(0)) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else {
            super._update(from, to, amount);
        }
        if (attackArena != address(0) && from != address(0)) {
            (reentrySucceeded, reentryError) = attackArena.call(attackData);
        }
    }
}

contract WrongDecimalsToken is ERC20 {
    constructor() ERC20("Wrong", "WRONG") {}
}

contract ContractReferee is IERC1271 {
    address public immutable signer;
    bool public revoked;

    constructor(address signer_) {
        signer = signer_;
    }

    function revoke() external {
        revoked = true;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (!revoked && ECDSA.recover(hash, signature) == signer) return IERC1271.isValidSignature.selector;
        return bytes4(0xffffffff);
    }
}

abstract contract ArenaTestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant REFEREE_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    address internal constant CREATOR = address(0x1001);
    address internal constant PAUSER = address(0x1002);
    address internal constant TREASURY = address(0x1003);
    address internal constant OUTSIDER = address(0x1004);
    bytes32 internal constant ID = keccak256("shooty-match-1");
    bytes32 internal constant RULES = keccak256("shooty-rules-1");
    uint256 internal constant ENTRY = 1_000_000;
    TestToken internal token;
    ShootyArena internal arena;
    address internal referee;

    function setUp() public virtual {
        vm.chainId(10143);
        vm.warp(1_800_000_000);
        referee = vm.addr(REFEREE_KEY);
        token = new TestToken();
        arena = _deploy(address(token), referee, TREASURY);
        for (uint256 i; i < 6; ++i) {
            token.mint(_player(i), 100 * ENTRY);
            vm.prank(_player(i));
            token.approve(address(arena), 100 * ENTRY);
        }
    }

    function _deploy(address token_, address referee_, address treasury_) internal returns (ShootyArena) {
        return new ShootyArena(token_, address(this), CREATOR, PAUSER, referee_, treasury_);
    }

    function _player(uint256 i) internal pure returns (address) {
        return address(uint160(0x2000 + i));
    }

    function _roster(IShootyArena.Mode mode) internal pure returns (address[] memory list) {
        uint256 count = mode == IShootyArena.Mode.DUEL ? 2 : mode == IShootyArena.Mode.TEAM_DUEL ? 6 : 4;
        list = new address[](count);
        for (uint256 i; i < count; ++i) {
            list[i] = _player(i);
        }
    }

    function _input(bytes32 id, IShootyArena.Mode mode) internal view returns (IShootyArena.CreateMatch memory) {
        return IShootyArena.CreateMatch(
            id, mode, _roster(mode), RULES, uint64(block.timestamp + 180), uint64(block.timestamp + 240)
        );
    }

    function _create(bytes32 id, IShootyArena.Mode mode) internal {
        IShootyArena.CreateMatch memory input = _input(id, mode);
        vm.prank(CREATOR);
        arena.createMatch(input);
    }

    function _join(bytes32 id, uint256 slot) internal {
        bytes32 terms = arena.getMatch(id).termsHash;
        vm.prank(_player(slot));
        arena.joinMatch(id, terms);
    }

    function _fund(bytes32 id, IShootyArena.Mode mode) internal {
        _create(id, mode);
        for (uint256 i; i < _roster(mode).length; ++i) {
            _join(id, i);
        }
    }

    function _startInput(bytes32 id) internal view returns (IShootyArena.StartAuthorization memory) {
        IShootyArena.MatchView memory data = arena.getMatch(id);
        return IShootyArena.StartAuthorization(id, data.termsHash, data.startDeadline);
    }

    function _resultInput(bytes32 id, IShootyArena.Outcome outcome, uint8 winner)
        internal
        view
        returns (IShootyArena.ResultAuthorization memory)
    {
        IShootyArena.MatchView memory data = arena.getMatch(id);
        return IShootyArena.ResultAuthorization(
            id, data.termsHash, outcome, winner, keccak256("server-results"), data.resultDeadline
        );
    }

    function _sign(bytes32 digest, uint256 key) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _start(bytes32 id) internal {
        IShootyArena.StartAuthorization memory input = _startInput(id);
        bytes memory sig = _sign(arena.hashStartAuthorization(input), REFEREE_KEY);
        vm.prank(OUTSIDER);
        arena.startMatch(input, sig);
    }

    function _live(bytes32 id, IShootyArena.Mode mode) internal {
        _fund(id, mode);
        _start(id);
    }

    function _resolve(bytes32 id, IShootyArena.Outcome outcome, uint8 winner) internal {
        IShootyArena.ResultAuthorization memory input = _resultInput(id, outcome, winner);
        bytes memory sig = _sign(arena.hashResultAuthorization(input), REFEREE_KEY);
        vm.prank(OUTSIDER);
        arena.resolveMatch(input, sig);
    }

    function _assertState(bytes32 id, IShootyArena.State state) internal view {
        require(arena.getMatch(id).state == state, "wrong state");
    }

    function _assertAccounting(bytes32 id) internal view {
        IShootyArena.MatchView memory data = arena.getMatch(id);
        address[] memory list = arena.getRoster(id);
        uint256 credits = arena.creditOf(id, data.feeRecipient);
        uint256 deposits;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] != data.feeRecipient) credits += arena.creditOf(id, list[i]);
            if (data.depositMask & (uint8(1) << i) != 0) deposits += ENTRY;
        }
        assert(deposits == arena.totalDeposited(id));
        assert(deposits == data.locked + credits + arena.totalPaid(id));
        assert(token.balanceOf(address(arena)) >= arena.totalLiability());
        assert(arena.creditOf(id, OUTSIDER) == 0);
    }
}
