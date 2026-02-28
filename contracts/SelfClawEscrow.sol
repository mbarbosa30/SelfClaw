// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SelfClawEscrow {
    enum Status { Active, Released, Refunded }

    struct Escrow {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        bytes32 purchaseId;
        Status status;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    address public arbiter;
    address public owner;
    uint256 public escrowCount;

    mapping(uint256 => Escrow) public escrows;
    mapping(bytes32 => bool) public purchaseExists;
    mapping(bytes32 => uint256) public purchaseToEscrow;

    event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed seller, address token, uint256 amount, bytes32 purchaseId);
    event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount);
    event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _arbiter) {
        owner = msg.sender;
        arbiter = _arbiter;
    }

    function createEscrow(address seller, uint256 amount, address token, bytes32 purchaseId) external returns (uint256) {
        require(seller != address(0), "Invalid seller");
        require(amount > 0, "Amount must be > 0");
        require(token != address(0), "Invalid token");
        require(!purchaseExists[purchaseId], "Purchase already escrowed");

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        uint256 escrowId = escrowCount++;
        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            token: token,
            amount: amount,
            purchaseId: purchaseId,
            status: Status.Active,
            createdAt: block.timestamp,
            resolvedAt: 0
        });
        purchaseExists[purchaseId] = true;
        purchaseToEscrow[purchaseId] = escrowId;

        emit EscrowCreated(escrowId, msg.sender, seller, token, amount, purchaseId);
        return escrowId;
    }

    function releaseEscrow(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.amount > 0, "Escrow not found");
        require(e.status == Status.Active, "Escrow not active");
        require(msg.sender == e.buyer || msg.sender == arbiter, "Only buyer or arbiter");

        e.status = Status.Released;
        e.resolvedAt = block.timestamp;

        IERC20(e.token).transfer(e.seller, e.amount);
        emit EscrowReleased(escrowId, e.seller, e.amount);
    }

    function refundEscrow(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.amount > 0, "Escrow not found");
        require(e.status == Status.Active, "Escrow not active");
        require(msg.sender == e.seller || msg.sender == arbiter, "Only seller or arbiter");

        e.status = Status.Refunded;
        e.resolvedAt = block.timestamp;

        IERC20(e.token).transfer(e.buyer, e.amount);
        emit EscrowRefunded(escrowId, e.buyer, e.amount);
    }

    function setArbiter(address _arbiter) external onlyOwner {
        emit ArbiterUpdated(arbiter, _arbiter);
        arbiter = _arbiter;
    }

    function getEscrow(uint256 escrowId) external view returns (
        address buyer, address seller, address token,
        uint256 amount, bytes32 purchaseId, Status status,
        uint256 createdAt, uint256 resolvedAt
    ) {
        Escrow storage e = escrows[escrowId];
        return (e.buyer, e.seller, e.token, e.amount, e.purchaseId, e.status, e.createdAt, e.resolvedAt);
    }

    function getEscrowByPurchase(bytes32 purchaseId) external view returns (uint256) {
        return purchaseToEscrow[purchaseId];
    }
}
