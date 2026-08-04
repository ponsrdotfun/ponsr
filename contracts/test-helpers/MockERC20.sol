// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeSplitter} from "../FeeSplitter.sol";

/// @notice Minimal ERC20 for exercising FeeSplitter's ERC20 path. Deliberately hand-written
///         rather than pulled from a library: the splitter must cope with whatever token pons
///         happens to pay fees in, and the variants below are the ones that actually break
///         naive splitters.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Addresses this token refuses to send to. Real tokens do this (blacklists,
    ///         transfer hooks); the splitter must not let one blocked recipient freeze the
    ///         other's share.
    mapping(address => bool) public blocked;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[to], "recipient blocked");
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @notice An ERC20 whose `transfer` returns no data at all -- the USDT-style non-compliance
///         that breaks any splitter using `abi.decode(ret, (bool))` unconditionally.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    /// @dev No `returns (bool)`, on purpose.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice An ERC20 whose `transfer` reports failure by returning false instead of reverting.
///         A splitter that ignores the return value would count these as paid and lose them.
contract FalseReturnERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice Reenters `splitERC20` from inside its own transfer, to prove a second split cannot
///         pay the same balance twice.
contract ReentrantERC20 {
    mapping(address => uint256) public balanceOf;
    FeeSplitter public splitter;
    uint256 public reentryAttempts;
    bool public reentryReverted;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setSplitter(FeeSplitter _splitter) external {
        splitter = _splitter;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (reentryAttempts == 0 && address(splitter) != address(0)) {
            reentryAttempts++;
            try splitter.splitERC20(address(this)) {
                // Succeeding here would mean the same balance was split twice.
            } catch {
                reentryReverted = true;
            }
        }
        return true;
    }
}
