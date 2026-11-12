// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ConsentRegistry
/// @notice DataVault's on-chain consent ledger. Data owners register encrypted
///         data records and grant, modify and revoke consents for requesters.
///         Every change is an event, so the full audit trail can be rebuilt
///         from the chain alone.
/// @dev    PRIVACY: no personal data is ever stored here. A data record holds
///         only the IPFS CID of the *ciphertext*, a hash of the ciphertext,
///         a category tag and the owner's address. Purposes are stored as
///         keccak256 hashes (e.g. keccak256("research")).
contract ConsentRegistry is Ownable {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Domain-neutral data category tag (objective 1).
    enum Category {
        Health,
        Finance,
        Education,
        Location,
        Other
    }

    /// @notice Life-cycle status of a consent. `None` means "does not exist".
    enum Status {
        None,
        Active,
        Revoked
    }

    struct DataRecord {
        address owner;
        Category category;
        uint32 pointerVersion; // increments on every key rotation / re-upload
        uint64 createdAt;
        bytes32 contentHash; // sha256 of the ciphertext stored in IPFS
        string cid; // IPFS CID of the ciphertext
    }

    struct Consent {
        uint256 dataId;
        address requester;
        bytes32 purpose; // keccak256("research")
        uint8 actions; // bitmask: 1 read, 2 share, 4 process
        uint64 expiresAt; // 0 = no expiry
        uint32 version; // 1 on grant, +1 on every modify
        Status status;
        uint64 updatedAt;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint8 public constant ACTION_READ = 1;
    uint8 public constant ACTION_SHARE = 2;
    uint8 public constant ACTION_PROCESS = 4;
    uint8 public constant ALL_ACTIONS = ACTION_READ | ACTION_SHARE | ACTION_PROCESS;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public dataCount; // ids start at 1
    uint256 public consentCount; // ids start at 1

    mapping(uint256 => DataRecord) private _data;
    mapping(uint256 => Consent) private _consents;

    mapping(address => uint256[]) private _dataByOwner;
    mapping(uint256 => uint256[]) private _consentsByData;
    mapping(address => uint256[]) private _consentsByRequester;

    /// @notice O(1) lookup used by isAccessAllowed:
    ///         dataId => requester => purpose => currently-active consentId (0 = none).
    mapping(uint256 => mapping(address => mapping(bytes32 => uint256))) public consentIndex;

    /// @notice Addresses of Access Gateways allowed to call logAccess.
    mapping(address => bool) public isGateway;

    // ---------------------------------------------------------------------
    // Events (the audit trail)
    // ---------------------------------------------------------------------

    event DataRegistered(
        uint256 indexed dataId, address indexed owner, Category category, string cid, bytes32 contentHash
    );
    event ConsentGranted(
        uint256 indexed consentId,
        uint256 indexed dataId,
        address indexed requester,
        bytes32 purpose,
        uint8 actions,
        uint64 expiresAt
    );
    event ConsentModified(
        uint256 indexed consentId,
        uint256 indexed dataId,
        address indexed requester,
        bytes32 purpose,
        uint8 actions,
        uint64 expiresAt,
        uint32 version
    );
    event ConsentRevoked(uint256 indexed consentId, uint256 indexed dataId, address indexed requester);
    event DataPointerUpdated(uint256 indexed dataId, string cid, bytes32 contentHash, uint32 pointerVersion);
    event AccessLogged(
        uint256 indexed dataId, address indexed requester, bytes32 indexed purpose, uint8 action, address gateway
    );
    event GatewaySet(address indexed gateway, bool allowed);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error DataNotFound(uint256 dataId);
    error ConsentNotFound(uint256 consentId);
    error NotDataOwner(uint256 dataId, address caller);
    error NotGateway(address caller);
    error InvalidRequester();
    error InvalidActions(uint8 actions);
    error InvalidExpiry(uint64 expiresAt);
    error InvalidPointer();
    error ConsentNotActive(uint256 consentId);
    error ConsentAlreadyExists(uint256 existingConsentId);
    error AccessNotAllowed();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyDataOwner(uint256 dataId) {
        address o = _data[dataId].owner;
        if (o == address(0)) revert DataNotFound(dataId);
        if (o != msg.sender) revert NotDataOwner(dataId, msg.sender);
        _;
    }

    modifier onlyGateway() {
        if (!isGateway[msg.sender]) revert NotGateway(msg.sender);
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Authorise (or de-authorise) an Access Gateway to write access logs.
    function setGateway(address gateway, bool allowed) external onlyOwner {
        if (gateway == address(0)) revert InvalidRequester();
        isGateway[gateway] = allowed;
        emit GatewaySet(gateway, allowed);
    }

    // ---------------------------------------------------------------------
    // Data records
    // ---------------------------------------------------------------------

    /// @notice Register a new encrypted data item that is already pinned to IPFS.
    /// @param cid         IPFS CID of the ciphertext
    /// @param contentHash sha256 of the ciphertext (integrity check)
    /// @param category    data category tag
    function registerData(string calldata cid, bytes32 contentHash, Category category)
        external
        returns (uint256 dataId)
    {
        if (bytes(cid).length == 0 || contentHash == bytes32(0)) revert InvalidPointer();
        dataId = ++dataCount;
        _data[dataId] = DataRecord({
            owner: msg.sender,
            category: category,
            pointerVersion: 1,
            createdAt: uint64(block.timestamp),
            contentHash: contentHash,
            cid: cid
        });
        _dataByOwner[msg.sender].push(dataId);
        emit DataRegistered(dataId, msg.sender, category, cid, contentHash);
    }

    /// @notice Point a data item at a new ciphertext. Used by "revoke and rotate":
    ///         the owner re-encrypts the file with a fresh key, uploads it and
    ///         updates the pointer, so any cached old key becomes useless.
    function updateDataPointer(uint256 dataId, string calldata newCid, bytes32 newContentHash)
        external
        onlyDataOwner(dataId)
    {
        if (bytes(newCid).length == 0 || newContentHash == bytes32(0)) revert InvalidPointer();
        DataRecord storage d = _data[dataId];
        d.cid = newCid;
        d.contentHash = newContentHash;
        d.pointerVersion += 1;
        emit DataPointerUpdated(dataId, newCid, newContentHash, d.pointerVersion);
    }

    // ---------------------------------------------------------------------
    // Consent life cycle
    // ---------------------------------------------------------------------

    /// @notice Grant a requester permission to use a data item for a purpose.
    function grantConsent(uint256 dataId, address requester, bytes32 purpose, uint8 actions, uint64 expiresAt)
        external
        onlyDataOwner(dataId)
        returns (uint256 consentId)
    {
        if (requester == address(0) || requester == msg.sender) revert InvalidRequester();
        _validateTerms(actions, expiresAt);

        uint256 existing = consentIndex[dataId][requester][purpose];
        if (existing != 0) revert ConsentAlreadyExists(existing);

        consentId = ++consentCount;
        _consents[consentId] = Consent({
            dataId: dataId,
            requester: requester,
            purpose: purpose,
            actions: actions,
            expiresAt: expiresAt,
            version: 1,
            status: Status.Active,
            updatedAt: uint64(block.timestamp)
        });
        consentIndex[dataId][requester][purpose] = consentId;
        _consentsByData[dataId].push(consentId);
        _consentsByRequester[requester].push(consentId);

        emit ConsentGranted(consentId, dataId, requester, purpose, actions, expiresAt);
    }

    /// @notice Change purpose, actions or expiry of an active consent in place.
    ///         The version number increments, and the old terms remain in the
    ///         event history.
    function modifyConsent(uint256 consentId, bytes32 purpose, uint8 actions, uint64 expiresAt) external {
        Consent storage c = _activeConsentOwnedByCaller(consentId);
        _validateTerms(actions, expiresAt);

        if (purpose != c.purpose) {
            uint256 existing = consentIndex[c.dataId][c.requester][purpose];
            if (existing != 0) revert ConsentAlreadyExists(existing);
            delete consentIndex[c.dataId][c.requester][c.purpose];
            consentIndex[c.dataId][c.requester][purpose] = consentId;
            c.purpose = purpose;
        }
        c.actions = actions;
        c.expiresAt = expiresAt;
        c.version += 1;
        c.updatedAt = uint64(block.timestamp);

        emit ConsentModified(consentId, c.dataId, c.requester, purpose, actions, expiresAt, c.version);
    }

    /// @notice Withdraw a consent. The Access Gateway listens for ConsentRevoked
    ///         and deletes the requester's wrapped key immediately; it also
    ///         re-checks isAccessAllowed on every request.
    function revokeConsent(uint256 consentId) external {
        Consent storage c = _activeConsentOwnedByCaller(consentId);
        c.status = Status.Revoked;
        c.updatedAt = uint64(block.timestamp);
        delete consentIndex[c.dataId][c.requester][c.purpose];
        emit ConsentRevoked(consentId, c.dataId, c.requester);
    }

    // ---------------------------------------------------------------------
    // Enforcement
    // ---------------------------------------------------------------------

    /// @notice The single question the Access Gateway asks before releasing data.
    ///         Constant-cost: one mapping lookup, independent of how many
    ///         consents a data item has.
    /// @return true if `requester` is the owner, or holds an active, unexpired
    ///         consent for `purpose` that covers every bit in `action`.
    function isAccessAllowed(uint256 dataId, address requester, bytes32 purpose, uint8 action)
        public
        view
        returns (bool)
    {
        address o = _data[dataId].owner;
        if (o == address(0) || action == 0) return false;
        if (requester == o) return true;

        uint256 id = consentIndex[dataId][requester][purpose];
        if (id == 0) return false;
        return _allows(_consents[id], action);
    }

    /// @notice Reference implementation that scans every consent of a data item.
    ///         Kept only to benchmark "loop vs mapping" (see scripts/benchmark.js);
    ///         the gateway always uses isAccessAllowed.
    function isAccessAllowedByScan(uint256 dataId, address requester, bytes32 purpose, uint8 action)
        external
        view
        returns (bool)
    {
        address o = _data[dataId].owner;
        if (o == address(0) || action == 0) return false;
        if (requester == o) return true;

        uint256[] storage ids = _consentsByData[dataId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            Consent storage c = _consents[ids[i]];
            if (c.requester == requester && c.purpose == purpose && _allows(c, action)) return true;
        }
        return false;
    }

    /// @notice Record that the gateway released data. Emits AccessLogged, giving
    ///         a provable record of every access made before a revocation.
    function logAccess(uint256 dataId, address requester, bytes32 purpose, uint8 action) external onlyGateway {
        if (!isAccessAllowed(dataId, requester, purpose, action)) revert AccessNotAllowed();
        emit AccessLogged(dataId, requester, purpose, action, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getData(uint256 dataId) external view returns (DataRecord memory) {
        if (_data[dataId].owner == address(0)) revert DataNotFound(dataId);
        return _data[dataId];
    }

    function getConsent(uint256 consentId) external view returns (Consent memory) {
        if (_consents[consentId].status == Status.None) revert ConsentNotFound(consentId);
        return _consents[consentId];
    }

    function getDataIdsByOwner(address owner_) external view returns (uint256[] memory) {
        return _dataByOwner[owner_];
    }

    function getConsentIdsByData(uint256 dataId) external view returns (uint256[] memory) {
        return _consentsByData[dataId];
    }

    function getConsentIdsByRequester(address requester) external view returns (uint256[] memory) {
        return _consentsByRequester[requester];
    }

    /// @notice True if the consent exists, is active and has not expired.
    function isConsentEffective(uint256 consentId) external view returns (bool) {
        Consent storage c = _consents[consentId];
        return c.status == Status.Active && (c.expiresAt == 0 || block.timestamp < c.expiresAt);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _allows(Consent storage c, uint8 action) private view returns (bool) {
        if (c.status != Status.Active) return false;
        if (c.expiresAt != 0 && block.timestamp >= c.expiresAt) return false;
        return (c.actions & action) == action;
    }

    function _validateTerms(uint8 actions, uint64 expiresAt) private view {
        if (actions == 0 || actions > ALL_ACTIONS) revert InvalidActions(actions);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);
    }

    function _activeConsentOwnedByCaller(uint256 consentId) private view returns (Consent storage c) {
        c = _consents[consentId];
        if (c.status == Status.None) revert ConsentNotFound(consentId);
        if (_data[c.dataId].owner != msg.sender) revert NotDataOwner(c.dataId, msg.sender);
        if (c.status != Status.Active) revert ConsentNotActive(consentId);
    }
}
