// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title DAORegistryAnchor
 * @notice Records canonical-hash anchors for NH DAO Registry DID document
 *         versions. One anchor per (registryId, version) pair.
 *
 * @dev    Each anchor records `keccak256(registryId)` (so registry IDs of
 *         arbitrary length compress into a uint256 key), the integer version,
 *         the SHA-256 content hash of the canonicalized DID document
 *         (without proof and anchors), and the kind of document being
 *         anchored (DAO or AGENT).
 *
 *         Reads are public. Writes are restricted to the owner, which in the
 *         POC is the SoS-controlled controller key. Production deployments
 *         can extend this with role-based access (e.g. multisig + timelock)
 *         without changing the on-chain anchor schema.
 */
contract DAORegistryAnchor {
    enum DocKind { DAO, AGENT }

    struct Anchor {
        bytes32 registryIdHash;
        uint32  version;
        DocKind kind;
        bytes32 contentHash;     // sha256 of canonicalize(didDocument - proof - anchors)
        uint64  anchoredAt;      // block.timestamp at anchor time
    }

    address public owner;
    address public pendingOwner;

    // registryIdHash => kind => version => Anchor
    mapping(bytes32 => mapping(uint8 => mapping(uint32 => Anchor))) private _anchors;

    // registryIdHash => kind => latest version (0 means none)
    mapping(bytes32 => mapping(uint8 => uint32)) public latestVersion;

    /**
     * @dev `contentHash` is indexed so that off-chain indexers can subscribe
     *      to a specific document hash without filtering through every event.
     *      `anchoredAt` and the original `registryId` (string) remain in the
     *      data section.
     */
    event Anchored(
        bytes32 indexed registryIdHash,
        DocKind indexed kind,
        bytes32 indexed contentHash,
        uint32  version,
        uint64  anchoredAt,
        string  registryId
    );

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "DAORegistryAnchor: not owner");
        _;
    }

    constructor(address initialOwner) {
        require(initialOwner != address(0), "DAORegistryAnchor: zero owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /**
     * @notice Begin a two-step ownership transfer. The new owner must call
     *         `acceptOwnership` to complete the transfer. This guards against
     *         setting ownership to an address that cannot sign (e.g. typo'd
     *         address, multisig that has not been deployed yet).
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "DAORegistryAnchor: zero owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /**
     * @notice Complete a two-step ownership transfer. Must be called by the
     *         pending owner. Production deployments should set the pending
     *         owner to a Gnosis Safe (or equivalent multisig + timelock).
     */
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "DAORegistryAnchor: not pending owner");
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /**
     * @notice Cancel a pending ownership transfer. Only the current owner can.
     */
    function cancelOwnershipTransfer() external onlyOwner {
        pendingOwner = address(0);
    }

    /**
     * @notice Record an anchor for a given (registryId, kind, version).
     * @dev    Versions must be strictly increasing per (registryId, kind).
     *         Re-anchoring an existing version reverts; this enforces the
     *         "one anchor per document version" invariant.
     */
    function anchor(
        string  calldata registryId,
        DocKind kind,
        uint32  version,
        bytes32 contentHash
    ) external onlyOwner returns (bytes32) {
        require(bytes(registryId).length > 0, "DAORegistryAnchor: empty registryId");
        require(version > 0, "DAORegistryAnchor: version must be >= 1");
        require(contentHash != bytes32(0), "DAORegistryAnchor: zero hash");

        bytes32 idHash = keccak256(bytes(registryId));
        uint8   kindIdx = uint8(kind);

        require(
            _anchors[idHash][kindIdx][version].contentHash == bytes32(0),
            "DAORegistryAnchor: version already anchored"
        );
        require(
            version == latestVersion[idHash][kindIdx] + 1,
            "DAORegistryAnchor: non-sequential version"
        );

        _anchors[idHash][kindIdx][version] = Anchor({
            registryIdHash: idHash,
            version:        version,
            kind:           kind,
            contentHash:    contentHash,
            anchoredAt:     uint64(block.timestamp)
        });
        latestVersion[idHash][kindIdx] = version;

        emit Anchored(idHash, kind, contentHash, version, uint64(block.timestamp), registryId);
        return idHash;
    }

    function getAnchor(string calldata registryId, DocKind kind, uint32 version)
        external view returns (Anchor memory)
    {
        return _anchors[keccak256(bytes(registryId))][uint8(kind)][version];
    }

    /**
     * @notice Returns the latest anchor for (registryId, kind). Reverts if
     *         no anchor has been recorded. Callers that need to distinguish
     *         "missing" from "recorded with all-zero fields" should use this.
     */
    function getLatest(string calldata registryId, DocKind kind)
        external view returns (Anchor memory)
    {
        bytes32 idHash = keccak256(bytes(registryId));
        uint8   kindIdx = uint8(kind);
        uint32  v = latestVersion[idHash][kindIdx];
        require(v > 0, "DAORegistryAnchor: no anchor");
        return _anchors[idHash][kindIdx][v];
    }

    /**
     * @notice Returns true if at least one anchor has been recorded for
     *         (registryId, kind). Cheaper for callers that only need a
     *         presence check, and avoids the revert from getLatest.
     */
    function hasAnchor(string calldata registryId, DocKind kind) external view returns (bool) {
        return latestVersion[keccak256(bytes(registryId))][uint8(kind)] > 0;
    }
}
