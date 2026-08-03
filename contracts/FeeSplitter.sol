// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FeeSplitter
/// @notice Minimal, immutable fee-splitting contract used as the `feeWallet` on every
///         token launched through the bot. Any ETH sent to this contract (creator trading
///         fees claimed from the Pons locker, or a direct dev-buy allocation) is split at a
///         fixed, hardcoded ratio between the token's creator and the bot's treasury.
///
/// @dev DESIGN PRINCIPLES (do not deviate without re-reading Part 8 of the project spec):
///      1. One deployment per launch. This contract is NOT a shared singleton across all
///         launches — each token gets its own instance, deployed with that token's specific
///         creator address baked in at construction time. This keeps the blast radius of any
///         single deployment limited to one token's fees, and avoids a shared-state contract
///         that every launch depends on.
///      2. Split ratio is immutable. There is no owner, no admin function, no upgradability.
///         Once deployed, the 95/5 split can never be changed. This is a deliberate choice:
///         a fixed contract is more trustworthy to creators than an admin-adjustable one, at
///         the cost of needing a new deployment if the ratio is ever revisited product-wide.
///      3. No custody beyond the pull. ETH does not sit in this contract by design — every
///         inbound transfer immediately triggers a split-and-forward in the same transaction
///         via `receive()`. There is no `withdraw()` function and nothing for a bug to "hold
///         onto" beyond the current transaction's balance.
///      4. Push, not pull, by default -- but pull is available as a safety valve. The
///         `receive()` function attempts to forward funds immediately. If a forward to either
///         recipient fails (e.g. the recipient is a contract that reverts on plain ETH
///         transfer), the failed share is recorded and can be claimed later via `withdraw()`,
///         rather than reverting the whole incoming transaction and stranding funds.
///
/// @dev ⚠️ UPDATE 2026-07-30 — DO NOT USE THIS AS A PONS **v2** FEE RECIPIENT AS WRITTEN.
///      The official v2 docs show trading fees are *credited to a fee escrow*, and the
///      recipient must pull them itself via `claim()` / `claimToken(address)`. This contract
///      can only receive value passively (`receive()`); it cannot call anything. Set as a v2
///      `creatorFeeRecipient`, its fees would accrue in the escrow with no way to withdraw
///      them — stranded permanently. It also has no `transferCreatorFeeRecipient` path, which
///      in v2 is callable only by the current recipient, so the role could never be handed on.
///      Adding a claim path is required before any v2 use. See `docs/pons-v2-findings.md` §3.
///
///      v1 is NOT known to be safe either. The v1 docs say only that "the creator can claim
///      [rewards] at any time" — they name no function and state no caller rule. The
///      `collectFees(token)` detail in this project's spec came from our own earlier research,
///      not from Pons. Whether a contract can hold the v1 fee role and pull its own rewards is
///      an open question that has to be settled against the deployed locker's ABI.
///
/// @dev THIS CONTRACT HAS NOT BEEN PROFESSIONALLY AUDITED. It has been written carefully,
///      commented thoroughly, and is small enough to review in a few minutes, but per the
///      project's own Part 11 roadmap, it MUST be deployed and exercised end-to-end on
///      Robinhood Chain testnet (deploy -> generate trading fees -> collectFees() -> confirm
///      correct 95/5 delivery to both addresses) before it is ever used with real funds.
contract FeeSplitter {
    /// @notice Basis points denominator. 10_000 bps = 100%.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Creator's share in basis points. 9_500 = 95%.
    uint256 public constant CREATOR_SHARE_BPS = 9_500;

    /// @notice Bot treasury's share in basis points. 500 = 5%.
    uint256 public constant TREASURY_SHARE_BPS = 500;

    /// @notice The token creator's wallet -- receives 95% of every inbound transfer.
    address public immutable creator;

    /// @notice The bot's treasury wallet -- receives 5% of every inbound transfer.
    address public immutable treasury;

    /// @notice The Pons token this splitter was deployed for, recorded for off-chain
    ///         indexing/bookkeeping convenience only. Not used in any on-chain logic.
    address public immutable token;

    /// @notice Running ledger of any share that failed to forward immediately and is
    ///         therefore claimable via `withdraw()`.
    mapping(address => uint256) public claimable;

    /// @notice Total ETH ever received by this contract, for off-chain bookkeeping.
    uint256 public totalReceived;

    event FeesSplit(uint256 totalAmount, uint256 creatorAmount, uint256 treasuryAmount);
    event ForwardFailed(address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error NothingToWithdraw();
    error WithdrawTransferFailed();

    /// @param _creator The token creator's wallet address. Must not be the zero address.
    /// @param _treasury The bot treasury wallet address. Must not be the zero address.
    /// @param _token The Pons token address this splitter is associated with (for indexing only).
    constructor(address _creator, address _treasury, address _token) {
        if (_creator == address(0) || _treasury == address(0)) revert ZeroAddress();
        creator = _creator;
        treasury = _treasury;
        token = _token;
    }

    /// @notice Splits and forwards any ETH sent to this contract. Called automatically
    ///         whenever the Pons locker (or anyone else) sends ETH here, e.g. via
    ///         `collectFees(token)`.
    receive() external payable {
        _split(msg.value);
    }

    /// @dev Core split logic, isolated so it always runs identically regardless of caller.
    function _split(uint256 amount) private {
        if (amount == 0) return;

        totalReceived += amount;

        uint256 creatorAmount = (amount * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        // Treasury gets the remainder rather than a second independent calculation,
        // guaranteeing creatorAmount + treasuryAmount == amount exactly (no dust lost
        // to rounding, no possibility of the two calculations drifting apart).
        uint256 treasuryAmount = amount - creatorAmount;

        emit FeesSplit(amount, creatorAmount, treasuryAmount);

        _forwardOrQueue(creator, creatorAmount);
        _forwardOrQueue(treasury, treasuryAmount);
    }

    /// @dev Attempts an immediate push transfer. On failure, credits the amount to the
    ///      recipient's claimable balance instead of reverting the entire split -- so one
    ///      recipient's misbehaving contract can never block the other recipient's payout,
    ///      and never strands funds unrecoverably in this contract.
    function _forwardOrQueue(address recipient, uint256 amount) private {
        if (amount == 0) return;

        (bool success, ) = payable(recipient).call{value: amount, gas: 30_000}("");

        if (!success) {
            claimable[recipient] += amount;
            emit ForwardFailed(recipient, amount);
        }
    }

    /// @notice Claims any previously-failed forward. Safe to call by anyone (funds only ever
    ///         move to the address that was already owed them, never to the caller unless
    ///         the caller *is* that address).
    function withdraw() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: zero out the ledger before sending, so a reentrant
        // call from a malicious `msg.sender` contract sees a zero balance and cannot drain
        // more than it is owed.
        claimable[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert WithdrawTransferFailed();

        emit Withdrawn(msg.sender, amount);
    }
}
