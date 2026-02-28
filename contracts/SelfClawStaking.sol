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

    constructor(address _resolver) {
        owner = msg.sender;
        resolver = _resolver;
    }

    function createStake(bytes32 outputHash, uint256 amount, address token) external returns (uint256) {
        require(amount > 0, "Amount must be > 0");
        require(token != address(0), "Invalid token");

        IERC20(token).transferFrom(msg.sender, address(this), amount);

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

    function resolveStake(uint256 stakeId, uint8 resolution) external onlyResolver {
        Stake storage stake = stakes[stakeId];
        require(stake.amount > 0, "Stake not found");
        require(stake.resolution == Resolution.Pending, "Already resolved");
        require(resolution >= 1 && resolution <= 3, "Invalid resolution");

        Resolution res = Resolution(resolution);
        stake.resolution = res;
        stake.resolvedAt = block.timestamp;

        uint256 rewardOrSlash = 0;

        if (res == Resolution.Neutral) {
            IERC20(stake.token).transfer(stake.staker, stake.amount);
        } else if (res == Resolution.Validated) {
            uint256 reward = (stake.amount * REWARD_BPS) / 10000;
            uint256 available = rewardPool[stake.token];
            if (reward > available) {
                reward = available;
            }
            rewardPool[stake.token] -= reward;
            rewardOrSlash = reward;
            IERC20(stake.token).transfer(stake.staker, stake.amount + reward);
        } else if (res == Resolution.Slashed) {
            uint256 slashAmount = (stake.amount * SLASH_BPS) / 10000;
            rewardOrSlash = slashAmount;
            uint256 returnAmount = stake.amount - slashAmount;
            rewardPool[stake.token] += slashAmount;
            if (returnAmount > 0) {
                IERC20(stake.token).transfer(stake.staker, returnAmount);
            }
        }

        emit StakeResolved(stakeId, res, rewardOrSlash);
    }

    function fundRewardPool(address token, uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        IERC20(token).transferFrom(msg.sender, address(this), amount);
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
