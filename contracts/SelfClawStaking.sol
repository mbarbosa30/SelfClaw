// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SelfClawStaking {
    enum Resolution { Pending, Neutral, Validated, Slashed }

    struct Stake {
        address staker;
        address token;
        uint256 amount;
        bytes32 outputHash;
        Resolution resolution;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    address public resolver;
    address public owner;
    uint256 public stakeCount;

    uint256 public constant REWARD_BPS = 1000;
    uint256 public constant SLASH_BPS = 5000;

    uint256 private _locked;

    mapping(uint256 => Stake) public stakes;
    mapping(address => uint256) public rewardPool;

    event StakeCreated(uint256 indexed stakeId, address indexed staker, address token, uint256 amount, bytes32 outputHash);
    event StakeResolved(uint256 indexed stakeId, Resolution resolution, uint256 rewardOrSlash);
    event RewardPoolFunded(address indexed token, uint256 amount);
    event ResolverUpdated(address indexed oldResolver, address indexed newResolver);

    modifier onlyResolver() {
        require(msg.sender == resolver, "Only resolver");
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

    constructor(address _resolver) {
        owner = msg.sender;
        resolver = _resolver;
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

    function createStake(bytes32 outputHash, uint256 amount, address token) external nonReentrant returns (uint256) {
        require(amount > 0, "Amount must be > 0");
        require(token != address(0), "Invalid token");

        _safeTransferFrom(IERC20(token), msg.sender, address(this), amount);

        uint256 stakeId = stakeCount++;
        stakes[stakeId] = Stake({
            staker: msg.sender,
            token: token,
            amount: amount,
            outputHash: outputHash,
            resolution: Resolution.Pending,
            createdAt: block.timestamp,
            resolvedAt: 0
        });

        emit StakeCreated(stakeId, msg.sender, token, amount, outputHash);
        return stakeId;
    }

    function resolveStake(uint256 stakeId, uint8 resolution) external onlyResolver nonReentrant {
        Stake storage stake = stakes[stakeId];
        require(stake.amount > 0, "Stake not found");
        require(stake.resolution == Resolution.Pending, "Already resolved");
        require(resolution >= 1 && resolution <= 3, "Invalid resolution");

        Resolution res = Resolution(resolution);
        stake.resolution = res;
        stake.resolvedAt = block.timestamp;

        uint256 rewardOrSlash = 0;
        address _token = stake.token;
        address _staker = stake.staker;
        uint256 _amount = stake.amount;

        if (res == Resolution.Neutral) {
            _safeTransfer(IERC20(_token), _staker, _amount);
        } else if (res == Resolution.Validated) {
            uint256 reward = (_amount * REWARD_BPS) / 10000;
            uint256 available = rewardPool[_token];
            if (reward > available) {
                reward = available;
            }
            rewardPool[_token] -= reward;
            rewardOrSlash = reward;
            _safeTransfer(IERC20(_token), _staker, _amount + reward);
        } else if (res == Resolution.Slashed) {
            uint256 slashAmount = (_amount * SLASH_BPS) / 10000;
            rewardOrSlash = slashAmount;
            uint256 returnAmount = _amount - slashAmount;
            rewardPool[_token] += slashAmount;
            if (returnAmount > 0) {
                _safeTransfer(IERC20(_token), _staker, returnAmount);
            }
        }

        emit StakeResolved(stakeId, res, rewardOrSlash);
    }

    function fundRewardPool(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        _safeTransferFrom(IERC20(token), msg.sender, address(this), amount);
        rewardPool[token] += amount;
        emit RewardPoolFunded(token, amount);
    }

    function setResolver(address _resolver) external onlyOwner {
        emit ResolverUpdated(resolver, _resolver);
        resolver = _resolver;
    }

    function getStake(uint256 stakeId) external view returns (
        address staker, address token, uint256 amount,
        bytes32 outputHash, Resolution resolution,
        uint256 createdAt, uint256 resolvedAt
    ) {
        Stake storage s = stakes[stakeId];
        return (s.staker, s.token, s.amount, s.outputHash, s.resolution, s.createdAt, s.resolvedAt);
    }

    function getRewardPoolBalance(address token) external view returns (uint256) {
        return rewardPool[token];
    }
}
