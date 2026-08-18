// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./FeeSplitter.sol";

/// @title FeeSplitterV2
/// @notice The fee splitter for launches made through the pons **v2** factory. Same immutable
///         95/5 split as `FeeSplitter`, plus the one thing v2 requires and v1 does not: the
///         ability to pull its own fees out of pons's escrow.
///
/// @dev ⚠️ WITHOUT THIS, EVERY CREATOR FEE ON V2 WOULD BE STRANDED. This is not a theoretical
///      hardening; it is the same failure this project already shipped once, arriving by a
///      different route.
///
///      v1 **pushes**. The locker collects from the Uniswap position and transfers the
///      proceeds straight to `feeRedirects[token]`, so a plain contract that can move ERC20
///      out again is sufficient — which is exactly what `FeeSplitter` is.
///
///      v2 **credits**. Fees accumulate inside `PonsV2FeeEscrow` against the recipient's
///      address, and the recipient collects them by calling:
///
///          function claimToken(address token) external returns (uint256);   // pays msg.sender
///
///      Read that signature carefully: it pays **`msg.sender`**. There is no `claimFor`, and
///      no way for the treasury or anyone else to claim on another address's behalf. So if a
///      v2 launch names a plain `FeeSplitter` as `creatorFeeRecipient`, the escrow will credit
///      it correctly and forever, and **no transaction exists that can ever move those fees**.
///      The contract has no function that calls the escrow. The money is visible, attributed,
///      and permanently unreachable.
///
///      That is precisely the shape of the 2026-08-04 incident recorded in the project notes:
///      a splitter deployed against an assumption about how fees arrive, discovered only after
///      real money was already behind it. The assumption was wrong then in the other
///      direction — ETH versus ERC20 — and the lesson generalises: **verify how the money
///      actually moves before deploying the thing that is supposed to receive it.**
///
/// @dev WHAT IS INHERITED, AND WHY NOTHING IS RESTATED
///      Everything about splitting — the fixed 95/5, the per-token claimable ledger so one
///      recipient can never block the other, the reentrancy guard that a test caught the need
///      for — comes from `FeeSplitter` unchanged. Copying it here would create a second
///      version to keep in step, and a hand-maintained second copy going stale is the exact
///      mistake that stranded the first launch's fees.
///
/// @dev PARTIAL CLAIMS ARE NOT AN OPTIONAL EXTRA. The escrow's own documentation is explicit:
///      `creditToken` is permissionless, a recipient's balance aggregates credits from every
///      launch and hook, and against a quote asset with a per-transfer cap a full-balance
///      claim can revert — leaving the recipient unable to draw any of it. So the amount-taking
///      form is exposed too, and the full-balance form is a convenience over it rather than
///      the only way in.
///
/// @dev THIS CONTRACT HAS NOT BEEN PROFESSIONALLY AUDITED, and unlike `FeeSplitter` it has not
///      yet been exercised against a real launch — pons has launching switched off on both
///      factories, so no v2 launch can be made by anyone. It must be run end to end on a real
///      launch before it is trusted with a creator's money. A rehearsal that skips the
///      production path proves less than it looks.
interface IPonsV2FeeEscrow {
    function claim() external returns (uint256);
    function claim(uint256 amount) external returns (uint256);
    function claimToken(address token) external returns (uint256);
    function claimToken(address token, uint256 amount) external returns (uint256);
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

contract FeeSplitterV2 is FeeSplitter {
    /// @notice pons's v2 fee escrow. Immutable: a splitter that could be repointed at another
    ///         contract would be a splitter whose fees could be redirected after the fact.
    address public immutable escrow;

    event EscrowClaimed(address indexed erc20, uint256 amount);
    event EscrowClaimedEth(uint256 amount);

    error EscrowClaimFailed();
    error NothingToClaim();

    /// @param _creator The token creator's wallet. Receives 95%.
    /// @param _treasury The bot treasury wallet. Receives 5%.
    /// @param _token The pons token this splitter is associated with (indexing only).
    /// @param _escrow The `PonsV2FeeEscrow` this launch's fees are credited to.
    constructor(address _creator, address _treasury, address _token, address _escrow)
        FeeSplitter(_creator, _treasury, _token)
    {
        if (_escrow == address(0)) revert ZeroAddress();
        escrow = _escrow;
    }

    // -------------------------------------------------------------------------
    // Pulling from the escrow
    // -------------------------------------------------------------------------

    /// @notice How much of `erc20` this splitter can currently claim from the escrow.
    /// @dev A view, so an operator can see money exists before spending gas trying to move it.
    function claimableFromEscrow(address erc20) external view returns (uint256) {
        return IPonsV2FeeEscrow(escrow).balanceOfToken(address(this), erc20);
    }

    /// @notice Claims this splitter's entire escrow balance of `erc20` and splits it.
    /// @dev Permissionless, like every other movement here: the destinations are fixed at
    ///      construction, so an arbitrary caller cannot direct funds anywhere. That is what
    ///      stops either party needing the other's cooperation to be paid.
    /// @return claimed The amount pulled out of the escrow.
    function claimAndSplit(address erc20) external returns (uint256 claimed) {
        uint256 available = IPonsV2FeeEscrow(escrow).balanceOfToken(address(this), erc20);
        if (available == 0) revert NothingToClaim();
        return _claimAndSplit(erc20, available);
    }

    /// @notice Claims `amount` of `erc20` from the escrow and splits it.
    /// @dev Exists because a full-balance claim is not always possible — see the contract
    ///      header. A quote asset with a per-transfer cap would make the convenience form
    ///      revert, and without this the fees behind it would be unreachable in practice even
    ///      though the escrow says they are there.
    function claimAndSplit(address erc20, uint256 amount) external returns (uint256 claimed) {
        if (amount == 0) revert NothingToClaim();
        return _claimAndSplit(erc20, amount);
    }

    /// @notice Claims this splitter's native ETH balance from the escrow and splits it.
    /// @dev The escrow has a native side and a launch paired against native ETH uses it.
    ///      Retained for the same reason `FeeSplitter.withdraw()` is: a contract that cannot
    ///      move a kind of money it can receive is a contract that strands it.
    function claimEthAndSplit() external returns (uint256 claimed) {
        uint256 available = IPonsV2FeeEscrow(escrow).balanceOf(address(this));
        if (available == 0) revert NothingToClaim();

        // No split call follows, and that is not an omission. The escrow pays ETH by a
        // plain transfer, which lands in the inherited `receive()`, and `receive()` splits
        // `msg.value` inline. The money is already 95/5 before `claim()` returns.
        //
        // For the same reason the amount cannot be measured as a balance delta the way the
        // ERC20 path does: by the time this line runs the ETH has been forwarded out again,
        // so the delta would read zero on a claim that worked perfectly.
        claimed = IPonsV2FeeEscrow(escrow).claim();
        if (claimed == 0) revert EscrowClaimFailed();
        emit EscrowClaimedEth(claimed);
        return claimed;
    }

    function _claimAndSplit(address erc20, uint256 amount) private returns (uint256 claimed) {
        uint256 before = _balanceOfSelf(erc20);
        IPonsV2FeeEscrow(escrow).claimToken(erc20, amount);
        claimed = _balanceOfSelf(erc20) - before;
        if (claimed == 0) revert EscrowClaimFailed();
        emit EscrowClaimed(erc20, claimed);

        // Split through the inherited path rather than reimplementing it. `splitERC20`
        // operates on the full balance, which is right: a claim that lands on top of an
        // earlier unsplit push should move both, not strand the older one.
        this.splitERC20(erc20);
        return claimed;
    }

    function _balanceOfSelf(address erc20) private view returns (uint256) {
        (bool ok, bytes memory data) =
            erc20.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert EscrowClaimFailed();
        return abi.decode(data, (uint256));
    }
}
