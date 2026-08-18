// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A stand-in for `PonsV2FeeEscrow`, matching the behaviour that actually matters.
///
/// @dev Modelled on the verified source, not on a convenient simplification. Three properties
///      are reproduced deliberately, because each one is a way `FeeSplitterV2` could be wrong:
///
///        1. `claimToken` pays **`msg.sender`**, never a stored owner or a passed recipient.
///           This is the whole reason FeeSplitterV2 exists: a splitter that cannot call the
///           escrow itself can never be paid, no matter who else wants to help it.
///        2. Claiming debits a per-(recipient, token) ledger, so claiming twice pays once.
///        3. A partial claim is a first-class operation, because the real escrow warns that a
///           full-balance claim can revert against a quote asset with a per-transfer cap.
interface IMockERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MockEscrow {
    mapping(address => mapping(address => uint256)) private _tokenBalances;
    mapping(address => uint256) private _balances;

    error NoBalance();
    error InsufficientBalance(uint256 requested, uint256 available);

    /// @notice Credits `recipient` with tokens pulled from the caller, as the real escrow does.
    function creditToken(address recipient, address token, uint256 amount) external {
        IMockERC20(token).transferFrom(msg.sender, address(this), amount);
        _tokenBalances[recipient][token] += amount;
    }

    /// @notice Credits `recipient` with native ETH.
    function credit(address recipient) external payable {
        _balances[recipient] += msg.value;
    }

    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return _tokenBalances[recipient][token];
    }

    function balanceOf(address recipient) external view returns (uint256) {
        return _balances[recipient];
    }

    function claimToken(address token) external returns (uint256) {
        return _claimToken(token, _tokenBalances[msg.sender][token]);
    }

    function claimToken(address token, uint256 amount) external returns (uint256) {
        return _claimToken(token, amount);
    }

    function claim() external returns (uint256) {
        return _claim(_balances[msg.sender]);
    }

    function claim(uint256 amount) external returns (uint256) {
        return _claim(amount);
    }

    function _claimToken(address token, uint256 amount) private returns (uint256) {
        if (amount == 0) revert NoBalance();
        uint256 balance = _tokenBalances[msg.sender][token];
        if (amount > balance) revert InsufficientBalance(amount, balance);
        _tokenBalances[msg.sender][token] = balance - amount;
        IMockERC20(token).transfer(msg.sender, amount);
        return amount;
    }

    function _claim(uint256 amount) private returns (uint256) {
        if (amount == 0) revert NoBalance();
        uint256 balance = _balances[msg.sender];
        if (amount > balance) revert InsufficientBalance(amount, balance);
        _balances[msg.sender] = balance - amount;
        (bool ok, ) = msg.sender.call{value: amount}('');
        require(ok, 'eth send failed');
        return amount;
    }
}
