// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeSplitter} from "../FeeSplitter.sol";

/// @notice Test-only contract that rejects all plain ETH transfers, used to exercise
///         FeeSplitter's forward-fail -> claimable -> withdraw() fallback path.
contract RejectsEther {
    // Deliberately no receive()/fallback() -- any plain ETH send to this contract reverts.

    function withdraw(FeeSplitter splitter) external {
        splitter.withdraw();
    }
}

/// @notice Test-only contract that attempts to reenter FeeSplitter.withdraw() during its
///         own receive(), used to prove the checks-effects-interactions ordering in
///         withdraw() prevents double-spending a claimable balance.
contract ReentrantAttacker {
    FeeSplitter public splitter;
    uint256 public reentryAttempts;
    bool public reentryReverted;

    function setSplitter(FeeSplitter _splitter) external {
        splitter = _splitter;
    }

    function attack() external {
        splitter.withdraw();
    }

    receive() external payable {
        reentryAttempts++;
        if (reentryAttempts == 1) {
            // Try to withdraw again mid-transfer, before the outer call has returned.
            try splitter.withdraw() {
                // If this succeeds, the contract has a reentrancy bug.
            } catch {
                reentryReverted = true;
            }
        }
    }
}
