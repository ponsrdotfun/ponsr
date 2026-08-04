// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FeeSplitter
/// @notice Immutable fee splitter used as the `feeWallet` on every token launched through the
///         bot. Splits whatever arrives -- ERC20 or ETH -- at a fixed 95/5 ratio between the
///         token's creator and the bot's treasury.
///
/// @dev ⚠️ REWRITTEN 2026-08-04, AND THE REASON MATTERS MORE THAN THE CODE.
///
///      The previous version split **ETH only**, via `receive()`. That was written against an
///      assumption about how pons pays creator fees, and the assumption was wrong.
///
///      The verified pons v1 locker (`PonsLaunchLocker`, source read on 2026-08-04) collects
///      from the launch's Uniswap v3 position and pushes the proceeds out as ERC20:
///
///          _transferIfPositive(token0, recipient, recipientAmount0);
///          _transferIfPositive(token1, recipient, recipientAmount1);
///
///      `token0`/`token1` are the launched token and the pair token (WETH today). Native ETH
///      never enters the picture. The old contract would have accepted those ERC20 transfers
///      -- any address can hold ERC20 -- and then had **no function capable of moving them out
///      again**. Every creator's fees would have accrued here permanently. That is the exact
///      stranded-funds failure the project spec forbade deploying into, and it is why this was
///      blocked pending an answer. The answer arrived by reading the contract.
///
/// @dev DESIGN PRINCIPLES (do not deviate without re-reading Part 8 of the project spec):
///      1. One deployment per launch, with that token's creator baked in at construction.
///         The blast radius of any single deployment is one token's fees.
///      2. The split ratio is immutable. No owner, no admin function, no upgradability. A
///         fixed contract is more trustworthy to creators than an adjustable one; changing
///         the ratio product-wide means deploying a new version for future launches.
///      3. Splitting is permissionless. `splitERC20` and `withdrawERC20` may be called by
///         anyone, because funds can only ever move to the two addresses fixed at
///         construction. Neither party can withhold the other's share by refusing to act.
///      4. One recipient can never block the other. A transfer that fails is credited to a
///         per-token claimable ledger instead of reverting the whole split, so a creator whose
///         wallet is blacklisted by some token cannot freeze the treasury's share, or vice
///         versa. Nothing is ever stranded: what fails to push can always be pulled.
///
/// @dev THE OPERATIONAL FLOW, since this contract is only half of it:
///        1. The bot launches with `feeWallet = address(this)`. The factory records it on the
///           locker as `feeRedirects[token]`.
///        2. Trading fees accrue to the launch's Uniswap v3 position, held by the locker.
///        3. Someone calls `locker.collectFees(token)`. The locker authorises the owner, the
///           deployer (the bot's treasury), the fee recipient (this contract), or a
///           whitelisted collector -- so the treasury can always trigger it.
///        4. The locker pushes token0 and token1 here.
///        5. Anyone calls `splitERC20` for each token. 95% to the creator, 5% to the treasury.
///
/// @dev THIS CONTRACT HAS NOT BEEN PROFESSIONALLY AUDITED. Per the project's Part 11 roadmap
///      it MUST be exercised end-to-end on testnet -- deploy, launch, generate real trading
///      fees, collectFees, split, and confirm 95/5 delivery to both addresses -- before it is
///      used with real funds.
contract FeeSplitter {
    /// @notice Basis points denominator. 10_000 bps = 100%.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Creator's share in basis points. 9_500 = 95%.
    uint256 public constant CREATOR_SHARE_BPS = 9_500;

    /// @notice Bot treasury's share in basis points. 500 = 5%.
    uint256 public constant TREASURY_SHARE_BPS = 500;

    /// @notice Gas forwarded to a plain ETH push. Enough for a simple receive hook, not enough
    ///         to do anything expensive at this contract's expense.
    uint256 private constant ETH_PUSH_GAS = 30_000;

    /// @notice The token creator's wallet -- receives 95% of everything split.
    address public immutable creator;

    /// @notice The bot's treasury wallet -- receives 5% of everything split.
    address public immutable treasury;

    /// @notice The pons token this splitter was deployed for. Bookkeeping only; no on-chain
    ///         logic depends on it. Note fees arrive as BOTH this token and the pair token,
    ///         so `splitERC20` is deliberately not restricted to this address.
    address public immutable token;

    /// @notice ETH that failed to forward and can be pulled with `withdraw()`.
    mapping(address recipient => uint256 amount) public claimable;

    /// @notice ERC20 that failed to forward, per token, pullable with `withdrawERC20`.
    mapping(address erc20 => mapping(address recipient => uint256 amount)) public claimableERC20;

    /// @notice Total ETH ever split by this contract, for off-chain bookkeeping.
    uint256 public totalReceived;

    /// @notice Total of each ERC20 ever split, for off-chain bookkeeping.
    mapping(address erc20 => uint256 amount) public totalReceivedERC20;

    event FeesSplit(uint256 totalAmount, uint256 creatorAmount, uint256 treasuryAmount);
    event ERC20FeesSplit(
        address indexed erc20, uint256 totalAmount, uint256 creatorAmount, uint256 treasuryAmount
    );
    event ForwardFailed(address indexed recipient, uint256 amount);
    event ERC20ForwardFailed(address indexed erc20, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);
    event ERC20Withdrawn(address indexed erc20, address indexed recipient, uint256 amount);

    error ZeroAddress();
    error NothingToSplit();
    error NothingToWithdraw();
    error WithdrawTransferFailed();
    error Reentrant();

    /// @dev Reentrancy mutex. Required, and the reason is specific to how `splitERC20` works:
    ///      it derives the amount from `balanceOf(this)`, and the balance drops the moment the
    ///      first share is transferred out. A token that calls back into `splitERC20` from
    ///      inside its own `transfer` (a hook, or an outright hostile token) would see that
    ///      reduced balance and split it a second time -- paying the first recipient again out
    ///      of the second recipient's money, and leaving a queued claim the contract no longer
    ///      holds the funds to honour. A test caught exactly that before this guard existed.
    uint256 private _entered;

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param _creator The token creator's wallet address. Must not be the zero address.
    /// @param _treasury The bot treasury wallet address. Must not be the zero address.
    /// @param _token The pons token this splitter is associated with (for indexing only).
    constructor(address _creator, address _treasury, address _token) {
        if (_creator == address(0) || _treasury == address(0)) revert ZeroAddress();
        creator = _creator;
        treasury = _treasury;
        token = _token;
    }

    // -------------------------------------------------------------------------
    // ERC20 -- the path pons actually uses
    // -------------------------------------------------------------------------

    /// @notice Splits this contract's entire balance of `erc20` and forwards both shares.
    /// @dev Permissionless by design: the destinations are immutable, so an arbitrary caller
    ///      cannot direct funds anywhere. That also means neither the creator nor the
    ///      treasury needs the other's cooperation to get paid.
    ///
    ///      Operates on the balance rather than on an amount argument because ERC20 arrives by
    ///      a push the recipient is never notified of -- there is no ERC20 equivalent of
    ///      `receive()` to hook, so the balance is the only honest source of truth.
    /// @param erc20 The token to split. Any token, not just `token`: the locker pays fees in
    ///        both the launched token and the pair token.
    /// @return creatorAmount Amount sent to (or queued for) the creator.
    /// @return treasuryAmount Amount sent to (or queued for) the treasury.
    function splitERC20(address erc20)
        external
        nonReentrant
        returns (uint256 creatorAmount, uint256 treasuryAmount)
    {
        if (erc20 == address(0)) revert ZeroAddress();

        uint256 balance = _erc20Balance(erc20);
        // Anything already owed to someone from a previous failed push is not ours to
        // re-split -- it would be counted twice and paid out of the other party's share.
        uint256 owed = claimableERC20[erc20][creator] + claimableERC20[erc20][treasury];
        uint256 amount = balance > owed ? balance - owed : 0;
        if (amount == 0) revert NothingToSplit();

        totalReceivedERC20[erc20] += amount;

        creatorAmount = (amount * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        // The treasury takes the remainder rather than a second independent calculation, so
        // creatorAmount + treasuryAmount == amount exactly, with no dust lost to rounding.
        treasuryAmount = amount - creatorAmount;

        emit ERC20FeesSplit(erc20, amount, creatorAmount, treasuryAmount);

        _forwardERC20OrQueue(erc20, creator, creatorAmount);
        _forwardERC20OrQueue(erc20, treasury, treasuryAmount);
    }

    /// @notice Pulls an ERC20 share that failed to push.
    /// @dev Callable by anyone on behalf of either party -- the funds move to the address that
    ///      was already owed them, never to the caller. That matters when the reason the push
    ///      failed was that the recipient could not pay gas.
    function withdrawERC20(address erc20, address recipient) external nonReentrant {
        uint256 amount = claimableERC20[erc20][recipient];
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: clear the ledger before the external call, so a
        // reentrant token (ERC777-style hooks, or an outright malicious token) sees zero and
        // cannot be paid twice.
        claimableERC20[erc20][recipient] = 0;

        if (!_safeTransfer(erc20, recipient, amount)) {
            revert WithdrawTransferFailed();
        }
        emit ERC20Withdrawn(erc20, recipient, amount);
    }

    // -------------------------------------------------------------------------
    // ETH -- kept for stray transfers, not the path pons uses
    // -------------------------------------------------------------------------

    /// @notice Splits and forwards any ETH sent here.
    /// @dev Retained deliberately even though pons pays fees in ERC20: a contract that cannot
    ///      handle ETH at all would strand anything sent by mistake, and this is the same
    ///      failure mode the ERC20 rewrite exists to fix.
    receive() external payable {
        _splitEth(msg.value);
    }

    /// @notice Claims a previously-failed ETH forward.
    function withdraw() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: zero the ledger before sending, so a reentrant caller
        // sees a zero balance and cannot draw more than it is owed.
        claimable[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert WithdrawTransferFailed();

        emit Withdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _splitEth(uint256 amount) private {
        if (amount == 0) return;

        totalReceived += amount;

        uint256 creatorAmount = (amount * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 treasuryAmount = amount - creatorAmount;

        emit FeesSplit(amount, creatorAmount, treasuryAmount);

        _forwardEthOrQueue(creator, creatorAmount);
        _forwardEthOrQueue(treasury, treasuryAmount);
    }

    function _forwardEthOrQueue(address recipient, uint256 amount) private {
        if (amount == 0) return;

        (bool success, ) = payable(recipient).call{value: amount, gas: ETH_PUSH_GAS}("");
        if (!success) {
            claimable[recipient] += amount;
            emit ForwardFailed(recipient, amount);
        }
    }

    function _forwardERC20OrQueue(address erc20, address recipient, uint256 amount) private {
        if (amount == 0) return;

        if (!_safeTransfer(erc20, recipient, amount)) {
            claimableERC20[erc20][recipient] += amount;
            emit ERC20ForwardFailed(erc20, recipient, amount);
        }
    }

    /// @dev ERC20 transfer that does not revert on failure, and tolerates the tokens that
    ///      return nothing instead of a bool. Returning false rather than reverting is what
    ///      lets one recipient's failure be queued instead of blocking the other's payout.
    function _safeTransfer(address erc20, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) =
            erc20.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok) return false;
        // Empty return data means a non-compliant token that succeeded; a 32-byte return must
        // decode to true.
        return ret.length == 0 || abi.decode(ret, (bool));
    }

    function _erc20Balance(address erc20) private view returns (uint256) {
        (bool ok, bytes memory ret) =
            erc20.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf(address)
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }
}
