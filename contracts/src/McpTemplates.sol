// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Compile original, unmodified MCP output against the pinned published dependency.
// Neither template implements the Shooty escrow or serves as deployed test USDC.
import {ShootyArenaBase} from "./generated/ShootyArenaBase.sol";
import {ShootyLocalTestToken} from "./generated/ShootyLocalTestToken.sol";
