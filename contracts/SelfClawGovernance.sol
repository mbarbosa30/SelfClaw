// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SelfClawGovernance {
    enum ProposalStatus { Active, Passed, Failed, Executed }

    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 unstakeRequestedAt;
        uint256 unstakeAmount;
    }

    struct Proposal {
        uint256 id;
        address creator;
        string title;
        string description;
        ProposalStatus status;
        uint256 votingStartsAt;
        uint256 votingEndsAt;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 quorumRequired;
    }

    address public owner;
    address public token;
    uint256 public proposalCount;
    uint256 public cooldownPeriod;
    uint256 public minStakeForProposal;
    uint256 public quorumPercentage;
    uint256 public totalStaked;

    uint256 private _locked;

    uint256 public constant TIME_WEIGHT_CAP_DAYS = 90;
    uint256 public constant MAX_MULTIPLIER = 2;

    mapping(address => StakeInfo) public stakers;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event Staked(address indexed staker, uint256 amount, uint256 totalStaked);
    event UnstakeRequested(address indexed staker, uint256 amount, uint256 availableAt);
    event Unstaked(address indexed staker, uint256 amount);
    event ProposalCreated(uint256 indexed proposalId, address indexed creator, string title, uint256 votingEndsAt);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 votingPower);
    event ProposalExecuted(uint256 indexed proposalId, ProposalStatus status);
    event CooldownPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event MinStakeForProposalUpdated(uint256 oldMin, uint256 newMin);
    event QuorumPercentageUpdated(uint256 oldQuorum, uint256 newQuorum);

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

    constructor(address _token) {
        require(_token != address(0), "Invalid token");
        owner = msg.sender;
        token = _token;
        cooldownPeriod = 7 days;
        minStakeForProposal = 1000 * 1e18;
        quorumPercentage = 10;
    }

    function _safeTransfer(IERC20 _token, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(_token).call(
            abi.encodeWithSelector(_token.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function _safeTransferFrom(IERC20 _token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(_token).call(
            abi.encodeWithSelector(_token.transferFrom.selector, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferFrom failed");
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");

        _safeTransferFrom(IERC20(token), msg.sender, address(this), amount);

        StakeInfo storage info = stakers[msg.sender];
        if (info.amount == 0) {
            info.stakedAt = block.timestamp;
        } else {
            uint256 totalAmount = info.amount + amount;
            info.stakedAt = (info.stakedAt * info.amount + block.timestamp * amount) / totalAmount;
        }
        info.amount += amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount, info.amount);
    }

    function requestUnstake(uint256 amount) external {
        StakeInfo storage info = stakers[msg.sender];
        require(info.amount >= amount, "Insufficient stake");
        require(amount > 0, "Amount must be > 0");

        info.unstakeRequestedAt = block.timestamp;
        info.unstakeAmount = amount;

        emit UnstakeRequested(msg.sender, amount, block.timestamp + cooldownPeriod);
    }

    function unstake(uint256 amount) external nonReentrant {
        StakeInfo storage info = stakers[msg.sender];
        require(info.unstakeAmount >= amount, "Amount exceeds requested unstake");
        require(info.unstakeRequestedAt > 0, "No unstake requested");
        require(block.timestamp >= info.unstakeRequestedAt + cooldownPeriod, "Cooldown not elapsed");

        info.amount -= amount;
        info.unstakeAmount -= amount;
        if (info.unstakeAmount == 0) {
            info.unstakeRequestedAt = 0;
        }
        totalStaked -= amount;

        _safeTransfer(IERC20(token), msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    function getStake(address staker) external view returns (
        uint256 amount,
        uint256 stakedAt,
        uint256 unstakeRequestedAt,
        uint256 unstakeAmount
    ) {
        StakeInfo storage info = stakers[staker];
        return (info.amount, info.stakedAt, info.unstakeRequestedAt, info.unstakeAmount);
    }

    function getVotingPower(address staker) public view returns (uint256) {
        StakeInfo storage info = stakers[staker];
        if (info.amount == 0) return 0;

        uint256 stakedDays = (block.timestamp - info.stakedAt) / 1 days;
        if (stakedDays > TIME_WEIGHT_CAP_DAYS) {
            stakedDays = TIME_WEIGHT_CAP_DAYS;
        }

        uint256 multiplierBps = 10000 + (stakedDays * 10000) / TIME_WEIGHT_CAP_DAYS;
        if (multiplierBps > MAX_MULTIPLIER * 10000) {
            multiplierBps = MAX_MULTIPLIER * 10000;
        }

        return (info.amount * multiplierBps) / 10000;
    }

    function createProposal(
        string calldata title,
        string calldata description,
        uint256 votingPeriod
    ) external returns (uint256) {
        require(bytes(title).length > 0, "Title required");
        require(votingPeriod >= 1 days, "Voting period too short");
        require(votingPeriod <= 30 days, "Voting period too long");

        StakeInfo storage info = stakers[msg.sender];
        require(info.amount >= minStakeForProposal, "Insufficient stake for proposal");

        uint256 quorum = (totalStaked * quorumPercentage) / 100;

        uint256 proposalId = proposalCount++;
        proposals[proposalId] = Proposal({
            id: proposalId,
            creator: msg.sender,
            title: title,
            description: description,
            status: ProposalStatus.Active,
            votingStartsAt: block.timestamp,
            votingEndsAt: block.timestamp + votingPeriod,
            forVotes: 0,
            againstVotes: 0,
            quorumRequired: quorum
        });

        emit ProposalCreated(proposalId, msg.sender, title, block.timestamp + votingPeriod);
        return proposalId;
    }

    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        require(p.votingEndsAt > 0, "Proposal not found");
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(block.timestamp <= p.votingEndsAt, "Voting ended");
        require(!hasVoted[proposalId][msg.sender], "Already voted");

        uint256 power = getVotingPower(msg.sender);
        require(power > 0, "No voting power");

        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            p.forVotes += power;
        } else {
            p.againstVotes += power;
        }

        emit VoteCast(proposalId, msg.sender, support, power);
    }

    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.votingEndsAt > 0, "Proposal not found");
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(block.timestamp > p.votingEndsAt, "Voting not ended");

        uint256 totalVotes = p.forVotes + p.againstVotes;

        if (totalVotes >= p.quorumRequired && p.forVotes > p.againstVotes) {
            p.status = ProposalStatus.Passed;
        } else {
            p.status = ProposalStatus.Failed;
        }

        emit ProposalExecuted(proposalId, p.status);
    }

    function setCooldownPeriod(uint256 _cooldownPeriod) external onlyOwner {
        require(_cooldownPeriod >= 1 days, "Cooldown too short");
        emit CooldownPeriodUpdated(cooldownPeriod, _cooldownPeriod);
        cooldownPeriod = _cooldownPeriod;
    }

    function setMinStakeForProposal(uint256 _minStake) external onlyOwner {
        emit MinStakeForProposalUpdated(minStakeForProposal, _minStake);
        minStakeForProposal = _minStake;
    }

    function setQuorumPercentage(uint256 _quorum) external onlyOwner {
        require(_quorum > 0 && _quorum <= 100, "Invalid quorum");
        emit QuorumPercentageUpdated(quorumPercentage, _quorum);
        quorumPercentage = _quorum;
    }

    function getProposal(uint256 proposalId) external view returns (
        uint256 id,
        address creator,
        string memory title,
        string memory description,
        ProposalStatus status,
        uint256 votingStartsAt,
        uint256 votingEndsAt,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 quorumRequired
    ) {
        Proposal storage p = proposals[proposalId];
        return (
            p.id, p.creator, p.title, p.description,
            p.status, p.votingStartsAt, p.votingEndsAt,
            p.forVotes, p.againstVotes, p.quorumRequired
        );
    }
}
