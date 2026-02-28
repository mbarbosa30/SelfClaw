// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SelfClawRewards {
    address public distributor;
    address public owner;
    address public rewardToken;
    uint256 public poolBalance;

    uint256 private _locked;

    mapping(bytes32 => bool) public distributed;
    mapping(bytes32 => address) public pendingClaims;
    mapping(bytes32 => uint256) public pendingAmounts;

    event PoolFunded(address indexed funder, uint256 amount);
    event RewardDistributed(bytes32 indexed referralId, address indexed recipient, uint256 amount);
    event RewardQueued(bytes32 indexed referralId, address indexed recipient, uint256 amount);
    event RewardClaimed(bytes32 indexed referralId, address indexed recipient, uint256 amount);
    event DistributorUpdated(address indexed oldDistributor, address indexed newDistributor);

    modifier onlyDistributor() {
        require(msg.sender == distributor, "Only distributor");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 0, "Reentrancy");
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address _distributor, address _rewardToken) {
        owner = msg.sender;
        distributor = _distributor;
        rewardToken = _rewardToken;
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transferFrom.selector, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferFrom failed");
    }

    function fundPool(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        _safeTransferFrom(IERC20(rewardToken), msg.sender, address(this), amount);
        poolBalance += amount;
        emit PoolFunded(msg.sender, amount);
    }

    function distributeReward(address recipient, uint256 amount, bytes32 referralId) external onlyDistributor nonReentrant {
        require(!distributed[referralId], "Already distributed");
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");

        distributed[referralId] = true;

        if (poolBalance >= amount) {
            poolBalance -= amount;
            _safeTransfer(IERC20(rewardToken), recipient, amount);
            emit RewardDistributed(referralId, recipient, amount);
        } else {
            pendingClaims[referralId] = recipient;
            pendingAmounts[referralId] = amount;
            emit RewardQueued(referralId, recipient, amount);
        }
    }

    function claimReward(bytes32 referralId) external nonReentrant {
        address recipient = pendingClaims[referralId];
        require(recipient != address(0), "No pending claim");
        require(msg.sender == recipient || msg.sender == distributor, "Not authorized");

        uint256 amount = pendingAmounts[referralId];
        require(poolBalance >= amount, "Insufficient pool balance");

        poolBalance -= amount;
        delete pendingClaims[referralId];
        delete pendingAmounts[referralId];

        _safeTransfer(IERC20(rewardToken), recipient, amount);
        emit RewardClaimed(referralId, recipient, amount);
    }

    function setDistributor(address _distributor) external onlyOwner {
        emit DistributorUpdated(distributor, _distributor);
        distributor = _distributor;
    }

    function getPoolBalance() external view returns (uint256) {
        return poolBalance;
    }

    function isDistributed(bytes32 referralId) external view returns (bool) {
        return distributed[referralId];
    }

    function getPendingClaim(bytes32 referralId) external view returns (address recipient, uint256 amount) {
        return (pendingClaims[referralId], pendingAmounts[referralId]);
    }
}
